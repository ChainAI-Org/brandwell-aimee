import type { Actor } from "@rakazo/contracts";
import { RunsListOutputSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { listWorkspaceRuns } from "./runs.js";

const actor: Actor = {
  workspaceId: "workspace-1",
  userId: "client-1",
  email: "client@example.test",
  isDeploymentOwner: false,
};

describe("run activity access", () => {
  it.each(["active", "recent"] as const)(
    "scopes managed %s activity to the assigned employee, including service-owned runs",
    async (filter) => {
      const findMany = vi.fn().mockResolvedValue([]);
      const prisma = { run: { findMany } } as unknown as PrismaClient;
      await listWorkspaceRuns(prisma, { ...actor, botId: "assigned-bot" }, filter);
      const where = findMany.mock.calls[0][0].where;
      expect(where.workspaceId).toBe(actor.workspaceId);
      expect(where.botId).toBe("assigned-bot");
      expect(where.bot).toEqual({ archivedAt: null });
      expect(where).not.toHaveProperty("userId");
    },
  );

  it("keeps unassigned users restricted to their own runs", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { run: { findMany } } as unknown as PrismaClient;
    await listWorkspaceRuns(prisma, actor, "recent");
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      bot: { archivedAt: null },
    });
    expect(findMany.mock.calls[0][0].where).not.toHaveProperty("botId");
  });

  it("returns contract-valid failed BrandWell activity without changing its outcome", async () => {
    const completedAt = new Date("2026-09-01T12:00:00Z");
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "run-1",
        botId: "assigned-bot",
        threadId: "thread-1",
        userId: "service-user",
        status: "failed",
        trigger: "brandwell_outreach_review",
        completedAt,
        updatedAt: completedAt,
        bot: { name: "AIMEE", archivedAt: null },
        task: { prompt: "Review the local test visitor" },
        thread: { groupId: null, group: null },
      },
    ]);
    const prisma = { run: { findMany } } as unknown as PrismaClient;
    const runs = await listWorkspaceRuns(prisma, { ...actor, botId: "assigned-bot" }, "recent");
    expect(RunsListOutputSchema.safeParse({ runs }).success).toBe(true);
    expect(runs[0]).toMatchObject({ status: "failed", trigger: "brandwell_outreach_review" });
    expect(findMany.mock.calls[0][0].take).toBe(20);
  });
});
