import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { reconcileBrandwellOpenRouterUsage } from "./prisma-openrouter.js";

describe("BrandWell OpenRouter usage reconciliation", () => {
  it("stores the provider monthly usage, limit, and disabled state", async () => {
    const update = vi.fn(async () => ({ id: "credential-1" }));
    const sidekickUpdate = vi.fn(async () => ({ id: "sidekick-credential-1" }));
    const prisma = {
      brandwellWorkspaceModelCredential: {
        findMany: vi.fn(async () => [
          {
            id: "credential-1",
            externalKeyHash: "hash-acme",
            limitReset: "monthly",
            status: "active",
          },
        ]),
        update,
      },
      brandwellSidekickModelCredential: {
        findMany: vi.fn(async () => []),
        update: sidekickUpdate,
      },
    } as unknown as PrismaClient;
    const getKey = vi.fn(async () => ({
      hash: "hash-acme",
      disabled: true,
      usageUsd: 28,
      usageDailyUsd: 3,
      usageMonthlyUsd: 12.3456789,
      limitUsd: 250,
      limitReset: "monthly" as const,
    }));

    await expect(
      reconcileBrandwellOpenRouterUsage(prisma, { getKey }, "workspace-1"),
    ).resolves.toEqual({ checked: 1, updated: 1, failed: 0 });
    expect(getKey).toHaveBeenCalledWith("hash-acme");
    expect(update).toHaveBeenCalledWith({
      where: { id: "credential-1" },
      data: expect.objectContaining({
        currentUsageMicros: 12_345_679n,
        providerLimitMicros: 250_000_000n,
        providerUsageSyncError: null,
        status: "disabled",
      }),
    });
  });

  it("records a safe sync error without replacing the last known usage", async () => {
    const update = vi.fn(async () => ({ id: "credential-1" }));
    const prisma = {
      brandwellWorkspaceModelCredential: {
        findMany: vi.fn(async () => [
          {
            id: "credential-1",
            externalKeyHash: "hash-acme",
            limitReset: "monthly",
            status: "active",
          },
        ]),
        update,
      },
      brandwellSidekickModelCredential: {
        findMany: vi.fn(async () => []),
        update: vi.fn(async () => ({})),
      },
    } as unknown as PrismaClient;

    await expect(
      reconcileBrandwellOpenRouterUsage(prisma, {
        getKey: vi.fn(async () => {
          throw new Error("provider unavailable\ninternal detail");
        }),
      }),
    ).resolves.toEqual({ checked: 1, updated: 0, failed: 1 });
    expect(update).toHaveBeenCalledWith({
      where: { id: "credential-1" },
      data: { providerUsageSyncError: "provider unavailable internal detail" },
    });
  });

  it("reconciles each Sidekick key independently", async () => {
    const sidekickUpdate = vi.fn(async () => ({ id: "sidekick-credential-1" }));
    const prisma = {
      brandwellWorkspaceModelCredential: {
        findMany: vi.fn(async () => []),
        update: vi.fn(async () => ({})),
      },
      brandwellSidekickModelCredential: {
        findMany: vi.fn(async () => [
          {
            id: "sidekick-credential-1",
            externalKeyHash: "hash-sidekick",
            limitReset: "monthly",
            status: "active",
          },
        ]),
        update: sidekickUpdate,
      },
    } as unknown as PrismaClient;

    await expect(
      reconcileBrandwellOpenRouterUsage(prisma, {
        getKey: vi.fn(async () => ({
          hash: "hash-sidekick",
          disabled: false,
          usageUsd: 8,
          usageDailyUsd: 1,
          usageMonthlyUsd: 7,
          limitUsd: 200,
          limitReset: "monthly" as const,
        })),
      }),
    ).resolves.toEqual({ checked: 1, updated: 1, failed: 0 });
    expect(sidekickUpdate).toHaveBeenCalledWith({
      where: { id: "sidekick-credential-1" },
      data: expect.objectContaining({
        currentUsageMicros: 7_000_000n,
        providerLimitMicros: 200_000_000n,
      }),
    });
  });
});
