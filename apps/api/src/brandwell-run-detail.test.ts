import type { PrismaClient } from "@rakazo/db";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { mountBrandwellManagementRoutes } from "./brandwell-management.js";

const headers = {
  authorization: "Bearer management-secret",
  "x-brandwell-operator-ref": "user:42",
  "x-brandwell-operator-name": "Test User",
};

function fixture() {
  const timestamp = new Date("2026-09-07T12:00:00Z");
  const saved = {
    id: "run-1",
    botId: "bot-1",
    taskId: "task-1",
    threadId: "historical-thread-1",
    status: "completed",
    trigger: "brandwell_socialstreams_review",
    createdAt: timestamp,
    startedAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
    error: null as string | null,
  };
  const mappingFind = vi.fn(async () => ({ rakazoWorkspaceId: "workspace-1" }));
  const runFind = vi.fn(async ({ where }) =>
    where.id === saved.id && where.workspaceId === "workspace-1" ? saved : null,
  );
  const savedMessage = {
    id: "message-1",
    role: "bot",
    blocks: [
      { kind: "text", text: "Reviewed the original post. Draft saved.\u0000\u0007" },
      { kind: "text", text: "management-secret" },
      { kind: "tool_call", args: { password: "tool-secret" }, result: "private tool output" },
      { kind: "image", data: "private-image-bytes" },
      { kind: "text", text: "x".repeat(5_000) },
    ],
  };
  const messageFind = vi.fn(async ({ where }) =>
    where.role.in.includes(savedMessage.role)
      ? { id: savedMessage.id, blocks: savedMessage.blocks }
      : null,
  );
  const audit = vi.fn(async () => ({}));
  const prisma = {
    brandwellAiWorkspace: { findFirst: mappingFind },
    run: { findFirst: runFind },
    message: { findFirst: messageFind },
    brandwellAuditLog: { create: audit },
  };
  const app = new Hono();
  mountBrandwellManagementRoutes(app, {
    token: "management-secret",
    prisma: prisma as unknown as PrismaClient,
  });
  const request = (workspace = "workspace-1", run = "run-1", auth = headers) =>
    app.request(`/internal/workspaces/${workspace}/runs/${run}`, { headers: auth });
  return { request, saved, mappingFind, runFind, messageFind, audit };
}

describe("BrandWell exact run status", () => {
  it("returns bounded lifecycle and sanitized output for a historical run", async () => {
    const f = fixture();
    const response = await f.request();
    expect(response.status).toBe(200);
    const { run } = await response.json();
    expect(run).toMatchObject({
      id: "run-1",
      botId: "bot-1",
      taskId: "task-1",
      threadId: "historical-thread-1",
      status: "completed",
      trigger: "brandwell_socialstreams_review",
      messageId: "message-1",
      error: null,
      completedAt: "2026-09-07T12:00:00.000Z",
    });
    expect(run.outcome).toContain("Draft saved.");
    expect(run.outcome).toContain("[redacted]");
    expect(run.outcome.length).toBeLessThanOrEqual(4_000);
    expect(JSON.stringify(run)).not.toMatch(
      /management-secret|tool-secret|private-image|private tool/,
    );
    expect(run.outcome).not.toContain(String.fromCharCode(0));
    expect(run.outcome).not.toContain(String.fromCharCode(7));
    expect(f.runFind).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "run-1", workspaceId: "workspace-1" } }),
    );
    expect(f.messageFind).toHaveBeenCalledWith({
      where: {
        runId: "run-1",
        threadId: "historical-thread-1",
        role: { in: ["bot", "assistant", "aimee"] },
        createdAt: { gte: f.saved.startedAt },
      },
      orderBy: { seq: "desc" },
      select: { id: true, blocks: true },
    });
    expect(f.audit).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "run.inspect" }) }),
    );
  });

  it("does not disclose a different workspace's run or its messages", async () => {
    const f = fixture();
    f.mappingFind.mockResolvedValueOnce({ rakazoWorkspaceId: "other-workspace" });
    expect((await f.request("other-workspace")).status).toBe(404);
    expect(f.messageFind).not.toHaveBeenCalled();
    expect(f.audit).not.toHaveBeenCalled();
    expect((await f.request("workspace-1", "missing-run")).status).toBe(404);
  });

  it("requires authentication, operator attribution, and a mapped workspace", async () => {
    const f = fixture();
    expect((await f.request("workspace-1", "run-1", {} as typeof headers)).status).toBe(401);
    expect(
      (
        await f.request("workspace-1", "run-1", {
          authorization: headers.authorization,
        } as typeof headers)
      ).status,
    ).toBe(400);
    f.mappingFind.mockResolvedValueOnce(null as never);
    expect((await f.request("unknown-workspace")).status).toBe(404);
    expect(f.runFind).not.toHaveBeenCalled();
  });

  it("reports a failed run without inventing an output or exposing internal fields", async () => {
    const f = fixture();
    f.saved.status = "failed";
    f.saved.error = "Provider unavailable: management-secret\u0000\u0007";
    f.messageFind.mockResolvedValueOnce(null as never);
    const { run } = await (await f.request()).json();
    expect(run).toMatchObject({
      status: "failed",
      error: "Provider unavailable: [redacted]",
      outcome: null,
      messageId: null,
    });
    expect(f.runFind.mock.calls[0]?.[0].select).not.toHaveProperty("checkpoint");
    expect(f.runFind.mock.calls[0]?.[0].select).not.toHaveProperty("task");
  });

  it("does not show the previous attempt's output while a retry is queued", async () => {
    const f = fixture();
    f.saved.status = "queued";
    const { run } = await (await f.request()).json();
    expect(run).toMatchObject({ status: "queued", outcome: null, messageId: null });
    expect(f.messageFind).not.toHaveBeenCalled();
  });
});
