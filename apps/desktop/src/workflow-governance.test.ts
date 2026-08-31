import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflowDirectory = path.resolve(import.meta.dirname, "../../../.github/workflows");

function workflow(name: string) {
  return readFileSync(path.join(workflowDirectory, name), "utf8");
}

function jobBlock(source: string, name: string) {
  const marker = `\n  ${name}:\n`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Workflow job ${name} was not found.`);
  const bodyStart = start + marker.length;
  const nextJob = source.slice(bodyStart).search(/\n {2}[a-zA-Z0-9_-]+:\n/);
  return source.slice(start, nextJob < 0 ? source.length : bodyStart + nextJob);
}

describe("repository workflow governance", () => {
  it("pins every external action in every workflow to an immutable commit", () => {
    const files = readdirSync(workflowDirectory)
      .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
      .sort();
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = workflow(file);
      const references = [...source.matchAll(/^[ \t]*(?:-[ \t]+)?uses:[ \t]+([^\s#]+)/gm)].map(
        (match) => match[1] ?? "",
      );
      for (const reference of references) {
        if (reference.startsWith("./")) continue;
        expect(reference, `${file}: ${reference}`).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
      }
    }
  });

  it("allows staging to deploy only main or a commit already contained in main", () => {
    const staging = workflow("deploy-brandwell-staging.yml");
    const validate = jobBlock(staging, "validate");
    const deploy = jobBlock(staging, "deploy");

    expect(staging).toContain("main or a full commit SHA already contained in main");
    expect(validate).toContain("fetch-depth: 0");
    expect(validate).toContain("ref: main");
    expect(validate).toContain('if [[ "$REQUESTED_REF" == "main" ]]; then');
    expect(validate).toContain('elif [[ "$REQUESTED_REF" =~ ^[0-9a-f]{40}$ ]]; then');
    expect(validate).toContain('git merge-base --is-ancestor "$deploy_sha" origin/main');
    expect(validate).toContain('git checkout --detach "$deploy_sha"');
    expect(validate).not.toContain("secrets.");
    expect(staging).not.toContain(["ref: $", "{{ inputs.git_ref }}"].join(""));

    expect(deploy).toContain("needs: validate");
    expect(deploy).toContain("secrets.BRANDWELL_STAGING_SSH_PRIVATE_KEY");
    expect(deploy).not.toMatch(/^[ \t]*(?:-[ \t]+)?uses:/m);
  });

  it("gates desktop signing and publication on the protected release environment", () => {
    const release = workflow("release-desktop.yml");
    const validate = jobBlock(release, "validate");
    const build = jobBlock(release, "build");
    const publish = jobBlock(release, "publish");
    const environment = "environment:\n      name: brandwell-desktop-release";

    expect(validate).not.toContain(environment);
    expect(build).toContain(environment);
    expect(publish).toContain(environment);
    expect(release.match(/name: brandwell-desktop-release/g)).toHaveLength(2);
  });

  it("verifies the exact public production revision before publishing a desktop release", () => {
    const release = workflow("release-desktop.yml");
    const publish = jobBlock(release, "publish");
    const manifestCheck = publish.indexOf("Add and verify the signed server release manifest");
    const readinessCheck = publish.indexOf("Verify the exact production AIMEE revision is ready");
    const releaseCreation = publish.indexOf("Create draft and upload every platform");

    expect(manifestCheck).toBeGreaterThanOrEqual(0);
    expect(readinessCheck).toBeGreaterThan(manifestCheck);
    expect(releaseCreation).toBeGreaterThan(readinessCheck);
    expect(publish).toContain("https://ai.brandwell.ai/ready");
    expect(publish).toContain("curl --fail-with-body");
    expect(publish).toContain("--write-out '%{http_code}'");
    expect(publish).toContain('[[ ! "$status" =~ ^2[0-9]{2}$ ]]');
    expect(publish).toContain('.ok == true and .service == "aimee" and .revision == $sha');
    expect(publish).not.toContain("--location");
  });
});
