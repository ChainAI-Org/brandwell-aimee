import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { reconcileBrandwellFleetHealth } from "./prisma-alerting.js";

function fleetPrisma(input?: {
  runs?: Array<Record<string, unknown>>;
  credentials?: Array<Record<string, unknown>>;
  sidekickCredentials?: Array<Record<string, unknown>>;
  existingAlerts?: Array<Record<string, unknown>>;
}) {
  const alertUpsert = vi.fn(async () => ({}));
  const notificationUpsert = vi.fn(async () => ({}));
  const prisma = {
    brandwellAiWorkspace: {
      findMany: vi.fn(async () => [
        {
          brandwellCustomerId: "customer-acme",
          rakazoWorkspaceId: "workspace-acme",
          provisioningStatus: "complete",
          provisioningError: null,
        },
      ]),
    },
    run: { findMany: vi.fn(async () => input?.runs ?? []) },
    routine: { findMany: vi.fn(async () => []) },
    computer: { findMany: vi.fn(async () => []) },
    connection: { findMany: vi.fn(async () => []) },
    brandwellWorkspaceModelCredential: { findMany: vi.fn(async () => input?.credentials ?? []) },
    brandwellSidekickModelCredential: {
      findMany: vi.fn(async () => input?.sidekickCredentials ?? []),
    },
    brandwellCancellationEvent: { findMany: vi.fn(async () => []) },
    brandwellAlert: {
      findMany: vi.fn(async () => input?.existingAlerts ?? []),
      upsert: alertUpsert,
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    brandwellClientNotification: {
      upsert: notificationUpsert,
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  return { prisma: prisma as unknown as PrismaClient, alertUpsert, notificationUpsert };
}

describe("BrandWell fleet health reconciliation", () => {
  it("turns waiting takeover into one actionable client notification", async () => {
    const now = new Date("2026-08-27T12:00:00.000Z");
    const { prisma, alertUpsert, notificationUpsert } = fleetPrisma({
      runs: [
        {
          id: "run-login",
          workspaceId: "workspace-acme",
          botId: "bot-aimee",
          status: "waiting_takeover",
          error: null,
          createdAt: new Date("2026-08-27T11:55:00.000Z"),
          updatedAt: new Date("2026-08-27T11:59:00.000Z"),
        },
      ],
    });

    const result = await reconcileBrandwellFleetHealth(prisma, now);

    expect(result).toMatchObject({ candidates: 1, upserted: 1, notifications: 1 });
    expect(alertUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          type: "LOGIN_REQUIRED",
          clientActionRequired: true,
          runId: "run-login",
        }),
      }),
    );
    expect(notificationUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          title: "AIMEE needs your help",
          actionType: "OPEN_COMPUTER",
          actionTarget: "/computer?botId=bot-aimee",
          pushDeliveryNextAt: now,
        }),
      }),
    );
  });

  it("updates a persistent alert without sending a duplicate notification", async () => {
    const now = new Date("2026-08-27T12:00:00.000Z");
    const { prisma, notificationUpsert } = fleetPrisma({
      runs: [
        {
          id: "run-login",
          workspaceId: "workspace-acme",
          botId: "bot-aimee",
          status: "waiting_takeover",
          error: null,
          createdAt: new Date("2026-08-27T11:55:00.000Z"),
          updatedAt: new Date("2026-08-27T11:59:00.000Z"),
        },
      ],
      existingAlerts: [
        {
          id: "alert-login",
          workspaceId: "workspace-acme",
          dedupeKey: "workspace-acme:LOGIN_REQUIRED:run-login",
          status: "WAITING_CLIENT",
        },
      ],
    });

    const result = await reconcileBrandwellFleetHealth(prisma, now);
    expect(result.notifications).toBe(0);
    expect(notificationUpsert).not.toHaveBeenCalled();
  });

  it("reopens a resolved client notice and schedules a fresh push", async () => {
    const now = new Date("2026-08-27T12:00:00.000Z");
    const { prisma, notificationUpsert } = fleetPrisma({
      runs: [
        {
          id: "run-login",
          workspaceId: "workspace-acme",
          botId: "bot-aimee",
          status: "waiting_takeover",
          error: null,
          createdAt: new Date("2026-08-27T11:55:00.000Z"),
          updatedAt: new Date("2026-08-27T11:59:00.000Z"),
        },
      ],
      existingAlerts: [
        {
          id: "alert-login",
          workspaceId: "workspace-acme",
          dedupeKey: "workspace-acme:LOGIN_REQUIRED:run-login",
          status: "RESOLVED",
        },
      ],
    });

    const result = await reconcileBrandwellFleetHealth(prisma, now);

    expect(result.notifications).toBe(1);
    expect(notificationUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          resolvedAt: null,
          pushDeliveryStatus: "pending",
          pushDeliveryAttempts: 0,
          pushDeliveryNextAt: now,
          pushSentAt: null,
        }),
      }),
    );
  });

  it("alerts BrandWell when provider usage reconciliation fails", async () => {
    const { prisma, alertUpsert } = fleetPrisma({
      credentials: [
        {
          id: "credential-acme",
          workspaceId: "workspace-acme",
          externalKeyHash: "hash-acme",
          status: "active",
          disabledAt: null,
          currentUsageMicros: 10_000_000n,
          monthlyLimitMicros: 250_000_000n,
          warningLimitMicros: 175_000_000n,
          providerLimitMicros: null,
          providerUsageSyncedAt: null,
          providerUsageSyncError: "OpenRouter management request failed with status 503",
        },
      ],
    });

    await expect(reconcileBrandwellFleetHealth(prisma)).resolves.toMatchObject({ candidates: 1 });
    expect(alertUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          type: "OPENROUTER_USAGE_SYNC_FAILED",
          severity: "ERROR",
          brandwellActionRequired: true,
        }),
      }),
    );
  });

  it("alerts BrandWell when provider reconciliation is stale", async () => {
    const now = new Date("2026-08-27T12:00:00.000Z");
    const { prisma, alertUpsert } = fleetPrisma({
      credentials: [
        {
          id: "credential-acme",
          workspaceId: "workspace-acme",
          externalKeyHash: "hash-acme",
          status: "active",
          disabledAt: null,
          currentUsageMicros: 10_000_000n,
          monthlyLimitMicros: 200_000_000n,
          warningLimitMicros: 175_000_000n,
          providerLimitMicros: 200_000_000n,
          providerUsageSyncedAt: new Date("2026-08-27T11:45:00.000Z"),
          providerUsageSyncError: null,
        },
      ],
    });

    await expect(reconcileBrandwellFleetHealth(prisma, now)).resolves.toMatchObject({
      candidates: 1,
    });
    expect(alertUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          type: "OPENROUTER_USAGE_SYNC_STALE",
          severity: "ERROR",
          brandwellActionRequired: true,
        }),
      }),
    );
  });

  it("does not raise a critical disabled-key incident for an intentionally paused Sidekick", async () => {
    const now = new Date("2026-08-27T12:00:00.000Z");
    const { prisma, alertUpsert } = fleetPrisma({
      sidekickCredentials: [
        {
          id: "credential-sidekick",
          workspaceId: "workspace-acme",
          externalKeyHash: "hash-sidekick",
          status: "disabled",
          disabledAt: new Date("2026-08-27T11:58:00.000Z"),
          currentUsageMicros: 10_000_000n,
          monthlyLimitMicros: 200_000_000n,
          warningLimitMicros: 150_000_000n,
          providerLimitMicros: 200_000_000n,
          providerUsageSyncedAt: now,
          providerUsageSyncError: null,
          sidekick: {
            botId: "bot-sidekick",
            email: "casey@example.test",
            status: "paused",
          },
        },
      ],
    });

    await expect(reconcileBrandwellFleetHealth(prisma, now)).resolves.toMatchObject({
      candidates: 0,
    });
    expect(alertUpsert).not.toHaveBeenCalled();
  });

  it("alerts BrandWell when the provider limit drifts from the managed budget", async () => {
    const now = new Date("2026-08-27T12:00:00.000Z");
    const { prisma, alertUpsert } = fleetPrisma({
      credentials: [
        {
          id: "credential-acme",
          workspaceId: "workspace-acme",
          externalKeyHash: "hash-acme",
          status: "active",
          disabledAt: null,
          currentUsageMicros: 10_000_000n,
          monthlyLimitMicros: 200_000_000n,
          warningLimitMicros: 175_000_000n,
          providerLimitMicros: 250_000_000n,
          providerUsageSyncedAt: new Date("2026-08-27T11:59:00.000Z"),
          providerUsageSyncError: null,
        },
      ],
    });

    await expect(reconcileBrandwellFleetHealth(prisma, now)).resolves.toMatchObject({
      candidates: 1,
    });
    expect(alertUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          type: "OPENROUTER_LIMIT_DRIFT",
          severity: "CRITICAL",
          technicalDetails: expect.objectContaining({
            managedLimitMicros: "200000000",
            providerLimitMicros: "250000000",
          }),
        }),
      }),
    );
  });

  it.each([
    {
      name: "reset period",
      providerLimitReset: "daily",
      providerIncludeByokInLimit: true,
    },
    {
      name: "BYOK inclusion",
      providerLimitReset: "monthly",
      providerIncludeByokInLimit: false,
    },
  ])("alerts when provider $name drifts with the same dollar limit", async (providerPolicy) => {
    const now = new Date("2026-08-27T12:00:00.000Z");
    const { prisma, alertUpsert } = fleetPrisma({
      credentials: [
        {
          id: "credential-acme",
          workspaceId: "workspace-acme",
          externalKeyHash: "hash-acme",
          status: "active",
          disabledAt: null,
          currentUsageMicros: 10_000_000n,
          monthlyLimitMicros: 200_000_000n,
          limitReset: "monthly",
          warningLimitMicros: 175_000_000n,
          providerLimitMicros: 200_000_000n,
          providerLimitReset: providerPolicy.providerLimitReset,
          providerIncludeByokInLimit: providerPolicy.providerIncludeByokInLimit,
          providerUsageSyncedAt: now,
          providerUsageSyncError: null,
        },
      ],
    });

    await expect(reconcileBrandwellFleetHealth(prisma, now)).resolves.toMatchObject({
      candidates: 1,
    });
    expect(alertUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          type: "OPENROUTER_LIMIT_DRIFT",
          severity: "CRITICAL",
          technicalDetails: expect.objectContaining({
            managedLimitReset: "monthly",
            providerLimitReset: providerPolicy.providerLimitReset,
            providerIncludeByokInLimit: providerPolicy.providerIncludeByokInLimit,
          }),
        }),
      }),
    );
  });
});
