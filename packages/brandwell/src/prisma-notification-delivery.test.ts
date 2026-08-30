import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { deliverPendingBrandwellClientNotifications } from "./prisma-notification-delivery.js";

const notice = {
  id: "notice-1",
  workspaceId: "workspace-1",
  botId: "bot-1",
  runId: "run-1",
  dedupeKey: "alert:login",
  type: "LOGIN_REQUIRED",
  title: "AIMEE needs your help",
  body: "Complete the login so work can continue.",
  severity: "WARNING",
  requiresAction: true,
  actionType: "OPEN_COMPUTER",
  actionTarget: "/computer?botId=bot-1",
  createdAt: new Date("2026-08-27T18:00:00.000Z"),
  readAt: null,
  resolvedAt: null,
  resolvedBy: null,
  pushDeliveryStatus: "pending",
  pushDeliveryAttempts: 0,
  pushDeliveryNextAt: new Date("2026-08-27T18:00:00.000Z"),
  pushDeliveryLeaseOwner: null,
  pushDeliveryLeaseExpiresAt: null,
  pushDeliveryLastError: null,
  pushSentAt: null,
};

describe("BrandWell client notification delivery", () => {
  it("claims once, honors workspace preferences, and sends an actionable deep link", async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      brandwellClientNotification: {
        findMany: vi.fn().mockResolvedValue([notice]),
        updateMany,
      },
      bot: {
        findFirst: vi.fn().mockResolvedValue({ id: "bot-1", thread: { id: "thread-1" } }),
      },
      member: {
        findMany: vi.fn().mockResolvedValue([{ userId: "user-1" }, { userId: "user-2" }]),
      },
      notificationPreference: {
        findMany: vi.fn().mockResolvedValue([
          { userId: "user-1", finish: true, help: true, takeover: true },
          { userId: "user-2", finish: true, help: true, takeover: false },
        ]),
      },
    } as unknown as PrismaClient;
    const result = await deliverPendingBrandwellClientNotifications(prisma, deliver, {
      workerId: "worker-1",
      now: new Date("2026-08-27T18:01:00.000Z"),
    });
    expect(result).toMatchObject({ scanned: 1, claimed: 1, sent: 1, retry: 0 });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        notificationId: "notice-1",
        userId: "user-1",
        kind: "takeover",
        actionTarget: "/computer?botId=bot-1",
      }),
    );
    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          pushDeliveryStatus: "sent",
          pushDeliveryLeaseOwner: null,
        }),
      }),
    );
  });

  it("backs off a fully failed delivery and leaves the notice available in app", async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const prisma = {
      brandwellClientNotification: {
        findMany: vi.fn().mockResolvedValue([notice]),
        updateMany,
      },
      bot: {
        findFirst: vi.fn().mockResolvedValue({ id: "bot-1", thread: { id: "thread-1" } }),
      },
      member: { findMany: vi.fn().mockResolvedValue([{ userId: "user-1" }]) },
      notificationPreference: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;
    const result = await deliverPendingBrandwellClientNotifications(
      prisma,
      vi.fn().mockRejectedValue(new Error("Expo unavailable")),
      { workerId: "worker-1", now: new Date("2026-08-27T18:01:00.000Z") },
    );
    expect(result.retry).toBe(1);
    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          pushDeliveryStatus: "retry",
          pushDeliveryLastError: "Every push delivery failed.",
        }),
      }),
    );
  });
});
