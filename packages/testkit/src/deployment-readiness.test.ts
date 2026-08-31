import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

describe("BrandWell deployment readiness gates", () => {
  it("requires an operational readiness response for the expected revision", async () => {
    const script = await source("../../../infra/deploy/deploy-brandwell-revision.sh");

    expect(script).toContain('DEFAULT_READINESS_URL="https://ai.brandwell.ai/ready"');
    expect(script).toContain('DEFAULT_READINESS_URL="https://staging-ai.brandwell.ai/ready"');
    expect(script).toContain("wait_for_readiness");
    expect(script).toContain("'\"ok\":true'");
    expect(script).toMatch(/grep -Fq .*revision.*expected_sha/);
    expect(script).not.toContain("DEFAULT_HEALTH_URL");
  });

  it("uses readiness in post-deploy CI while preserving lightweight Compose liveness", async () => {
    const [staging, ci, compose, caddy] = await Promise.all([
      source("../../../.github/workflows/deploy-brandwell-staging.yml"),
      source("../../../.github/workflows/ci.yml"),
      source("../../../infra/compose/docker-compose.prod.yml"),
      source("../../../infra/compose/Caddyfile.prod"),
    ]);

    expect(staging).toContain("https://staging-ai.brandwell.ai/ready");
    expect(ci).toContain("https://ai.brandwell.ai/ready");
    for (const workflow of [staging, ci]) {
      expect(workflow).toContain("JSON.parse");
      expect(workflow).toContain("readiness?.ok !== true");
      expect(workflow).toContain('readiness?.service !== "aimee"');
      expect(workflow).toContain("readiness?.revision !== process.env.EXPECTED_REVISION");
    }
    expect(compose).toContain("fetch('http://127.0.0.1:3100/health')");
    expect(compose).not.toContain("fetch('http://127.0.0.1:3100/ready')");
    expect(caddy).toMatch(/handle \/ready \{\s+reverse_proxy api:3100\s+\}/);
  });
});
