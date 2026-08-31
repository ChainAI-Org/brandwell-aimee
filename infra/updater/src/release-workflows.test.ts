import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = path.resolve(import.meta.dirname, "../../..");
const workflow = (name: string) =>
  readFileSync(path.join(root, ".github", "workflows", name), "utf8");

describe("immutable server release workflows", () => {
  it("keeps every edited workflow valid YAML", () => {
    for (const name of [
      "publish-server-image.yml",
      "promote-server-release.yml",
      "release-desktop.yml",
    ]) {
      expect(() => parse(workflow(name)), name).not.toThrow();
    }
  });

  it("publishes only full source and exact semver tags during image builds", () => {
    const source = workflow("publish-server-image.yml");
    expect(source).toContain("type=semver,pattern=v{{version}}");
    expect(source).toContain("type=sha,prefix=sha-");
    expect(source).not.toContain("type=semver,pattern=v{{major}}.{{minor}}");
    expect(source).not.toMatch(/type=raw,value=(?:latest|edge)/);
    expect(source).toContain("server-release-manifest.sigstore.jsonl");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell interpolation under test
    expect(source).toContain("server-image-${IMAGE_NAME}.sigstore.jsonl");
  });

  it("promotes both recorded digests only from the global release-published queue", () => {
    const source = workflow("promote-server-release.yml");
    expect(source).toContain("types: [published]");
    expect(source).toContain("group: promote-server-release-global");
    expect(source).toContain("sort -V | tail -n 1");
    expect(source).toContain("for image in app updater");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell interpolation under test
    expect(source).toContain('reference="${repository}@${digest}"');
    expect(source).toContain("gh attestation verify");
    for (const policy of [
      "--repo",
      "--signer-workflow",
      "--cert-identity",
      "--cert-oidc-issuer",
      "--source-digest",
      "--source-ref",
    ]) {
      expect(source).toContain(policy);
    }
    expect(source).toContain('--bundle "$bundle"');
    expect(source).not.toContain("--bundle-from-oci");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell interpolation under test
    expect(source).toContain('"${repository}:latest"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell interpolation under test
    expect(source).toContain('"${repository}:v${major}.${minor}"');
  });

  it("makes the signed server manifest part of the published release", () => {
    const source = workflow("release-desktop.yml");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell interpolation under test
    expect(source).toContain("server-release-manifest-${RELEASE_SHA}");
    expect(source).toContain("gh attestation verify");
    expect(source).toContain('--source-digest "$RELEASE_SHA"');
  });
});
