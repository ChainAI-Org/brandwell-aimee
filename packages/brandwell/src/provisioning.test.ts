import { describe, expect, it, vi } from "vitest";
import {
  BRANDWELL_PROVISIONING_STEPS,
  type BrandwellProvisioningCheckpoint,
  BrandwellProvisioningError,
  type BrandwellProvisioningStep,
  buildBrandwellProvisioningPlan,
  provisionBrandwellWorkspace,
  rollbackOrderForCompletedSteps,
} from "./provisioning.js";

describe("BrandWell AIMEE provisioning", () => {
  it("builds the complete idempotent 15-step plan", () => {
    const plan = buildBrandwellProvisioningPlan({
      brandwellCustomerId: "customer-acme",
      companyName: "Acme Roofing",
      primaryContactName: "Alex",
      primaryContactEmail: "alex@example.com",
      plan: "aimee",
      timezone: "America/Phoenix",
    });

    expect(plan.idempotencyKey).toBe("brandwell:provision:customer-acme");
    expect(plan.steps.map((step) => step.name)).toEqual(BRANDWELL_PROVISIONING_STEPS);
    expect(new Set(plan.steps.map((step) => step.name)).size).toBe(15);
  });

  it("rolls back only completed steps in reverse order", () => {
    expect(
      rollbackOrderForCompletedSteps(["workspace", "service_identity", "primary_aimee"]),
    ).toEqual(["primary_aimee", "service_identity", "workspace"]);
  });

  it("runs every step once, persists checkpoints, and reuses a completed result", async () => {
    let stored: BrandwellProvisioningCheckpoint | null = null;
    const execute = vi.fn(async (step: string) => ({ resourceId: `${step}-id` }));
    const save = vi.fn(async (checkpoint: BrandwellProvisioningCheckpoint) => {
      stored = structuredClone(checkpoint);
    });
    const runner = {
      load: vi.fn(async () => stored),
      save,
      execute,
      rollback: vi.fn(async () => undefined),
      now: () => new Date("2026-08-27T12:00:00.000Z"),
      createRunId: () => "run-provision-1",
    };
    const input = {
      brandwellCustomerId: " customer-acme ",
      companyName: " Acme Roofing ",
      primaryContactName: " Alex ",
      primaryContactEmail: " ALEX@EXAMPLE.COM ",
      plan: "aimee",
      timezone: "America/Phoenix",
    };

    const result = await provisionBrandwellWorkspace(input, runner);
    expect(result.status).toBe("complete");
    expect(result.input.primaryContactEmail).toBe("alex@example.com");
    expect(result.steps.every((step) => step.status === "completed")).toBe(true);
    expect(execute).toHaveBeenCalledTimes(BRANDWELL_PROVISIONING_STEPS.length);

    const repeated = await provisionBrandwellWorkspace(input, runner);
    expect(repeated).toEqual(result);
    expect(execute).toHaveBeenCalledTimes(BRANDWELL_PROVISIONING_STEPS.length);
  });

  it("rolls completed steps back in reverse order and reports a clean failure", async () => {
    let stored: BrandwellProvisioningCheckpoint | null = null;
    const rollback = vi.fn<(step: BrandwellProvisioningStep) => Promise<void>>(
      async () => undefined,
    );
    const runner = {
      load: vi.fn(async () => stored),
      save: vi.fn(async (checkpoint: BrandwellProvisioningCheckpoint) => {
        stored = structuredClone(checkpoint);
      }),
      execute: vi.fn(async (step: string) => {
        if (step === "primary_aimee") throw new Error("computer template unavailable");
        return { resourceId: `${step}-id` };
      }),
      rollback,
      now: () => new Date("2026-08-27T12:00:00.000Z"),
      createRunId: () => "run-provision-failed",
    };

    let captured: BrandwellProvisioningError | null = null;
    try {
      await provisionBrandwellWorkspace(
        {
          brandwellCustomerId: "customer-acme",
          companyName: "Acme Roofing",
          primaryContactName: "Alex",
          primaryContactEmail: "alex@example.com",
          plan: "aimee",
          timezone: "America/Phoenix",
        },
        runner,
      );
    } catch (error) {
      captured = error as BrandwellProvisioningError;
    }
    expect(captured).toBeInstanceOf(BrandwellProvisioningError);
    expect(captured?.checkpoint.status).toBe("failed");
    expect(rollback.mock.calls.map(([step]) => step)).toEqual([
      "client_admin_membership",
      "service_identity",
      "workspace",
    ]);
    const latest = stored as BrandwellProvisioningCheckpoint | null;
    expect(latest?.steps.find((step) => step.name === "primary_aimee")?.status).toBe("failed");
  });

  it("blocks a concurrent provisioning attempt", async () => {
    const running = {
      version: 1 as const,
      idempotencyKey: "brandwell:provision:customer-acme",
      input: {
        brandwellCustomerId: "customer-acme",
        companyName: "Acme Roofing",
        primaryContactName: "Alex",
        primaryContactEmail: "alex@example.com",
        plan: "aimee",
        timezone: "America/Phoenix",
      },
      status: "running" as const,
      runId: "existing-run",
      steps: BRANDWELL_PROVISIONING_STEPS.map((name) => ({ name, status: "pending" as const })),
      startedAt: "2026-08-27T12:00:00.000Z",
      updatedAt: "2026-08-27T12:00:00.000Z",
    };
    await expect(
      provisionBrandwellWorkspace(running.input, {
        load: async () => running,
        save: async () => undefined,
        execute: async () => undefined,
        rollback: async () => undefined,
      }),
    ).rejects.toThrow("already running");
  });
});
