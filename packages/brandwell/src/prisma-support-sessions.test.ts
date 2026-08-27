import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { reconcileBrandwellSupportSessions } from "./prisma-support-sessions.js";

const now = new Date("2026-08-27T18:30:00.000Z");

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: "support-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    botId: "bot-1",
    operatorReference: "user:42",
    controlLeaseId: "lease-1",
    controlLeaseExpiresAt: new Date("2026-08-27T18:15:00.000Z"),
    startedAt: new Date("2026-08-27T18:00:00.000Z"),
    status: "active",
    ...overrides,
  };
}

describe("BrandWell support session reconciliation", () => {
  it("keeps the session open while its operator lease is current", async () => {
    const updateMany = vi.fn();
    const prisma = {
      brandwellSupportSession: { findMany: vi.fn(async () => [session()]), updateMany },
      computer: {
        findMany: vi.fn(async () => [
          {
            id: "computer-1",
            controlLeaseId: "lease-1",
            controlLeaseExpiresAt: new Date("2026-08-27T18:45:00.000Z"),
            controlActorType: "brandwell_operator",
          },
        ]),
      },
    } as unknown as PrismaClient;

    await expect(reconcileBrandwellSupportSessions(prisma, now)).resolves.toEqual({
      scanned: 1,
      closed: 0,
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("closes and audits an expired session after its control lease ends", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const auditCreate = vi.fn(async () => ({ id: "audit-1" }));
    const prisma = {
      brandwellSupportSession: { findMany: vi.fn(async () => [session()]), updateMany },
      computer: {
        findMany: vi.fn(async () => [
          {
            id: "computer-1",
            controlLeaseId: null,
            controlLeaseExpiresAt: null,
            controlActorType: null,
          },
        ]),
      },
      brandwellAuditLog: { create: auditCreate },
    } as unknown as PrismaClient;

    await expect(reconcileBrandwellSupportSessions(prisma, now)).resolves.toEqual({
      scanned: 1,
      closed: 1,
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "expired" }) }),
    );
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "computer.support_expired" }),
      }),
    );
  });
});
