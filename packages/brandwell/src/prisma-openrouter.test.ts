import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  OPENROUTER_RECONCILIATION_KEY_BATCH_SIZE,
  OPENROUTER_RECONCILIATION_WORKSPACE_CONCURRENCY,
  reconcileBrandwellOpenRouterUsage,
} from "./prisma-openrouter.js";

type Credential = {
  id: string;
  workspaceId: string;
  externalKeyHash: string;
  limitReset: string;
  status: string;
};

function reconciliationPrisma(input: { workspace?: Credential[]; sidekick?: Credential[] }) {
  const workspace = input.workspace ?? [];
  const sidekick = input.sidekick ?? [];
  const leaseOwners = new Map<string, string>();
  const workspaceUpdate = vi.fn(async () => ({}));
  const sidekickUpdate = vi.fn(async () => ({}));
  const mappingIdByWorkspace = new Map(
    [...new Set([...workspace, ...sidekick].map((credential) => credential.workspaceId))].map(
      (workspaceId) => [workspaceId, `mapping:${workspaceId}`],
    ),
  );
  const prisma = {
    brandwellAiWorkspace: {
      findMany: vi.fn(async () =>
        [...mappingIdByWorkspace].map(([rakazoWorkspaceId, id]) => ({
          id,
          rakazoWorkspaceId,
        })),
      ),
      updateMany: vi.fn(
        async (args: {
          where: { id: string; modelPolicyLeaseOwner?: string };
          data: { modelPolicyLeaseOwner?: string | null };
        }) => {
          const mappingId = String(args.where.id);
          const expectedOwner = args.where.modelPolicyLeaseOwner as string | undefined;
          const currentOwner = leaseOwners.get(mappingId);
          if (expectedOwner !== undefined) {
            if (currentOwner !== expectedOwner) return { count: 0 };
            if (args.data.modelPolicyLeaseOwner === null) leaseOwners.delete(mappingId);
            return { count: 1 };
          }
          if (currentOwner) return { count: 0 };
          leaseOwners.set(mappingId, String(args.data.modelPolicyLeaseOwner));
          return { count: 1 };
        },
      ),
    },
    brandwellWorkspaceModelCredential: {
      findMany: vi.fn(async () => workspace),
      update: workspaceUpdate,
    },
    brandwellSidekickModelCredential: {
      findMany: vi.fn(async () => sidekick),
      update: sidekickUpdate,
    },
  } as unknown as PrismaClient;
  return { prisma, workspaceUpdate, sidekickUpdate };
}

function credential(id: string, workspaceId = "workspace-1"): Credential {
  return {
    id,
    workspaceId,
    externalKeyHash: `hash:${id}`,
    limitReset: "monthly",
    status: "active",
  };
}

describe("BrandWell OpenRouter usage reconciliation", () => {
  it("stores provider usage, limit policy metadata, and disabled state", async () => {
    const { prisma, workspaceUpdate } = reconciliationPrisma({
      workspace: [credential("credential-1")],
    });
    const getKey = vi.fn(async () => ({
      hash: "hash:credential-1",
      disabled: true,
      usageUsd: 28,
      usageDailyUsd: 3,
      usageMonthlyUsd: 12.3456789,
      limitUsd: 250,
      limitReset: "monthly" as const,
      includeByokInLimit: true,
    }));

    await expect(
      reconcileBrandwellOpenRouterUsage(prisma, { getKey }, "workspace-1"),
    ).resolves.toEqual({ checked: 1, updated: 1, failed: 0 });
    expect(workspaceUpdate).toHaveBeenCalledWith({
      where: { id: "credential-1" },
      data: expect.objectContaining({
        currentUsageMicros: 12_345_679n,
        providerLimitMicros: 250_000_000n,
        providerLimitReset: "monthly",
        providerIncludeByokInLimit: true,
        providerUsageSyncError: null,
        status: "disabled",
      }),
    });
  });

  it("records a safe sync error without replacing the last known usage", async () => {
    const { prisma, workspaceUpdate } = reconciliationPrisma({
      workspace: [credential("credential-1")],
    });

    await expect(
      reconcileBrandwellOpenRouterUsage(prisma, {
        getKey: vi.fn(async () => {
          throw new Error("provider unavailable\ninternal detail");
        }),
      }),
    ).resolves.toEqual({ checked: 1, updated: 0, failed: 1 });
    expect(workspaceUpdate).toHaveBeenCalledWith({
      where: { id: "credential-1" },
      data: { providerUsageSyncError: "provider unavailable internal detail" },
    });
  });

  it("reconciles each Sidekick key inside its own workspace lease", async () => {
    const { prisma, sidekickUpdate } = reconciliationPrisma({
      sidekick: [credential("sidekick-credential-1")],
    });

    await expect(
      reconcileBrandwellOpenRouterUsage(prisma, {
        getKey: vi.fn(async () => ({
          hash: "hash:sidekick-credential-1",
          disabled: false,
          usageUsd: 8,
          usageDailyUsd: 1,
          usageMonthlyUsd: 7,
          limitUsd: 200,
          limitReset: "monthly" as const,
          includeByokInLimit: true,
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

  it("bounds provider traffic across tenant batches while still running concurrently", async () => {
    const workspace = [
      ...Array.from({ length: 4 }, (_, index) => credential(`a-${index}`, "workspace-a")),
      ...Array.from({ length: 4 }, (_, index) => credential(`b-${index}`, "workspace-b")),
      ...Array.from({ length: 2 }, (_, index) => credential(`c-${index}`, "workspace-c")),
    ];
    const { prisma } = reconciliationPrisma({ workspace });
    let active = 0;
    let maximumActive = 0;
    const getKey = vi.fn(async (hash: string) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return {
        hash,
        disabled: false,
        usageUsd: 1,
        usageDailyUsd: 1,
        usageMonthlyUsd: 1,
        limitUsd: 200,
        limitReset: "monthly" as const,
        includeByokInLimit: true,
      };
    });

    await expect(reconcileBrandwellOpenRouterUsage(prisma, { getKey })).resolves.toEqual({
      checked: workspace.length,
      updated: workspace.length,
      failed: 0,
    });
    expect(maximumActive).toBeGreaterThan(1);
    expect(maximumActive).toBeLessThanOrEqual(
      OPENROUTER_RECONCILIATION_WORKSPACE_CONCURRENCY * OPENROUTER_RECONCILIATION_KEY_BATCH_SIZE,
    );
  });

  it("lets only one replica sweep a tenant while its distributed lease is active", async () => {
    const { prisma } = reconciliationPrisma({ workspace: [credential("credential-1")] });
    let releaseProvider!: () => void;
    const providerBlocked = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let providerStarted!: () => void;
    const providerStart = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const getKey = vi.fn(async (hash: string) => {
      providerStarted();
      await providerBlocked;
      return {
        hash,
        disabled: false,
        usageUsd: 1,
        usageDailyUsd: 1,
        usageMonthlyUsd: 1,
        limitUsd: 200,
        limitReset: "monthly" as const,
        includeByokInLimit: true,
      };
    });

    const first = reconcileBrandwellOpenRouterUsage(prisma, { getKey });
    await providerStart;
    await expect(reconcileBrandwellOpenRouterUsage(prisma, { getKey })).resolves.toEqual({
      checked: 1,
      updated: 0,
      failed: 0,
    });
    releaseProvider();
    await expect(first).resolves.toEqual({ checked: 1, updated: 1, failed: 0 });
    expect(getKey).toHaveBeenCalledOnce();
  });
});
