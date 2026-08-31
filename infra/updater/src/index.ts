import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import type { ServerUpdateRun } from "@rakazo/contracts";
import {
  type ComposeUpdateStep,
  chooseUpdateStrategy,
  composeUpArgv,
  composeUpdatePlan,
  composeVerifyCommitArgv,
  DEFAULT_UPDATE_REMOTE,
  forkImageTag,
  GITHUB_ACTIONS_OIDC_ISSUER,
  gitIndexContentDiffArgv,
  gitStatusArgv,
  gitUntrackedFilesArgv,
  gitWorktreeContentDiffArgv,
  hasValidBearerToken,
  IMAGE_COMMIT_ENV,
  IMAGE_REF_ENV,
  imageRef,
  isGitCommit,
  normalizeUpdateBranch,
  OFFICIAL_GITHUB_REPOSITORY,
  OFFICIAL_SERVER_IMAGE,
  PREVIOUS_IMAGE_COMMIT_ENV,
  PREVIOUS_IMAGE_REF_ENV,
  parseGitNameOnly,
  parseGitStatusPorcelain,
  parseLsRemoteReleases,
  parseServerReleaseManifest,
  repoIdentity,
  resolveTrackedDirtyPaths,
  rollbackTarget,
  SERVER_APP_ATTESTATION_BUNDLE_ASSET,
  SERVER_APP_OCI_MANIFEST_ASSET,
  SERVER_RELEASE_MANIFEST_ASSET,
  SERVER_RELEASE_MANIFEST_BUNDLE_ASSET,
  SERVER_RELEASE_WORKFLOW_SIGNER,
  selectLatestReleaseTag,
  serverReleaseWorkflowIdentity,
  upsertEnvAssignments,
  validateUpdateRequest,
} from "@rakazo/core";
import { type Context, Hono } from "hono";
import {
  readImageState,
  resolveUpdaterConfig,
  truncateOutput,
  UpdateRefused,
  type UpdaterConfig,
} from "./updater-logic.js";

export const GITHUB_FETCH_TIMEOUT_MS = 15_000;

const STEP_TIMEOUT_MS: Record<string, number> = {
  remote: 30_000,
  fetch: 180_000,
  checkout: 60_000,
  merge: 60_000,
  pull: 600_000,
  recreate: 1_800_000,
  recover: 1_800_000,
  verify: 30_000,
  "verify-attestation": 120_000,
};
const DEFAULT_TIMEOUT_MS = 120_000;

export interface CommandResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
}

export type UpdaterCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env?: Record<string, string> },
) => Promise<CommandResult>;

const PASSTHROUGH_ENV = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
] as const;

/** Child processes get connectivity and Docker settings, never the application's secret-filled env. */
export function commandEnvironment(
  source: NodeJS.ProcessEnv,
  overrides: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    ...overrides,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "true",
    CI: "1",
  };
}

/**
 * Every command is argv with `shell: false`. A repository URL or a branch reaches git as one
 * argument and reaches Compose not at all, so there is no string a caller can craft that becomes
 * part of a command line, a build argument, or a service definition.
 */
const runCommand: UpdaterCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env?: Record<string, string> },
): Promise<CommandResult> =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        shell: false,
        env: commandEnvironment(process.env, options.env),
      },
      (error, stdout, stderr) => {
        const output = truncateOutput(`${stdout}${stderr}`);
        if (!error) {
          resolve({ ok: true, exitCode: 0, output });
          return;
        }
        const exitCode = typeof error.code === "number" ? error.code : null;
        const timedOut = "killed" in error && Boolean(error.killed);
        const reason = timedOut
          ? `Timed out after ${options.timeoutMs}ms (${"signal" in error && error.signal ? String(error.signal) : "killed"}).`
          : error.message;
        resolve({ ok: false, exitCode, output: output ? `${output}\n${reason}` : reason });
      },
    );
  });

