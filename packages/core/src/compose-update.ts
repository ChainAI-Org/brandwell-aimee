import {
  DEFAULT_UPDATE_REMOTE,
  isGitCommit,
  isOfficialRepoUrl,
  normalizeRepoUrl,
  normalizeUpdateBranch,
} from "./self-update.js";

/**
 * The GitHub repository whose CI fills the image namespace. `publish-server-image.yml` pushes to
 * this explicit package path and refuses to publish from any other repository. Naming a different
 * owner here points the deployment at packages nobody publishes.
 *
 * `OFFICIAL_REPO_URL` names the same repository, so the source commit selected from a release is
 * guaranteed to have been eligible for this repository's publishing workflow.
 */
export const PUBLISHED_IMAGE_REPO = "chainai-org/brandwell-aimee";
export const OFFICIAL_GITHUB_REPOSITORY = "ChainAI-Org/brandwell-aimee";

/** The published server image. One image runs api, worker, and web. */
export const OFFICIAL_SERVER_IMAGE = `ghcr.io/${PUBLISHED_IMAGE_REPO}/app`;
/** The updater sidecar's image, published alongside the server image but tagged independently. */
export const OFFICIAL_UPDATER_IMAGE = `ghcr.io/${PUBLISHED_IMAGE_REPO}/updater`;

export const SERVER_RELEASE_MANIFEST_SCHEMA_VERSION = 1;
export const SERVER_RELEASE_MANIFEST_ASSET = "server-release-manifest.json";
export const SERVER_RELEASE_MANIFEST_BUNDLE_ASSET = "server-release-manifest.sigstore.jsonl";
export const SERVER_APP_OCI_MANIFEST_ASSET = "server-image-app.oci-manifest.json";
export const SERVER_APP_ATTESTATION_BUNDLE_ASSET = "server-image-app.sigstore.jsonl";
export const SERVER_RELEASE_WORKFLOW_PATH = ".github/workflows/publish-server-image.yml";
export const SERVER_RELEASE_WORKFLOW_SIGNER = `github.com/${OFFICIAL_GITHUB_REPOSITORY}/${SERVER_RELEASE_WORKFLOW_PATH}`;
export const GITHUB_ACTIONS_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const SERVER_IMAGE_PLATFORMS = ["linux/amd64", "linux/arm64"] as const;

/**
 * The tag a deployment that has never run an update is on. It is deliberately *not* `latest`: no
 * registry serves this tag, so `docker compose up --build` builds it from the checkout and a fresh
 * install works with an empty registry. `latest` only exists once a release has been published.
 */
export const LOCAL_IMAGE_TAG = "local";
export const DEFAULT_IMAGE_TAG = LOCAL_IMAGE_TAG;
export const IMAGE_TAG_ENV = "RAKAZO_IMAGE_TAG";
export const PREVIOUS_IMAGE_TAG_ENV = "RAKAZO_IMAGE_TAG_PREVIOUS";
/** Full tag or digest references. These take precedence over the legacy split name/tag settings. */
export const IMAGE_REF_ENV = "RAKAZO_IMAGE_REF";
export const PREVIOUS_IMAGE_REF_ENV = "RAKAZO_IMAGE_REF_PREVIOUS";
/** Source commits paired with the refs let post-recreate health checks cover rollback too. */
export const IMAGE_COMMIT_ENV = "RAKAZO_IMAGE_COMMIT";
export const PREVIOUS_IMAGE_COMMIT_ENV = "RAKAZO_IMAGE_COMMIT_PREVIOUS";

/**
 * Matches the `name:` pinned in `infra/compose/docker-compose.prod.yml`. Used when Compose has not
 * injected `COMPOSE_PROJECT_NAME` (it does, into running services) and no dedicated override is set.
 */
export const DEFAULT_COMPOSE_PROJECT_NAME = "rakazo-prod";
export const COMPOSE_PROJECT_NAME_ENV = "COMPOSE_PROJECT_NAME";
export const COMPOSE_PROJECT_NAME_OVERRIDE_ENV = "RAKAZO_COMPOSE_PROJECT_NAME";

/**
 * The services a recreate replaces. `updater` is deliberately absent: it is the process running
 * the update, and recreating it would kill the run half way through. `postgres` and `caddy` are
 * absent because neither uses the AIMEE image.
 */
