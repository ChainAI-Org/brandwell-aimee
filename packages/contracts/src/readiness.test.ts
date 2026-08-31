import { describe, expect, it } from "vitest";
import { ProductionReadinessSchema } from "./readiness.js";

const pass = { status: "pass" as const, code: "ok" };

describe("ProductionReadinessSchema", () => {
  it("accepts the complete secret-free readiness contract", () => {
    expect(
      ProductionReadinessSchema.parse({
        ok: true,
        service: "aimee",
        revision: "a".repeat(40),
        checkedAt: "2026-08-31T01:00:00.000Z",
        checks: {
          deploymentRevision: pass,
          database: pass,
          migrations: pass,
          worker: pass,
          managedAdmin: pass,
          openRouterManagement: pass,
          runtimeInference: pass,
          computer: pass,
          brandwellBridge: pass,
        },
      }),
    ).toMatchObject({ ok: true, checks: { worker: pass } });
  });

  it("rejects omitted checks and accidental secret fields", () => {
    const incomplete = {
      ok: false,
      service: "aimee",
      revision: null,
      checkedAt: "2026-08-31T01:00:00.000Z",
      checks: { database: { status: "fail", code: "database_unreachable" } },
    };
    expect(() => ProductionReadinessSchema.parse(incomplete)).toThrow();
    expect(() =>
      ProductionReadinessSchema.parse({
        ...incomplete,
        checks: {
          deploymentRevision: pass,
          database: pass,
          migrations: pass,
          worker: pass,
          managedAdmin: pass,
          openRouterManagement: pass,
          runtimeInference: pass,
          computer: pass,
          brandwellBridge: pass,
        },
        openRouterKey: "must-not-appear",
      }),
    ).toThrow();
  });

  it("rejects an ok response when any required check failed", () => {
    expect(() =>
      ProductionReadinessSchema.parse({
        ok: true,
        service: "aimee",
        revision: "a".repeat(40),
        checkedAt: "2026-08-31T01:00:00.000Z",
        checks: {
          deploymentRevision: pass,
          database: pass,
          migrations: pass,
          worker: { status: "fail", code: "worker_stale" },
          managedAdmin: pass,
          openRouterManagement: pass,
          runtimeInference: pass,
          computer: pass,
          brandwellBridge: pass,
        },
      }),
    ).toThrow(/aggregate check status/);
  });
});