export function createUpdaterApp(
  config: UpdaterConfig,
  options: {
    run?: UpdaterCommandRunner;
    fetch?: typeof globalThis.fetch;
    githubFetchTimeoutMs?: number;
  } = {},
) {
  const app = new Hono();
  const run = options.run ?? runCommand;
  const fetchRelease = options.fetch ?? globalThis.fetch;
  const githubFetchTimeoutMs = options.githubFetchTimeoutMs ?? GITHUB_FETCH_TIMEOUT_MS;
  if (!Number.isInteger(githubFetchTimeoutMs) || githubFetchTimeoutMs <= 0) {
    throw new Error("The GitHub fetch timeout must be a positive whole number of milliseconds.");
  }
  const composeTarget = {
    composeFile: config.composeFile,
    envFiles: [config.envFile],
    projectName: config.projectName,
  };
  let running = false;
  let planInFlight: Promise<unknown> | null = null;

  app.get("/health", (c) => c.json({ ok: true, service: "updater", image: config.image }));

  app.use("*", async (c, next) => {
    if (c.req.path === "/health") {
      await next();
      return;
    }
    if (!hasValidBearerToken(c.req.header("authorization"), config.token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.get("/state", async (c) => {
    try {
      const images = readImageState(await readEnvFile(), config.image);
      const checkout = await readCheckout();
      return c.json({
        deployDir: config.deployDir,
        composeFile: config.composeFile,
        image: config.image,
        imageRef: images.currentRef,
        running,
        ...images,
        checkout,
      });
    } catch (error) {
      return refusal(c, error);
    }
  });

  app.post("/plan", async (c) => {
    try {
      if (planInFlight !== null) throw new UpdateRefused("A plan is already running.");
      const request = parseRequest(await body(c.req.raw));
      const work = (async () => {
        const images = readImageState(await readEnvFile(), config.image);
        const decision = chooseUpdateStrategy(request);
        const checkout = await readCheckout();
        if (decision.strategy === "build") {
          const targetCommit = await resolveRemoteHead(request);
          const targetRef = imageRef(config.image, forkImageTag(targetCommit));
          return {
            strategy: decision.strategy,
            reason: decision.reason,
            currentTag: images.currentTag,
            previousTag: images.previousTag,
            currentRef: images.currentRef,
            previousRef: images.previousRef,
            targetTag: null as string | null,
            targetRef,
            targetCommit,
            upToDate: upToDateForBuild(images.currentRef, checkout.commit, targetCommit),
            checkout,
          };
        }
        const target = await resolveRelease(request.repoUrl);
        return {
          strategy: decision.strategy,
          reason: `${decision.reason} Latest stable release: ${target.releaseTag}.`,
          currentTag: images.currentTag,
          previousTag: images.previousTag,
          currentRef: images.currentRef,
          previousRef: images.previousRef,
          targetTag: target.imageRef,
          targetRef: target.imageRef,
          targetCommit: target.commit,
          upToDate: target.imageRef === images.currentRef,
          checkout,
        };
      })();
      const tracked = work.finally(() => {
        planInFlight = null;
      });
      planInFlight = tracked;
      return c.json(await tracked);
    } catch (error) {
      return refusal(c, error);
    }
  });

  app.post("/apply", async (c) => {
    try {
      const request = parseRequest(await body(c.req.raw));
      return c.json(await withRunLock(() => apply(request)));
    } catch (error) {
      return refusal(c, error);
    }
  });

  app.post("/rollback", async (c) => {
    try {
      return c.json(await withRunLock(rollback));
    } catch (error) {
      return refusal(c, error);
    }
  });

  return app;

  async function body(request: Request): Promise<unknown> {
    try {
      return await request.json();
    } catch {
      return {};
    }
  }

  /** The sidecar is its own trust boundary: it re-validates rather than trusting the API's checks. */
  function parseRequest(input: unknown) {
    const source = (input ?? {}) as { repoUrl?: unknown; branch?: unknown };
    const result = validateUpdateRequest(source);
    if ("error" in result) throw new UpdateRefused(result.error);
    return result.request;
  }

  function refusal(c: Context, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, error instanceof UpdateRefused ? 400 : 500);
  }

  async function withRunLock<T>(work: () => Promise<T>): Promise<T> {
    if (running) throw new UpdateRefused("An update is already running.");
    running = true;
    try {
      return await work();
    } finally {
      running = false;
    }
  }

  async function readEnvFile() {
    try {
      return await readFile(config.envFile, "utf8");
    } catch (error) {
      throw new UpdateRefused(
        `Could not read the deployment environment file at ${config.envFile}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function writeEnvAssignments(assignments: Record<string, string>) {
    const [current, metadata] = await Promise.all([readEnvFile(), lstat(config.envFile)]);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new UpdateRefused("The deployment environment must be a regular, non-symlink file.");
    }
    const contents = upsertEnvAssignments(current, assignments);
    const temporary = `${config.envFile}.rakazo-update-${randomUUID()}`;
    let temporaryFile: Awaited<ReturnType<typeof open>> | null = null;
    try {
      temporaryFile = await open(temporary, "wx", 0o600);
      await temporaryFile.writeFile(contents, { encoding: "utf8" });
      const currentUid = process.getuid?.();
      const currentGid = process.getgid?.();
      if (metadata.uid !== currentUid || metadata.gid !== currentGid) {
        await temporaryFile.chown(metadata.uid, metadata.gid);
      }
      await temporaryFile.sync();
      await temporaryFile.close();
      temporaryFile = null;
      await rename(temporary, config.envFile);
    } catch (error) {
      await temporaryFile?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  function git(args: string[], stepId = "read") {
    return run("git", args, {
      cwd: config.deployDir,
      timeoutMs: STEP_TIMEOUT_MS[stepId] ?? DEFAULT_TIMEOUT_MS,
    });
  }

  async function hasCheckout() {
    try {
      await access(path.posix.join(config.deployDir, ".git"));
      return true;
    } catch {
      return false;
    }
  }

  async function readCheckout() {
    if (!(await hasCheckout())) {
      return {
        present: false,
        commit: null,
        branch: null,
        remoteUrl: null,
        dirty: false,
        dirtyPaths: [] as string[],
      };
    }
    const [head, branch, remote, status, untracked] = await Promise.all([
      git(["rev-parse", "HEAD"]),
      git(["rev-parse", "--abbrev-ref", "HEAD"]),
      git(["remote", "get-url", DEFAULT_UPDATE_REMOTE]),
      git(gitStatusArgv()),
      git(gitUntrackedFilesArgv()),
    ]);
    const porcelain = parseGitStatusPorcelain(status.ok ? status.output : "");
    let contentChanged: string[] = [];
    let contentDiffOk = true;
    if (status.ok && !porcelain.clean) {
      const [worktree, index] = await Promise.all([
        git(gitWorktreeContentDiffArgv()),
        git(gitIndexContentDiffArgv()),
      ]);
      contentDiffOk = worktree.ok && index.ok;
      contentChanged = [
        ...parseGitNameOnly(worktree.ok ? worktree.output : ""),
        ...parseGitNameOnly(index.ok ? index.output : ""),
      ];
    }
    const tracked = resolveTrackedDirtyPaths({
      porcelainChanged: porcelain.changed,
      contentChanged,
      contentDiffOk,
      untrackedPaths: parseGitNameOnly(untracked.ok ? untracked.output : ""),
    });
    const stateReadable = status.ok && untracked.ok;
    return {
      present: true,
      commit: head.ok ? head.output.trim() : null,
      branch: branch.ok ? branch.output.trim() : null,
      remoteUrl: remote.ok ? remote.output.trim() : null,
      dirty: stateReadable ? tracked.dirty : true,
      dirtyPaths: stateReadable
        ? tracked.dirtyPaths
        : ["(the updater could not verify the checkout state)"],
    };
  }

  /**
   * Published GitHub Releases select the version. The attached Sigstore bundle authenticates the
   * manifest, then the manifest's exact app digest gets its own OCI provenance verification.
   */
  async function resolveRelease(repoUrl: string) {
    const releaseResponse = await requestGitHub(
      "https://api.github.com/repos/ChainAI-Org/brandwell-aimee/releases/latest",
      "latest published release",
    );
    const releaseTag =
      typeof releaseResponse === "object" &&
      releaseResponse !== null &&
      "tag_name" in releaseResponse &&
      typeof releaseResponse.tag_name === "string"
        ? selectLatestReleaseTag([releaseResponse.tag_name])
        : null;
    const published =
      typeof releaseResponse === "object" &&
      releaseResponse !== null &&
      "draft" in releaseResponse &&
      releaseResponse.draft === false &&
      "prerelease" in releaseResponse &&
      releaseResponse.prerelease === false;
    if (!published || releaseTag === null) {
      throw new UpdateRefused("The official repository has no trusted stable release.");
    }

    const listed = await run(
      "git",
      [
        "ls-remote",
        "--tags",
        "--",
        repoUrl,
        `refs/tags/${releaseTag}`,
        `refs/tags/${releaseTag}^{}`,
      ],
      {
        cwd: config.deployDir,
        timeoutMs: STEP_TIMEOUT_MS.fetch ?? DEFAULT_TIMEOUT_MS,
      },
    );
    if (!listed.ok) {
      throw new UpdateRefused(`Could not read releases from ${repoUrl}: ${listed.output}`);
    }
    const release = parseLsRemoteReleases(listed.output).find(({ tag }) => tag === releaseTag);
    if (release === undefined) {
      throw new UpdateRefused(
        `${repoUrl} does not have the tag named by its latest published release.`,
      );
    }
    const ancestry = await requestGitHub(
      `https://api.github.com/repos/ChainAI-Org/brandwell-aimee/compare/${release.commit}...main`,
      "release ancestry",
    );
    const status =
      typeof ancestry === "object" && ancestry !== null && "status" in ancestry
        ? ancestry.status
        : null;
    if (status !== "ahead" && status !== "identical") {
      throw new UpdateRefused("The latest published release is not on the protected main branch.");
    }

    if (config.image !== OFFICIAL_SERVER_IMAGE) {
      throw new UpdateRefused(
        `Official releases are attested only for ${OFFICIAL_SERVER_IMAGE}; use the official image repository or update a fork by building it.`,
      );
    }
    const manifestUrl = releaseAssetUrl(releaseResponse, releaseTag, SERVER_RELEASE_MANIFEST_ASSET);
    const bundleUrl = releaseAssetUrl(
      releaseResponse,
      releaseTag,
      SERVER_RELEASE_MANIFEST_BUNDLE_ASSET,
    );
    const appOciManifestUrl = releaseAssetUrl(
      releaseResponse,
      releaseTag,
      SERVER_APP_OCI_MANIFEST_ASSET,
    );
    const appBundleUrl = releaseAssetUrl(
      releaseResponse,
      releaseTag,
      SERVER_APP_ATTESTATION_BUNDLE_ASSET,
    );
    const [manifestContents, bundleContents, appOciManifest, appBundle] = await Promise.all([
      requestGitHubText(manifestUrl, "signed server release manifest", 64 * 1024),
      requestGitHubText(bundleUrl, "server release manifest signature", 2 * 1024 * 1024),
      requestGitHubText(appOciManifestUrl, "app OCI manifest", 2 * 1024 * 1024),
      requestGitHubText(appBundleUrl, "app image provenance bundle", 2 * 1024 * 1024),
    ]);
    const temporary = await mkdtemp(path.join(os.tmpdir(), "aimee-server-release-"));
    const manifestPath = path.join(temporary, SERVER_RELEASE_MANIFEST_ASSET);
    const bundlePath = path.join(temporary, SERVER_RELEASE_MANIFEST_BUNDLE_ASSET);
    const appOciManifestPath = path.join(temporary, SERVER_APP_OCI_MANIFEST_ASSET);
    const appBundlePath = path.join(temporary, SERVER_APP_ATTESTATION_BUNDLE_ASSET);
    try {
      await Promise.all([
        writeFile(manifestPath, manifestContents, { encoding: "utf8", mode: 0o600 }),
        writeFile(bundlePath, bundleContents, { encoding: "utf8", mode: 0o600 }),
        writeFile(appOciManifestPath, appOciManifest, { encoding: "utf8", mode: 0o600 }),
        writeFile(appBundlePath, appBundle, { encoding: "utf8", mode: 0o600 }),
      ]);
      const policy = attestationPolicyArgs(releaseTag, release.commit);
      const manifestVerification = await run(
        "gh",
        ["attestation", "verify", manifestPath, "--bundle", bundlePath, ...policy],
        {
          cwd: config.deployDir,
          timeoutMs: STEP_TIMEOUT_MS["verify-attestation"] ?? DEFAULT_TIMEOUT_MS,
        },
      );
      if (!manifestVerification.ok) {
        throw new UpdateRefused(
          `The server release manifest signature could not be verified: ${manifestVerification.output}`,
        );
      }

      let manifestJson: unknown;
      try {
        manifestJson = JSON.parse(manifestContents);
      } catch {
        throw new UpdateRefused("The signed server release manifest is not valid JSON.");
      }
      const parsed = parseServerReleaseManifest(manifestJson);
      if ("error" in parsed) throw new UpdateRefused(parsed.error);
      const manifest = parsed.manifest;
      if (manifest.releaseTag !== releaseTag || manifest.sourceCommit !== release.commit) {
        throw new UpdateRefused(
          "The signed server release manifest does not match the published release tag and commit.",
        );
      }
      const downloadedDigest = `sha256:${createHash("sha256").update(appOciManifest).digest("hex")}`;
      if (downloadedDigest !== manifest.images.app.digest) {
        throw new UpdateRefused(
          "The signed manifest digest does not match the attached app OCI manifest.",
        );
      }

      const imageVerification = await run(
        "gh",
        ["attestation", "verify", appOciManifestPath, "--bundle", appBundlePath, ...policy],
        {
          cwd: config.deployDir,
          timeoutMs: STEP_TIMEOUT_MS["verify-attestation"] ?? DEFAULT_TIMEOUT_MS,
        },
      );
      if (!imageVerification.ok) {
        throw new UpdateRefused(
          `The app image provenance could not be verified: ${imageVerification.output}`,
        );
      }
      return {
        releaseTag: manifest.releaseTag,
        commit: manifest.sourceCommit,
        imageRef: manifest.images.app.reference,
      };
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function requestGitHub(url: string, label: string): Promise<unknown> {
    const response = await requestGitHubResponse(url, label, "application/vnd.github+json");
    try {
      return await response.json();
    } catch {
      throw new UpdateRefused(`GitHub returned an invalid ${label}.`);
    }
  }

  async function requestGitHubText(url: string, label: string, maxBytes: number): Promise<string> {
    const response = await requestGitHubResponse(url, label, "application/octet-stream");
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new UpdateRefused(`The ${label} is larger than the updater accepts.`);
    }
    let contents: string;
    try {
      contents = await response.text();
    } catch {
      throw new UpdateRefused(`Could not read the ${label} from GitHub.`);
    }
    if (Buffer.byteLength(contents, "utf8") > maxBytes) {
      throw new UpdateRefused(`The ${label} is larger than the updater accepts.`);
    }
    return contents;
  }

  async function requestGitHubResponse(url: string, label: string, accept: string) {
    try {
      const response = await fetchRelease(url, {
        headers: {
          Accept: accept,
          "User-Agent": "brandwell-aimee-updater",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(githubFetchTimeoutMs),
      });
      if (!response.ok) throw new Error(`GitHub returned ${response.status}.`);
      return response;
    } catch {
      throw new UpdateRefused(`Could not read the ${label} from GitHub.`);
    }
  }

  function releaseAssetUrl(release: unknown, releaseTag: string, assetName: string): string {
    const source = release as { assets?: unknown };
    const assets = Array.isArray(source.assets) ? source.assets : [];
    const found = assets.find(
      (asset): asset is { name: string; browser_download_url: string } =>
        typeof asset === "object" &&
        asset !== null &&
        "name" in asset &&
        asset.name === assetName &&
        "browser_download_url" in asset &&
        typeof asset.browser_download_url === "string",
    );
    if (found === undefined) {
      throw new UpdateRefused(`The published release is missing ${assetName}.`);
    }
    let parsed: URL;
    try {
      parsed = new URL(found.browser_download_url);
    } catch {
      throw new UpdateRefused(`The published release has an invalid ${assetName} URL.`);
    }
    const expectedPrefix = `/ChainAI-Org/brandwell-aimee/releases/download/${releaseTag}/`;
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "github.com" ||
      !parsed.pathname.startsWith(expectedPrefix) ||
      parsed.pathname.slice(expectedPrefix.length) !== assetName
    ) {
      throw new UpdateRefused(`The published release has an untrusted ${assetName} URL.`);
    }
    return parsed.href;
  }

  function attestationPolicyArgs(releaseTag: string, sourceCommit: string): string[] {
    return [
      "--repo",
      OFFICIAL_GITHUB_REPOSITORY,
      "--signer-workflow",
      SERVER_RELEASE_WORKFLOW_SIGNER,
      "--cert-identity",
      serverReleaseWorkflowIdentity(releaseTag),
      "--cert-oidc-issuer",
      GITHUB_ACTIONS_OIDC_ISSUER,
      "--source-digest",
      sourceCommit,
      "--source-ref",
      `refs/tags/${releaseTag}`,
      "--deny-self-hosted-runners",
    ];
  }

  /** The branch head on the remote, read without fetching, so a plan does not mutate the checkout. */
  async function resolveRemoteHead(request: { repoUrl: string; branch: string }) {
    const listed = await run(
      "git",
      ["ls-remote", "--heads", "--", request.repoUrl, request.branch],
      { cwd: config.deployDir, timeoutMs: STEP_TIMEOUT_MS.fetch ?? DEFAULT_TIMEOUT_MS },
    );
    if (!listed.ok) {
      throw new UpdateRefused(`Could not read ${request.branch} from ${request.repoUrl}.`);
    }
    const commit = listed.output.trim().split(/\s/)[0] ?? "";
    if (!isGitCommit(commit)) {
      throw new UpdateRefused(`${request.repoUrl} has no branch called ${request.branch}.`);
    }
    return commit;
  }

  /** A fork is current only when its checkout is on the remote head *and* that build is deployed. */
  function upToDateForBuild(
    currentRef: string,
    commit: string | null,
    targetCommit: string | null,
  ) {
    if (commit === null || targetCommit === null || commit !== targetCommit) return false;
    return currentRef === imageRef(config.image, forkImageTag(commit));
  }

  async function apply(request: { repoUrl: string; branch: string; official: boolean }) {
    const decision = chooseUpdateStrategy(request);
    const images = readImageState(await readEnvFile(), config.image);
    const checkout = await readCheckout();

    if (decision.strategy === "build") {
      if (!checkout.present) {
        throw new UpdateRefused(
          "Building a fork needs the deployment's git checkout, and RAKAZO_DEPLOY_DIR has no .git directory. Clone the fork to the deployment directory, or switch back to the official repository to use published images.",
        );
      }
      if (checkout.remoteUrl === null) {
        throw new UpdateRefused(
          `Building a fork needs the deployment checkout to have an ${DEFAULT_UPDATE_REMOTE} remote. Add it or clone the fork again before updating.`,
        );
      }
      if (checkout.dirty) {
        throw new UpdateRefused(
          "The deployment checkout has changed or untracked source files, or its state could not be verified. Commit, stash, clean, or fix it before updating.",
        );
      }
    }

    let targetRef: string | null = null;
    let targetCommit: string | null = null;
    let releaseTag: string | null = null;
    if (decision.strategy === "pull") {
      const target = await resolveRelease(request.repoUrl);
      targetRef = target.imageRef;
      targetCommit = target.commit;
      releaseTag = target.releaseTag;
      if (targetRef === images.currentRef) {
        return upToDateRecord(request, targetRef, "pull", targetCommit);
      }
    } else {
      const remoteHead = await resolveRemoteHead(request);
      if (upToDateForBuild(images.currentRef, checkout.commit, remoteHead)) {
        return upToDateRecord(request, images.currentRef, "build", checkout.commit);
      }
    }

    const steps =
      decision.strategy === "pull"
        ? composeUpdatePlan({ strategy: "pull", target: composeTarget })
        : composeUpdatePlan({
            strategy: "build",
            target: composeTarget,
            repoUrl: request.repoUrl,
            branch: request.branch,
            repointRemote:
              checkout.remoteUrl === null ||
              repoIdentity(checkout.remoteUrl) !== repoIdentity(request.repoUrl),
          });

    return execute({
      request,
      strategy: decision.strategy,
      fromRef: images.currentRef,
      originalPreviousRef: images.previousRef,
      toRef: targetRef,
      fromCommit: images.currentCommit ?? checkout.commit,
      originalPreviousCommit: images.previousCommit,
      fromBranch: checkout.branch,
      toCommit: targetCommit,
      restoreRemoteUrl:
        decision.strategy === "build" &&
        checkout.remoteUrl !== null &&
        repoIdentity(checkout.remoteUrl) !== repoIdentity(request.repoUrl)
          ? checkout.remoteUrl
          : null,
      steps,
      restartAdvice:
        decision.strategy === "pull"
          ? `The updater deployed ${releaseTag ?? targetRef} by verified digest, recreated the API, worker, and web containers, and confirmed the API source commit. Migrations ran inside the new API container before it became healthy.`
          : "The updater built the fork and recreated the API, worker, and web containers. Migrations ran inside the new API container before it started serving.",
    });
  }

  async function rollback(): Promise<ServerUpdateRun> {
    const images = readImageState(await readEnvFile(), config.image);
    const decision = rollbackTarget(images);
    if ("error" in decision) throw new UpdateRefused(decision.error);
    const checkout = await readCheckout();
    // Never re-pull a rollback digest. Reuse the exact image cached when it previously ran.
    const steps = composeUpdatePlan({ strategy: "pull", target: composeTarget }).filter(
      (step) => step.id !== "pull",
    );
    return execute({
      request: { repoUrl: "", branch: "" },
      strategy: "pull",
      fromRef: images.currentRef,
      originalPreviousRef: images.previousRef,
      toRef: decision.ref,
      fromCommit: images.currentCommit ?? checkout.commit,
      originalPreviousCommit: images.previousCommit,
      fromBranch: checkout.branch,
      toCommit: images.previousCommit,
      restoreRemoteUrl: null,
      steps,
      restartAdvice: `Rolled back to ${decision.ref} without pulling from the registry. Database migrations are not reversed: if the newer version added a migration, roll forward again or restore a database backup.`,
    });
  }

  /**
   * Pins the exact ref, runs the plan, and restores the old pin if the run fails. A failed update
   * never leaves the deployment's `.env` pointing at an image the host did not finish starting.
   */
  async function execute(input: {
    request: { repoUrl: string; branch: string };
    strategy: "pull" | "build";
    fromRef: string;
    originalPreviousRef: string | null;
    toRef: string | null;
    fromCommit: string | null;
    originalPreviousCommit: string | null;
    fromBranch: string | null;
    toCommit: string | null;
    restoreRemoteUrl: string | null;
    steps: ComposeUpdateStep[];
    restartAdvice: string;
  }): Promise<ServerUpdateRun> {
    const record: ServerUpdateRun = {
      startedAt: new Date().toISOString(),
      finishedAt: null,
      ok: false,
      fromCommit: input.fromCommit,
      toCommit: input.toCommit,
      fromTag: input.fromRef,
      toTag: input.toRef,
      strategy: input.strategy,
      repoUrl: input.request.repoUrl,
      branch: input.request.branch,
      restart: "not-required",
      restartAdvice: input.restartAdvice,
      error: null,
      steps: [],
    };
    const revertAssignments = {
      [IMAGE_REF_ENV]: input.fromRef,
      [PREVIOUS_IMAGE_REF_ENV]: input.originalPreviousRef ?? "",
      [IMAGE_COMMIT_ENV]: input.fromCommit ?? "",
      [PREVIOUS_IMAGE_COMMIT_ENV]: input.originalPreviousCommit ?? "",
    };
    // Build updates may switch branches and/or fast-forward before recreate. Mark the checkout
    // touched as soon as either mutates so a mid-plan failure still restores branch + commit.
    let checkoutTouched = false;
    try {
      const gitSteps = input.steps.filter((step) => step.command === "git");
      const composeSteps = input.steps.filter((step) => step.command !== "git");

      for (const step of gitSteps) {
        if (!(await runStep(record, step))) return record;
        if (step.id === "checkout" || step.id === "merge") checkoutTouched = true;
      }

      // The build path only knows its local ref after the fast-forward, because its tag is the commit.
      let toRef = input.toRef;
      if (input.strategy === "build") {
        const head = await git(["rev-parse", "HEAD"]);
        const commit = head.ok ? head.output.trim() : "";
        if (!isGitCommit(commit)) {
          record.error = "Could not read the commit to build.";
          return record;
        }
        record.toCommit = commit;
        toRef = imageRef(config.image, forkImageTag(commit));
        record.toTag = toRef;
      }
      if (toRef === null) {
        record.error = "Could not resolve a target image reference.";
        return record;
      }

      try {
        await writeEnvAssignments({
          [IMAGE_REF_ENV]: toRef,
          [PREVIOUS_IMAGE_REF_ENV]: input.fromRef,
          [IMAGE_COMMIT_ENV]: record.toCommit ?? "",
          [PREVIOUS_IMAGE_COMMIT_ENV]: input.fromCommit ?? "",
        });
      } catch {
        record.error =
          "Could not persist the target image reference in the deployment environment.";
        record.restartAdvice = `${record.error} Nothing was recreated.`;
        return record;
      }
      const composeEnv: Record<string, string> = { [IMAGE_REF_ENV]: toRef };
      if (record.toCommit !== null) composeEnv.GIT_SHA = record.toCommit;
      if (record.toCommit !== null) {
        const verify = composeVerifyCommitArgv(composeTarget, record.toCommit);
        const recreateIndex = composeSteps.findIndex((step) => step.id === "recreate");
        composeSteps.splice(recreateIndex + 1, 0, {
          id: "verify",
          label: `Verify the API is running source commit ${record.toCommit}`,
          command: verify.command,
          args: verify.args,
        });
      }

      for (const step of composeSteps) {
        if (!(await runStep(record, step, composeEnv))) {
          const primaryError = record.error ?? `${step.label} failed.`;
          const envRestored = await writeEnvAssignments(revertAssignments).then(
            () => true,
            () => false,
          );
          if (step.id === "recreate" || step.id === "verify") {
            const previous = composeUpArgv(composeTarget);
            let recovered = await runStep(
              record,
              {
                id: "recover",
                label: `Restore the previously running ${input.fromRef} image`,
                command: previous.command,
                args: previous.args,
              },
              {
                [IMAGE_REF_ENV]: input.fromRef,
                ...(input.fromCommit === null ? {} : { GIT_SHA: input.fromCommit }),
              },
              false,
            );
            if (recovered && input.fromCommit !== null) {
              const verification = composeVerifyCommitArgv(composeTarget, input.fromCommit);
              recovered = await runStep(
                record,
                {
                  id: "recover-verify",
                  label: `Verify the restored API is running source commit ${input.fromCommit}`,
                  command: verification.command,
                  args: verification.args,
                },
                { [IMAGE_REF_ENV]: input.fromRef, GIT_SHA: input.fromCommit },
                false,
              );
            }
            record.restart = recovered ? "not-required" : "manual";
            record.restartAdvice = recovered
              ? `${primaryError} The updater restored the previously running ${input.fromRef} image${envRestored ? " and its environment pin" : ", but could not restore the environment pin"}. Read the failed step output before retrying.`
              : `${primaryError} Automatic recovery to ${input.fromRef} also failed${envRestored ? "" : ", and the environment pin could not be restored"}. The runtime may contain a mix of versions; use the recorded commands to recover it manually.`;
          } else {
            record.restartAdvice = `${primaryError} No service was recreated${envRestored ? ", and the prior environment pin was restored" : ", but the prior environment pin could not be restored"}. Read the failed step output before retrying.`;
          }
          record.error = primaryError;
          return record;
        }
      }
      record.ok = true;
      record.restart = "recreated";
      return record;
    } finally {
      if (
        !record.ok &&
        checkoutTouched &&
        input.fromCommit !== null &&
        isGitCommit(input.fromCommit)
      ) {
        const restored = await runStep(
          record,
          {
            id: "restore-checkout",
            label: "Restore the previous checkout",
            command: "git",
            args: restoreCheckoutArgv(input.fromBranch, input.fromCommit),
          },
          undefined,
          false,
        );
        if (!restored) {
          record.restartAdvice = `${record.restartAdvice} The previous checkout also could not be restored; fix it before retrying.`;
        }
      }
      if (!record.ok && input.restoreRemoteUrl !== null) {
        const restored = await runStep(
          record,
          {
            id: "restore-remote",
            label: `Restore the previous ${DEFAULT_UPDATE_REMOTE} remote`,
            command: "git",
            args: ["remote", "set-url", DEFAULT_UPDATE_REMOTE, input.restoreRemoteUrl],
          },
          undefined,
          false,
        );
        if (!restored) {
          record.restartAdvice = `${record.restartAdvice} The previous Git remote also could not be restored; fix it before retrying.`;
        }
      }
      record.finishedAt = new Date().toISOString();
    }
  }

  async function runStep(
    record: ServerUpdateRun,
    step: ComposeUpdateStep,
    env?: Record<string, string>,
    setError = true,
  ) {
    const result = await run(step.command, step.args, {
      cwd: config.deployDir,
      timeoutMs: STEP_TIMEOUT_MS[step.id] ?? DEFAULT_TIMEOUT_MS,
      env: step.command === "docker" ? { COMPOSE_PROJECT_NAME: config.projectName, ...env } : env,
    });
    record.steps.push({
      id: step.id,
      label: step.label,
      ok: result.ok,
      exitCode: result.exitCode,
      output: result.output,
    });
    if (!result.ok && setError) record.error = `${step.label} failed.`;
    return result.ok;
  }

  function upToDateRecord(
    request: { repoUrl: string; branch: string },
    tag: string,
    strategy: "pull" | "build",
    commit: string | null,
  ): ServerUpdateRun {
    const now = new Date().toISOString();
    return {
      startedAt: now,
      finishedAt: now,
      ok: true,
      fromCommit: commit,
      toCommit: commit,
      fromTag: tag,
      toTag: tag,
      strategy,
      repoUrl: request.repoUrl,
      branch: request.branch,
      restart: "not-required",
      restartAdvice: `Already running ${tag}; nothing was changed.`,
      error: null,
      steps: [],
    };
  }
}

function startUpdater() {
  const config = resolveUpdaterConfig(process.env);
  const app = createUpdaterApp(config);
  return serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
    console.log(`rakazo updater on http://${config.host}:${config.port} for ${config.deployDir}`);
  });
}

/**
 * Put the worktree back on the pre-update branch and commit. `checkout -B` restores a named
 * branch; detached checkouts must use `--detach` so recovery cannot attach to the update target
 * branch and move that tip to the old commit.
 */
export function restoreCheckoutArgv(fromBranch: string | null, fromCommit: string): string[] {
  if (!isGitCommit(fromCommit)) throw new Error("Checkout restore needs a resolved commit.");
  if (fromBranch !== null && fromBranch !== "HEAD") {
    const branch = normalizeUpdateBranch(fromBranch);
    if (!("error" in branch)) return ["checkout", "-B", branch.branch, fromCommit];
  }
  return ["checkout", "--detach", fromCommit];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startUpdater();
}