export const RECREATED_SERVICES = ["api", "worker", "web"] as const;

const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const IMAGE_NAME_SEGMENT = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const IMAGE_HOST = /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?$/;
const COMMIT = /^[0-9a-f]{40,64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;
const ENV_VALUE = /^[A-Za-z0-9._:/@+-]{0,320}$/;
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
/** Compose project names must not start with `-`, or `-p` would treat them as a second flag. */
const COMPOSE_PROJECT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function isValidImageTag(tag: string): boolean {
  return IMAGE_TAG.test(tag);
}

/** A registry reference the updater is willing to hand to `docker compose` as one env value. */
export function isValidImageName(name: string): boolean {
  if (name.length === 0 || name.length > 200) return false;
  const segments = name.split("/");
  const first = segments[0] ?? "";
  const hasHost = segments.length > 1 && (first.includes(".") || first.includes(":"));
  if (hasHost && !IMAGE_HOST.test(first)) return false;
  return segments.slice(hasHost ? 1 : 0).every((segment) => IMAGE_NAME_SEGMENT.test(segment));
}

export function isValidImageDigest(digest: string): boolean {
  return IMAGE_DIGEST.test(digest);
}

/** A complete image reference. Digest references are the only form used for official updates. */
export function isValidImageRef(ref: string): boolean {
  const digestSeparator = ref.lastIndexOf("@");
  if (digestSeparator >= 0) {
    if (digestSeparator !== ref.indexOf("@")) return false;
    return (
      isValidImageName(ref.slice(0, digestSeparator)) &&
      isValidImageDigest(ref.slice(digestSeparator + 1))
    );
  }
  const tagSeparator = ref.lastIndexOf(":");
  if (tagSeparator <= ref.lastIndexOf("/")) return false;
  return (
    isValidImageName(ref.slice(0, tagSeparator)) && isValidImageTag(ref.slice(tagSeparator + 1))
  );
}

export function isValidComposeProjectName(name: string): boolean {
  return COMPOSE_PROJECT_NAME.test(name);
}

/**
 * The project `-p` must name. Compose injects `COMPOSE_PROJECT_NAME` into running services, which
 * is the stack the operator actually started (including `docker compose -p something-else`). A
 * dedicated override exists for running the sidecar outside Compose. Unset falls back to the name
 * pinned in the compose file, never to guessing from the working directory.
 */
export function resolveComposeProjectName(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const injected = env[COMPOSE_PROJECT_NAME_ENV]?.trim() ?? "";
  const override = env[COMPOSE_PROJECT_NAME_OVERRIDE_ENV]?.trim() ?? "";
  const candidate = injected || override;
  if (candidate === "") return DEFAULT_COMPOSE_PROJECT_NAME;
  if (!isValidComposeProjectName(candidate)) {
    throw new Error(`Refusing an unusable Compose project name: ${candidate}`);
  }
  return candidate;
}

export function imageRef(name: string, tag: string): string {
  if (!isValidImageName(name)) throw new Error(`Refusing an unusable image name: ${name}`);
  if (!isValidImageTag(tag)) throw new Error(`Refusing an unusable image tag: ${tag}`);
  return `${name}:${tag}`;
}

export function digestImageRef(name: string, digest: string): string {
  if (!isValidImageName(name)) throw new Error(`Refusing an unusable image name: ${name}`);
  if (!isValidImageDigest(digest)) throw new Error(`Refusing an unusable image digest: ${digest}`);
  return `${name}@${digest}`;
}

export function serverReleaseWorkflowIdentity(tag: string): string {
  const release = parseReleaseTag(tag);
  if (release === null || release.prerelease !== null) {
    throw new Error("A server release workflow identity needs a stable release tag.");
  }
  return `https://${SERVER_RELEASE_WORKFLOW_SIGNER}@refs/tags/${tag}`;
}

/**
 * The tag a fork's build is stored under. Forks have no published images, so the tag has to be
 * local and distinguishable from anything the registry could serve, or a later `pull` of the same
 * name would silently replace the operator's own build.
 */
export function forkImageTag(commit: string): string {
  if (!COMMIT.test(commit)) throw new Error("A fork build needs a resolved commit to tag.");
  return `local-${commit}`;
}

/**
 * A tag that only exists on this host, so trying to pull it would fail rather than find nothing.
 * Covers both the per-commit fork builds (`local-<commit>`) and the bare `local` a fresh install
 * builds, because a rollback onto either has to skip `docker compose pull`.
 */
export function isLocalImageTag(tag: string): boolean {
  return tag === LOCAL_IMAGE_TAG || tag.startsWith(`${LOCAL_IMAGE_TAG}-`);
}

/**
 * The source-addressed per-commit tag the publish workflow pushes. This has to agree character for
 * character with `docker/metadata-action`'s `type=sha`. The workflow deliberately raises
 * `DOCKER_METADATA_SHORT_SHA_LENGTH` to 40 so source-addressed image tags cannot collide at the
 * action's unsafe seven-character default.
 */
export function commitImageTag(commit: string): string {
  if (!COMMIT.test(commit)) throw new Error("A commit tag needs a resolved commit.");
  return `sha-${commit}`;
}

export interface ReleaseTag {
  tag: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

export function parseReleaseTag(tag: string): ReleaseTag | null {
  const match = RELEASE_TAG.exec(tag);
  if (!match) return null;
  return {
    tag,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

export function compareReleaseTags(a: ReleaseTag, b: ReleaseTag): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

/** Reads `git ls-remote --tags <url>`, which is the tag list without cloning anything. */
export function parseLsRemoteTags(stdout: string): string[] {
  const tags = new Set<string>();
  for (const line of stdout.split("\n")) {
    const ref = line.split("\t")[1]?.trim();
    if (!ref?.startsWith("refs/tags/")) continue;
    const tag = ref.slice("refs/tags/".length).replace(/\^\{\}$/, "");
    if (tag !== "" && isValidImageTag(tag)) tags.add(tag);
  }
  return [...tags];
}

export interface RemoteRelease {
  tag: string;
  /** The commit behind the tag, never the object id of an annotated tag. */
  commit: string;
}

/**
 * Reads the source commit for each release. Annotated tags have two `ls-remote` rows; the peeled
 * `^{}` row wins so the image tag agrees with `github.sha` in the publishing workflow.
 */
export function parseLsRemoteReleases(stdout: string): RemoteRelease[] {
  const releases = new Map<string, { direct?: string; peeled?: string }>();
  for (const line of stdout.split("\n")) {
    const [commit = "", rawRef = ""] = line.trim().split(/\s+/, 2);
    if (!COMMIT.test(commit) || !rawRef.startsWith("refs/tags/")) continue;
    const peeled = rawRef.endsWith("^{}");
    const tag = rawRef.slice("refs/tags/".length).replace(/\^\{\}$/, "");
    if (tag === "" || !isValidImageTag(tag)) continue;
    const entry = releases.get(tag) ?? {};
    if (peeled) entry.peeled = commit;
    else entry.direct = commit;
    releases.set(tag, entry);
  }
  return [...releases].flatMap(([tag, commits]) => {
    const commit = commits.peeled ?? commits.direct;
    return commit === undefined ? [] : [{ tag, commit }];
  });
}

/**
 * The newest stable release. Pre-releases are skipped because "update to latest" should not move a
 * deployment onto a release candidate, and there is no way to opt back out once it has recreated.
 */
export function selectLatestReleaseTag(tags: readonly string[]): string | null {
  let best: ReleaseTag | null = null;
  for (const tag of tags) {
    const parsed = parseReleaseTag(tag);
    if (!parsed || parsed.prerelease !== null) continue;
    if (best === null || compareReleaseTags(parsed, best) > 0) best = parsed;
  }
  return best?.tag ?? null;
}

/** Selects the newest stable release together with the commit-tagged image CI published for it. */
export function selectLatestRelease(releases: readonly RemoteRelease[]): RemoteRelease | null {
  let best: { release: ReleaseTag; commit: string } | null = null;
  for (const candidate of releases) {
    const parsed = parseReleaseTag(candidate.tag);
    if (!parsed || parsed.prerelease !== null) continue;
    if (best === null || compareReleaseTags(parsed, best.release) > 0) {
      best = { release: parsed, commit: candidate.commit };
    }
  }
  return best === null ? null : { tag: best.release.tag, commit: best.commit };
}

export interface ServerReleaseImage {
  repository: string;
  digest: string;
  reference: string;
}

export interface ServerReleaseManifest {
  schemaVersion: typeof SERVER_RELEASE_MANIFEST_SCHEMA_VERSION;
  releaseTag: string;
  sourceCommit: string;
  platforms: Array<(typeof SERVER_IMAGE_PLATFORMS)[number]>;
  images: {
    app: ServerReleaseImage;
    updater: ServerReleaseImage;
  };
  workflow: {
    repository: typeof OFFICIAL_GITHUB_REPOSITORY;
    path: typeof SERVER_RELEASE_WORKFLOW_PATH;
    ref: string;
    identity: string;
    runId: string;
    runAttempt: number;
  };
}

export type ServerReleaseManifestResult = { manifest: ServerReleaseManifest } | { error: string };

/**
 * Parses the attested release manifest after its signature has been verified. The exact package
 * repositories, workflow, ref, and two-platform release shape are policy, not caller input.
 */
export function parseServerReleaseManifest(input: unknown): ServerReleaseManifestResult {
  const source = asRecord(input);
  if (source === null || source.schemaVersion !== SERVER_RELEASE_MANIFEST_SCHEMA_VERSION) {
    return { error: "The server release manifest has an unsupported schema." };
  }
  const releaseTag = typeof source.releaseTag === "string" ? source.releaseTag : "";
  const release = parseReleaseTag(releaseTag);
  if (release === null || release.prerelease !== null) {
    return { error: "The server release manifest does not name a stable release." };
  }
  const sourceCommit = typeof source.sourceCommit === "string" ? source.sourceCommit : "";
  if (!isGitCommit(sourceCommit)) {
    return { error: "The server release manifest does not name a full source commit." };
  }
  const platforms = source.platforms;
  if (
    !Array.isArray(platforms) ||
    platforms.length !== SERVER_IMAGE_PLATFORMS.length ||
    !SERVER_IMAGE_PLATFORMS.every((platform, index) => platforms[index] === platform)
  ) {
    return { error: "The server release manifest does not cover the required platforms." };
  }

  const images = asRecord(source.images);
  const app = parseReleaseImage(images?.app, OFFICIAL_SERVER_IMAGE);
  const updater = parseReleaseImage(images?.updater, OFFICIAL_UPDATER_IMAGE);
  if (app === null || updater === null) {
    return { error: "The server release manifest has an invalid image digest." };
  }

  const workflow = asRecord(source.workflow);
  const expectedRef = `refs/tags/${releaseTag}`;
  const expectedIdentity = serverReleaseWorkflowIdentity(releaseTag);
  if (
    workflow === null ||
    workflow.repository !== OFFICIAL_GITHUB_REPOSITORY ||
    workflow.path !== SERVER_RELEASE_WORKFLOW_PATH ||
    workflow.ref !== expectedRef ||
    workflow.identity !== expectedIdentity ||
    typeof workflow.runId !== "string" ||
    !/^[1-9][0-9]*$/.test(workflow.runId) ||
    typeof workflow.runAttempt !== "number" ||
    !Number.isInteger(workflow.runAttempt) ||
    workflow.runAttempt < 1
  ) {
    return { error: "The server release manifest has an invalid workflow identity." };
  }

  return {
    manifest: {
      schemaVersion: SERVER_RELEASE_MANIFEST_SCHEMA_VERSION,
      releaseTag,
      sourceCommit,
      platforms: [...SERVER_IMAGE_PLATFORMS],
      images: { app, updater },
      workflow: {
        repository: OFFICIAL_GITHUB_REPOSITORY,
        path: SERVER_RELEASE_WORKFLOW_PATH,
        ref: expectedRef,
        identity: expectedIdentity,
        runId: workflow.runId,
        runAttempt: workflow.runAttempt,
      },
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseReleaseImage(value: unknown, repository: string): ServerReleaseImage | null {
  const image = asRecord(value);
  if (image?.repository !== repository || typeof image.digest !== "string") return null;
  if (!isValidImageDigest(image.digest)) return null;
  return { repository, digest: image.digest, reference: digestImageRef(repository, image.digest) };
}

export type UpdateStrategy = "pull" | "build";

export interface StrategyDecision {
  strategy: UpdateStrategy;
  reason: string;
}

/**
 * Only the official repository has published images. A fork has to be built where it is deployed,
 * which is minutes rather than seconds, so the choice is stated rather than guessed at call sites.
 */
export function chooseUpdateStrategy(input: { official: boolean }): StrategyDecision {
  if (input.official) {
    return {
      strategy: "pull",
      reason: "Official releases are published as images, so the update is a download and restart.",
    };
  }
  return {
    strategy: "build",
    reason:
      "A fork has no published images, so the server builds this update itself. Expect minutes, not seconds.",
  };
}

export type ExecutionMode = "sidecar" | "checkout" | "unavailable";

export interface ExecutionModeDecision {
  mode: ExecutionMode;
  reason: string | null;
}

/**
 * Which of the two engines can actually apply an update here. The sidecar wins whenever it is
 * configured: a Compose deployment's own container has no `.git` and nothing to restart it, so its
 * only route is the container that outlives it.
 */
export function resolveExecutionMode(input: {
  hasUpdater?: boolean;
  hasCheckout?: boolean;
  disabled?: boolean;
}): ExecutionModeDecision {
  if (input.disabled === true) {
    return { mode: "unavailable", reason: "Self-update is switched off for this deployment." };
  }
  if (input.hasUpdater === true) return { mode: "sidecar", reason: null };
  if (input.hasCheckout === true) return { mode: "checkout", reason: null };
  return {
    mode: "unavailable",
    reason:
      "This deployment has neither an updater sidecar nor a git checkout, so it cannot update itself. Add the `updater` service from infra/compose/docker-compose.prod.yml.",
  };
}

export interface ComposeInvocation {
  command: string;
  args: string[];
}

export interface ComposeTarget {
  composeFile: string;
  envFiles?: readonly string[];
  /** Passed as `docker compose -p <name>`. Defaults to {@link DEFAULT_COMPOSE_PROJECT_NAME}. */
  projectName?: string;
}

function composeBase(target: ComposeTarget): string[] {
  const projectName = target.projectName ?? DEFAULT_COMPOSE_PROJECT_NAME;
  if (!isValidComposeProjectName(projectName)) {
    throw new Error(`Refusing an unusable Compose project name: ${projectName}`);
  }
  const args = ["compose", "-p", projectName];
  for (const envFile of target.envFiles ?? []) args.push("--env-file", envFile);
  args.push("--file", target.composeFile);
  return args;
}

export function composePullArgv(
  target: ComposeTarget,
  services: readonly string[] = RECREATED_SERVICES,
): ComposeInvocation {
  return { command: "docker", args: [...composeBase(target), "pull", ...services] };
}

export function composeUpArgv(
  target: ComposeTarget,
  options: { build?: boolean; services?: readonly string[] } = {},
): ComposeInvocation {
  const args = [
    ...composeBase(target),
    "up",
    "--detach",
    "--wait",
    "--wait-timeout",
    "300",
    "--pull",
    "never",
  ];
  args.push(options.build === true ? "--build" : "--no-build");
  args.push(...(options.services ?? RECREATED_SERVICES));
  return { command: "docker", args };
}

export function composePsArgv(target: ComposeTarget): ComposeInvocation {
  return { command: "docker", args: [...composeBase(target), "ps", "--format", "json"] };
}

const VERIFY_API_REVISION_SCRIPT =
  "fetch('http://127.0.0.1:3100/health').then(async(response)=>{if(!response.ok)throw new Error('health status '+response.status);const health=await response.json();if(health.revision!==process.argv[1])throw new Error('expected revision '+process.argv[1]+' but received '+String(health.revision))}).catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exit(1)})";

/** Verify the process Compose made healthy is the source commit named by the signed manifest. */
export function composeVerifyCommitArgv(
  target: ComposeTarget,
  expectedCommit: string,
): ComposeInvocation {
  if (!isGitCommit(expectedCommit)) throw new Error("Health verification needs a full commit.");
  return {
    command: "docker",
    args: [
      ...composeBase(target),
      "exec",
      "--no-TTY",
      "api",
      "node",
      "-e",
      VERIFY_API_REVISION_SCRIPT,
      expectedCommit,
    ],
  };
}

/**
 * `git status` as seen inside the Linux sidecar against a Windows checkout. `core.autocrlf=true`
 * makes CR-only worktree noise match what the host already considers clean. The `-c` is argv, not a
 * shell fragment.
 */
export function gitStatusArgv(): string[] {
  return [
    "--no-optional-locks",
    "-c",
    "core.autocrlf=true",
    "status",
    "--porcelain",
    "--untracked-files=no",
  ];
}

/** Worktree vs index, ignoring CR at EOL so a CRLF-only file does not count as dirty. */
export function gitWorktreeContentDiffArgv(): string[] {
  return [
    "--no-optional-locks",
    "-c",
    "core.autocrlf=true",
    "diff",
    "--name-only",
    "--ignore-cr-at-eol",
  ];
}

/** Index vs HEAD, same CR rule, so a staged content change cannot hide behind the worktree check. */
export function gitIndexContentDiffArgv(): string[] {
  return [
    "--no-optional-locks",
    "-c",
    "core.autocrlf=true",
    "diff",
    "--cached",
    "--name-only",
    "--ignore-cr-at-eol",
  ];
}

/** Untracked source can enter `COPY . .`, so a build must not silently include it. */
export function gitUntrackedFilesArgv(): string[] {
  return ["--no-optional-locks", "ls-files", "--others", "--exclude-standard"];
}

export function parseGitNameOnly(stdout: string): string[] {
  const paths: string[] = [];
  for (const line of stdout.split("\n")) {
    const path = line.trim();
    if (path !== "") paths.push(path);
  }
  return paths;
}

export interface TrackedDirtyDecision {
  dirty: boolean;
  dirtyPaths: string[];
}

/**
 * Porcelain lists every tracked path git considers dirty, including CRLF-only noise when a Windows
 * `core.autocrlf=true` checkout is bind-mounted into Linux. `contentChanged` is the same comparison
 * after `--ignore-cr-at-eol`. Porcelain-only paths are dropped; a path that still has a content
 * diff stays dirty. If the content diffs could not be read, porcelain is the last word. The guard
 * is not weakened for a failed filter.
 */
export function resolveTrackedDirtyPaths(input: {
  porcelainChanged: readonly string[];
  contentChanged: readonly string[];
  contentDiffOk: boolean;
  untrackedPaths?: readonly string[];
}): TrackedDirtyDecision {
  const untrackedPaths = input.untrackedPaths ?? [];
  if (!input.contentDiffOk) {
    const dirtyPaths = uniquePaths([...input.porcelainChanged, ...untrackedPaths]);
    return { dirty: dirtyPaths.length > 0, dirtyPaths };
  }
  const dirtyPaths = uniquePaths([...input.contentChanged, ...untrackedPaths]);
  return { dirty: dirtyPaths.length > 0, dirtyPaths };
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const path of paths) {
    if (path === "" || seen.has(path)) continue;
    seen.add(path);
    unique.push(path);
  }
  return unique;
}

export interface ComposeUpdateStep {
  id: string;
  label: string;
  command: string;
  args: string[];
}

export interface ComposeUpdatePlanInput {
  strategy: UpdateStrategy;
  target: ComposeTarget;
  /** Only the build path touches the checkout, and only when the remote has to be re-pointed. */
  repoUrl?: string;
  branch?: string;
  repointRemote?: boolean;
  remote?: string;
}

/**
 * Ordered work for one Compose update.
 *
 * Migrations are absent on purpose. The `api` service runs `prisma migrate deploy` as the first
 * thing in its own start command, so a recreate already orders them correctly: Compose stops the
 * old container, the new one migrates with the new code, then serves. Running migrations from here
 * would instead apply the new schema while the old process is still answering requests, which is
 * the window this ordering exists to close.
 */
export function composeUpdatePlan(input: ComposeUpdatePlanInput): ComposeUpdateStep[] {
  const steps: ComposeUpdateStep[] = [];
  if (input.strategy === "build") {
    const remote = input.remote ?? DEFAULT_UPDATE_REMOTE;
    const branch = input.branch ?? "main";
    if (input.repointRemote === true && input.repoUrl) {
      steps.push({
        id: "remote",
        label: "Point the checkout at the chosen repository",
        command: "git",
        args: ["remote", "set-url", remote, input.repoUrl],
      });
    }
    steps.push(
      {
        id: "fetch",
        label: "Fetch the latest commits",
        command: "git",
        args: ["fetch", remote, branch],
      },
      {
        id: "checkout",
        label: `Check out ${branch}`,
        command: "git",
        args: ["checkout", branch],
      },
      {
        id: "merge",
        label: "Fast-forward to the fetched commit",
        command: "git",
        args: ["merge", "--ff-only", `${remote}/${branch}`],
      },
    );
    const up = composeUpArgv(input.target, { build: true });
    steps.push({
      id: "recreate",
      label: "Build the new images and recreate the services",
      command: up.command,
      args: up.args,
    });
    return steps;
  }

  const pull = composePullArgv(input.target);
  const up = composeUpArgv(input.target);
  steps.push(
    { id: "pull", label: "Download the new images", command: pull.command, args: pull.args },
    { id: "recreate", label: "Recreate the services", command: up.command, args: up.args },
  );
  return steps;
}

export type RollbackDecision = { ref: string } | { error: string };

/**
 * Rollback is "deploy the tag that was running before the last update". The updater reuses the
 * image already cached on this host instead of trusting that a mutable registry tag still points
 * at the same content.
 */
export function rollbackTarget(input: {
  currentRef: string | null;
  previousRef: string | null;
}): RollbackDecision {
  if (!input.previousRef) {
    return {
      error: "No previous image reference was recorded, so there is nothing to roll back to.",
    };
  }
  if (!isValidImageRef(input.previousRef)) {
    return { error: "The recorded previous image reference is not usable." };
  }
  if (input.previousRef === input.currentRef) {
    return { error: "The previous image reference is the one already running." };
  }
  return { ref: input.previousRef };
}

/**
 * Rewrites managed assignments in the deployment's `.env` without disturbing anything else in it,
 * so the operator's own `docker compose --env-file .env … up -d` keeps using the pinned tag.
 * Values are checked against a conservative grammar first: this file is read by Compose as
 * interpolation input, and it is the last place a repository URL or ref could leak into a build
 * argument or a service definition.
 */
export function upsertEnvAssignments(
  contents: string,
  assignments: Readonly<Record<string, string>>,
): string {
  for (const [key, value] of Object.entries(assignments)) {
    if (!ENV_KEY.test(key)) throw new Error(`Refusing to write the env key ${key}.`);
    if (!ENV_VALUE.test(value)) throw new Error(`Refusing to write the value of ${key}.`);
  }
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const lines = contents.split(/\r?\n/);
  const pending = new Map(Object.entries(assignments));
  const next = lines.map((line) => {
    const key = line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1];
    if (key === undefined || !Object.hasOwn(assignments, key)) return line;
    const value = assignments[key] as string;
    pending.delete(key);
    return `${key}=${value}`;
  });
  if (pending.size > 0) {
    while (next.length > 0 && next[next.length - 1] === "") next.pop();
    if (next.length > 0) next.push("");
    for (const [key, value] of pending) next.push(`${key}=${value}`);
  }
  const rendered = next.join(newline);
  return rendered.endsWith(newline) ? rendered : `${rendered}${newline}`;
}

export interface UpdateRequest {
  repoUrl: string;
  branch: string;
  official: boolean;
}

export type UpdateRequestResult = { request: UpdateRequest } | { error: string };

/**
 * The sidecar's own front door. It holds the Docker socket, so it is a separate trust boundary and
 * re-runs every check the API already ran rather than trusting that the caller sanitized anything.
 */
export function validateUpdateRequest(input: {
  repoUrl?: unknown;
  branch?: unknown;
}): UpdateRequestResult {
  if (typeof input.repoUrl !== "string") return { error: "A repository URL is required." };
  if (typeof input.branch !== "string") return { error: "A branch is required." };
  const url = normalizeRepoUrl(input.repoUrl);
  if ("error" in url) return { error: url.error };
  const branch = normalizeUpdateBranch(input.branch);
  if ("error" in branch) return { error: branch.error };
  return {
    request: { repoUrl: url.url, branch: branch.branch, official: isOfficialRepoUrl(url.url) },
  };
}
