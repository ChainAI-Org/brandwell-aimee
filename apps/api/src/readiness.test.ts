import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  evaluateProductionReadiness,
  mountProductionReadinessRoute,
  type ProductionReadinessConfig,
  type ProductionReadinessDataSource,
} from "./readiness.js";

const REVISION = "a".repeat(40);
const NOW = new Date("2026-08-31T01:00:00.000Z");

function config(overrides: Partial<ProductionReadinessConfig> = {}): ProductionReadinessConfig {
  return {
    agentRuntime: "pi",
    brandwellManagementApiToken: "management-secret-must-not-be-returned",
    brandwellPlatformApiUrl: "https://portal.example.test",
    brandwellPlatformServiceToken: "bridge-secret-must-not-be-returned",
    brandwellSystemUserId: "system-user-1",
    daytonaApiKey: "daytona-secret-must-not-be-returned",
    daytonaSnapshot: "aimee-browser-v1",
    defaultModel: "provider/model",
    defaultProvider: "openrouter",
    deploymentModelKey: "runtime-secret-must-not-be-returned",
    gitSha: REVISION,
    openRouterManagementKey: "management-provider-secret-must-not-be-returned",
    sandboxProvider: "daytona",
    wakeupDriver: "graphile",
    ...overrides,
  };
}

function dataSource(
  overrides: Partial<ProductionReadinessDataSource> = {},
): ProductionReadinessDataSource {
  return {
    ping: vi.fn(async () => undefined),
    migrationApplied: vi.fn(async () => true),
    systemUserExists: vi.fn(async () => true),
    latestWorkerHeartbeat: vi.fn(async () => ({
      revision: REVISION,
      heartbeatAt: new Date(NOW.getTime() - 1_000),
    })),
    ...overrides,
  };
}

describe("production readiness", () => {
  it("returns 200 only for a fully operational deployment without exposing secrets", async () => {
    const app = new Hono();
    const readinessConfig = config();
    const readinessDataSource = dataSource();
    mountProductionReadinessRoute(app, {
      config: readinessConfig,
      dataSource: readinessDataSource,
      now: () => NOW,
    });

    const response = await app.request("/ready");
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(readinessDataSource.latestWorkerHeartbeat).toHaveBeenCalledWith(REVISION);
    expect(body).toEqual({
      ok: true,
      service: "aimee",
      revision: REVISION,
      checkedAt: NOW.toISOString(),
      checks: {
        deploymentRevision: { status: "pass", code: "ok" },
        database: { status: "pass", code: "ok" },
        migrations: { status: "pass", code: "ok" },
        worker: { status: "pass", code: "ok" },
        managedAdmin: { status: "pass", code: "ok" },
        openRouterManagement: { status: "pass", code: "ok" },
        runtimeInference: { status: "pass", code: "ok" },
        daytona: { status: "pass", code: "ok" },
        brandwellBridge: { status: "pass", code: "ok" },
      },
    });
    for (const secret of [
      readinessConfig.brandwellManagementApiToken,
      readinessConfig.brandwellPlatformServiceToken,
      readinessConfig.daytonaApiKey,
      readinessConfig.deploymentModelKey,
      readinessConfig.openRouterManagementKey,
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("fails closed when required managed configuration is absent", async () => {
    const report = await evaluateProductionReadiness({
      config: config({
        agentRuntime: "scripted",
        brandwellManagementApiToken: undefined,
        brandwellPlatformServiceToken: undefined,
        daytonaApiKey: undefined,
        deploymentModelKey: undefined,
        defaultProvider: "anthropic",
        gitSha: undefined,
        openRouterManagementKey: undefined,
        sandboxProvider: "docker",
        wakeupDriver: "memory",
      }),
      dataSource: dataSource(),
      now: () => NOW,
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toMatchObject({
      deploymentRevision: { status: "fail", code: "revision_invalid" },
      managedAdmin: { status: "fail", code: "configuration_missing" },
      openRouterManagement: { status: "fail", code: "configuration_missing" },
      runtimeInference: { status: "fail", code: "unsupported_runtime" },
      daytona: { status: "fail", code: "unsupported_sandbox" },
      brandwellBridge: { status: "fail", code: "configuration_missing" },
      worker: { status: "fail", code: "unsupported_job_driver" },
    });
  });

  it("requires an immutable revision and the managed OpenRouter runtime provider", async () => {
    const invalidRevision = await evaluateProductionReadiness({
      config: config({ gitSha: "ABC123", defaultProvider: "anthropic" }),
      dataSource: dataSource(),
      now: () => NOW,
    });

    expect(invalidRevision.ok).toBe(false);
    expect(invalidRevision.checks.deploymentRevision).toEqual({
      status: "fail",
      code: "revision_invalid",
    });
    expect(invalidRevision.checks.runtimeInference).toEqual({
      status: "fail",
      code: "unsupported_provider",
    });
  });

  it("reports database, migration, system-user, and worker failures as 503 readiness", async () => {
    const app = new Hono();
    mountProductionReadinessRoute(app, {
      config: config(),
      dataSource: dataSource({
        migrationApplied: vi.fn(async () => false),
        systemUserExists: vi.fn(async () => false),
        latestWorkerHeartbeat: vi.fn(async () => ({
          revision: REVISION,
          heartbeatAt: new Date(NOW.getTime() - 60_000),
        })),
      }),
      now: () => NOW,
    });

    const response = await app.request("/ready");
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      checks: {
        database: { status: "pass", code: "ok" },
        migrations: { status: "fail", code: "migration_missing" },
        worker: { status: "fail", code: "worker_stale" },
        managedAdmin: { status: "fail", code: "system_user_missing" },
      },
    });
  });

  it("does not infer readiness when the database is unreachable or worker revision differs", async () => {
    const unavailable = await evaluateProductionReadiness({
      config: config(),
      dataSource: dataSource({ ping: vi.fn(async () => Promise.reject(new Error("offline"))) }),
      now: () => NOW,
    });
    expect(unavailable.checks).toMatchObject({
      database: { status: "fail", code: "database_unreachable" },
      migrations: { status: "fail", code: "dependency_unavailable" },
      worker: { status: "fail", code: "dependency_unavailable" },
      managedAdmin: { status: "fail", code: "dependency_unavailable" },
    });

    const wrongRevision = await evaluateProductionReadiness({
      config: config(),
      dataSource: dataSource({
        latestWorkerHeartbeat: vi.fn(async () => ({
          revision: "b".repeat(40),
          heartbeatAt: new Date(NOW.getTime() - 1_000),
        })),
      }),
      now: () => NOW,
    });
    expect(wrongRevision.checks.worker).toEqual({
      status: "fail",
      code: "worker_revision_mismatch",
    });
  });
});
