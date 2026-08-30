import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { blockedAuthPaths, claimBrandwellInvitation } from "./index.js";

describe("auth policy", () => {
  it("blocks invitation and org-creation paths in version 1", () => {
    expect(blockedAuthPaths.some((p) => p.includes("invite"))).toBe(true);
    expect(blockedAuthPaths.some((p) => p.includes("create"))).toBe(true);
  });
});

describe("claimBrandwellInvitation", () => {
  it("claims the managed workspace invitation and creates client defaults", async () => {
    const memberUpsert = vi.fn(async () => undefined);
    const invitationUpdate = vi.fn(async () => undefined);
    const memoryFindFirst = vi.fn(async () => null);
    const memoryCreate = vi.fn(async () => undefined);
    const preferenceUpsert = vi.fn(async () => undefined);
    const tx = {
      member: { upsert: memberUpsert },
      invitation: { update: invitationUpdate },
      memoryDocument: { findFirst: memoryFindFirst, create: memoryCreate },
      notificationPreference: { upsert: preferenceUpsert },
      brandwellSidekick: { findFirst: vi.fn(async () => null) },
    };
    const prisma = {
      invitation: {
        findMany: vi.fn(async () => [
          {
            id: "invite-1",
            organizationId: "workspace-1",
            role: "owner",
            organization: { brandwellWorkspace: { id: "mapping-1" } },
          },
        ]),
      },
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
    } as unknown as PrismaClient;

    await expect(
      claimBrandwellInvitation(
        prisma,
        { id: "user-1", email: "client@example.com" },
        new Date("2026-08-27T18:00:00.000Z"),
      ),
    ).resolves.toBe("workspace-1");
    expect(memberUpsert).toHaveBeenCalledOnce();
    expect(invitationUpdate).toHaveBeenCalledWith({
      where: { id: "invite-1" },
      data: { status: "accepted" },
    });
    expect(memoryCreate).toHaveBeenCalledOnce();
    expect(preferenceUpsert).toHaveBeenCalledOnce();
  });

  it("does not claim an invitation outside a managed BrandWell workspace", async () => {
    const transaction = vi.fn();
    const prisma = {
      invitation: {
        findMany: vi.fn(async () => [
          {
            id: "invite-personal",
            organizationId: "workspace-personal",
            role: "owner",
            organization: { brandwellWorkspace: null },
          },
        ]),
      },
      $transaction: transaction,
    } as unknown as PrismaClient;

    await expect(
      claimBrandwellInvitation(prisma, { id: "user-1", email: "client@example.com" }),
    ).resolves.toBeNull();
    expect(transaction).not.toHaveBeenCalled();
  });
});
