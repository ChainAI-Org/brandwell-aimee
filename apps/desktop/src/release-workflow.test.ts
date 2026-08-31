import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  path.resolve(import.meta.dirname, "../../../.github/workflows/release-desktop.yml"),
  "utf8",
);
const ciWorkflow = readFileSync(
  path.resolve(import.meta.dirname, "../../../.github/workflows/ci.yml"),
  "utf8",
);
const serverImageWorkflow = readFileSync(
  path.resolve(import.meta.dirname, "../../../.github/workflows/publish-server-image.yml"),
  "utf8",
);
const desktopPerformanceHarness = readFileSync(
  path.resolve(import.meta.dirname, "../../../packages/testkit/src/cli/desktop-performance.ts"),
  "utf8",
);
const desktopPackage = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
) as {
  name: string;
  build: { productName: string; publish: Array<Record<string, string>> };
};

describe("desktop release workflow", () => {
  it("cannot execute contributor pull-request code with release credentials", () => {
    expect(workflow).not.toMatch(/^\s*pull_request:/m);
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(3);
  });

  it("pins every third-party action to an immutable commit", () => {
    const actionReferences = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1]);
    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference, reference).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it("requires signed platform builds before a single publication job", () => {
    expect(workflow).toContain("-c.forceCodeSigning=true");
    expect(workflow).toContain("codesign --verify --deep --strict");
    expect(workflow).toContain('grep -Fqx "TeamIdentifier=$EXPECTED_TEAM_ID"');
    expect(workflow).toContain("Get-AuthenticodeSignature");
    expect(workflow).toContain("SignerCertificate.Subject -ne $env:EXPECTED_PUBLISHER");
    expect(workflow).toContain("needs: [validate, build]");
    expect(workflow).toContain("attestations: write");
    expect(workflow).toContain("actions/attest-build-provenance@");
    expect(workflow).not.toContain("--publish always");
    expect(workflow).toContain("DESKTOP_MAC_CSC_LINK");
    expect(workflow).toContain("DESKTOP_WIN_CSC_LINK");
    expect(workflow).toContain("DESKTOP_WIN_EXPECTED_PUBLISHER");
    expect(workflow).not.toMatch(/secrets\.DESKTOP_CSC_(?:LINK|KEY_PASSWORD)/);
    expect(workflow).not.toContain("cache: pnpm");
    expect(workflow).toContain("apps/desktop/out/latest*.yml");
    expect(workflow).not.toContain("apps/desktop/out/*.yml");
  });

  it("does not offer unsigned Linux artifacts through the automatic updater", () => {
    expect(workflow).toContain("Package x64 Linux AppImage");
    expect(workflow).not.toContain("Build signed ");
  });

  it("pins every platform update feed to the official GitHub owner and repo", () => {
    expect(workflow).toContain('"$GITHUB_REPOSITORY" != "ChainAI-Org/brandwell-aimee"');
    expect(workflow).toContain('grep -Fqx "provider: github"');
    expect(workflow).toContain('grep -Fqx "owner: ChainAI-Org"');
    expect(workflow).toContain('grep -Fqx "repo: brandwell-aimee"');
    expect(workflow).toContain("Verify Linux update feed is pinned to the official GitHub channel");
    expect(workflow).toContain("Windows update config missing");
    expect(workflow).toContain("RELEASE_VERSION:");
    expect(workflow).toContain('grep -Fqx "version: $RELEASE_VERSION"');
  });

  it("builds the real desktop package and fails closed when a filter stops matching", () => {
    expect(desktopPackage.name).toBe("@brandwell/desktop");
    expect(workflow).not.toContain("@rakazo/desktop");
    expect(ciWorkflow).not.toContain("@rakazo/desktop");
    expect(workflow.match(/@brandwell\/desktop --fail-if-no-match/g)).toHaveLength(4);
    expect(ciWorkflow).toContain("@brandwell/desktop --fail-if-no-match");
  });

  it("keeps packaged local benchmarks behind the explicit support override", () => {
    expect(desktopPerformanceHarness).toContain('BRANDWELL_AIMEE_SUPPORT_SERVER_CHOOSER: "1"');
    expect(desktopPerformanceHarness).toContain("RAKAZO_WEB_URL: webOrigin");
  });

  it("publishes branded artifacts to the ChainAI organization update channel", () => {
    expect(desktopPackage.build.productName).toBe("BrandWell's AIMEE");
    expect(desktopPackage.build.publish).toEqual([
      { provider: "github", owner: "ChainAI-Org", repo: "brandwell-aimee" },
    ]);
    expect(workflow).toContain("BrandWell's AIMEE.app");
    expect(workflow).toContain('--title "BrandWell\'s AIMEE $RELEASE_TAG"');
    expect(workflow).not.toMatch(/\bRakazo\b/);
  });

  it("keeps public server images in the branded official namespace", () => {
    expect(serverImageWorkflow).toContain("IMAGE_REPOSITORY: ghcr.io/chainai-org/brandwell-aimee");
    expect(serverImageWorkflow).toContain("github.repository == 'ChainAI-Org/brandwell-aimee'");
    expect(serverImageWorkflow).not.toContain(["ghcr.io/$", "{{ github.repository }}"].join(""));
    expect(serverImageWorkflow).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
    expect(serverImageWorkflow).toContain("^v[0-9]+\\.[0-9]+\\.[0-9]+$");
  });

  it("publishes only a complete stable, upgrade-only feed", () => {
    expect(workflow).toContain("^v([0-9]+)\\.([0-9]+)\\.([0-9]+)$");
    expect(workflow).toContain("must be newer than published release");
    expect(workflow).toContain("group: release-desktop-stable");
    expect(workflow).toContain(
      'node scripts/verify-desktop-update-feeds.mjs release-artifacts "$RELEASE_VERSION"',
    );
    expect(workflow).toContain("--draft --generate-notes");
    expect(workflow).toContain("--draft=false --latest");
  });
});
