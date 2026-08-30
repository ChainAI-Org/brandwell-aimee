import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  provisionBrandwellSidekickWithPrisma,
  setBrandwellSidekickLifecycleWithPrisma,
} from "./prisma-sidekicks.js";

function lifecyclePrisma() {
  const deleteCredential = vi.fn(async () => ({}));
  const deleteSecret = vi.fn(async () => ({}));
  const updateCredential = vi.fn(async () => ({}));
  const prisma = {
    brandwellSidekick: {
      findFirst: vi.fn(async () => ({
        id: "sidekick-1",
        brandwellSidekickId: "portal-sidekick-1",
        status: "active",
        userId: "user-1",
        botId: "bot-sidekick-1",
        computerId: "computer-sidekick-1",
        pausedAt: null,
        modelCredential: {
          id: "credential-sidekick-1",
          secretId: "secret-sidekick-1",
          externalKeyHash: "hash-sidekick-1",
        },
      })),
      update: vi.fn(async () => ({})),
    },
    bot: { update: vi.fn(async () => ({})) },
    routine: { updateMany: vi.fn(async () => ({ count: 0 })) },
    computer: { update: vi.fn(async () => ({})) },
    brandwellSidekickModelCredential: {
      update: updateCredential,
      delete: deleteCredential,
    },
    secret: { delete: deleteSecret },
    $transaction: vi.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
  };
  return {
    prisma: prisma as unknown as PrismaClient,
    deleteCredential,
    deleteSecret,
    updateCredential,
  };
}

describe("BrandWell Sidekick model-key lifecycle", () => {
  it("revokes only the canceled Sidekick key and removes only its stored credential", async () => {
    const { prisma, deleteCredential, deleteSecret } = lifecyclePrisma();
    const deleteKey = vi.fn(async () => undefined);

    await expect(
      setBrandwellSidekickLifecycleWithPrisma("portal-sidekick-1", "cancel", {
        prisma,
        openRouter: { deleteKey, updateKey: vi.fn() },
        now: () => new Date("2026-08-30T12:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ status: "canceled", botId: "bot-sidekick-1" });

    expect(deleteKey).toHaveBeenCalledOnce();
    expect(deleteKey).toHaveBeenCalledWith("hash-sidekick-1");
    expect(deleteCredential).toHaveBeenCalledWith({
      where: { id: "credential-sidekick-1" },
    });
    expect(deleteSecret).toHaveBeenCalledWith({ where: { id: "secret-sidekick-1" } });
  });

  it("disables a paused Sidekick key without deleting it", async () => {
    const { prisma, deleteCredential, updateCredential } = lifecyclePrisma();
    const updateKey = vi.fn(async () => ({}) as never);

    await setBrandwellSidekickLifecycleWithPrisma("portal-sidekick-1", "pause", {
      prisma,
      openRouter: { deleteKey: vi.fn(), updateKey },
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    });

    expect(updateKey).toHaveBeenCalledWith("hash-sidekick-1", { disabled: true });
    expect(updateCredential).toHaveBeenCalledWith({
      where: { id: "credential-sidekick-1" },
      data: {
        status: "disabled",
        disabledAt: new Date("2026-08-30T12:00:00.000Z"),
      },
    });
    expect(deleteCredential).not.toHaveBeenCalled();
  });

  it("does not recreate a key for a canceled Sidekick provisioning identity", async () => {
    const createKey = vi.fn();
    const prisma = {
      brandwellAiWorkspace: {
        findFirst: vi.fn(async () => ({ id: "mapping-1" })),
      },
      brandwellSidekick: {
        findUnique: vi.fn(async () => ({
          id: "sidekick-1",
          aiWorkspaceId: "mapping-1",
          email: "casey@example.com",
          status: "canceled",
          modelCredential: null,
          bot: null,
          computer: null,
        })),
      },
    } as unknown as PrismaClient;

    await expect(
      provisionBrandwellSidekickWithPrisma(
        "workspace-1",
        {
          brandwellSidekickId: "portal-sidekick-1",
          email: "casey@example.com",
          name: "Casey",
          roleTitle: "Sales",
          timezone: "America/Phoenix",
        },
        {
          prisma,
          secretCipher: { encrypt: vi.fn() },
          openRouter: { createKey, deleteKey: vi.fn() },
          sandboxKind: "daytona",
          defaultModel: "openai/gpt-5.4-mini",
          monthlyLimitMicros: 200_000_000n,
          warningLimitMicros: 150_000_000n,
        },
      ),
    ).rejects.toMatchObject({ code: "sidekick_canceled", statusCode: 409 });
    expect(createKey).not.toHaveBeenCalled();
  });
});
