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
    expect(script).toMatch(/git fetch --no-tags origin "\$\{DEPLOY_SHA\}"/);
    expect(script).toContain("ensure_proxy_route");
    expect(script).toContain("docker network connect");
    expect(script).toContain("caddy validate --config /dev/stdin");
    expect(script).toContain("caddy reload --config /dev/stdin");
    expect(script).toContain("Active proxy does not use this deployment's Caddyfile");
    expect(script).toContain("$" + "{HOME}/.local/state/brandwell-aimee/backups/$" + "{TARGET}");
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
    expect(staging).toContain("/srv/rakazo/infra/deploy/deploy-brandwell-revision.sh");
    expect(staging).toMatch(/deploy-brandwell-revision\.sh \\\s+staging \\\s+"\$DEPLOY_SHA"/);
    expect(ci).toContain("/srv/rakazo/infra/deploy/deploy-brandwell-revision.sh");
    expect(ci).toMatch(
      /deploy-brandwell-revision\.sh \\\s+production \\\s+"\$\{\{ github\.sha \}\}"/,
    );
    for (const workflow of [staging, ci]) {
      expect(workflow).toContain("JSON.parse");
      expect(workflow).toContain("readiness?.ok !== true");
      expect(workflow).toContain('readiness?.service !== "aimee"');
      expect(workflow).toContain("readiness?.revision !== process.env.EXPECTED_REVISION");
    }
    expect(compose).toContain("fetch('http://127.0.0.1:3100/health')");
    expect(compose).not.toContain("fetch('http://127.0.0.1:3100/ready')");
    expect(compose).toContain("$" + "{CADDY_CONFIG_DIR:-.}:/etc/caddy-config:ro");
    expect(compose).toContain("/etc/caddy-config/Caddyfile.prod");
    expect(compose).toMatch(/caddy:[\s\S]*?entrypoint:\s+- caddy\s+command:\s+- run/);
    expect(compose).not.toContain(
      "$" + "{CADDYFILE_PATH:-./Caddyfile.prod}:/etc/caddy/Caddyfile:ro",
    );
    expect(compose).toMatch(
      /api:[\s\S]*?environment:\s+NODE_ENV: production\s+GIT_SHA: \$\{GIT_SHA:-\}/,
    );
    expect(compose).toMatch(
      /worker:[\s\S]*?environment:\s+NODE_ENV: production\s+GIT_SHA: \$\{GIT_SHA:-\}/,
    );
    expect(caddy).toMatch(
      /\{\$RAKAZO_HOST:app\.example\.com\}[\s\S]*?handle \/ready \{\s+reverse_proxy api:3100\s+\}/,
    );
    expect(caddy).toContain("ai.brandwell.ai");
    expect(caddy).toContain("staging-ai.brandwell.ai");
    expect(caddy).toContain(
      "{$BRANDWELL_PRODUCTION_API_UPSTREAM:brandwell-aimee-production-api-1:3100}",
    );
    expect(caddy).toContain("{$BRANDWELL_STAGING_API_UPSTREAM:brandwell-aimee-staging-api-1:3100}");
    expect(caddy).toContain(
      "{$BRANDWELL_PRODUCTION_WEB_UPSTREAM:brandwell-aimee-production-web-1:5173}",
    );
    expect(caddy).toContain("{$BRANDWELL_STAGING_WEB_UPSTREAM:brandwell-aimee-staging-web-1:5173}");
  });
});
