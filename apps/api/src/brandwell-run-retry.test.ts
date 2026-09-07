import type { PrismaClient } from "@rakazo/db";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { mountBrandwellManagementRoutes } from "./brandwell-management.js";

function fixture() {
  const saved = {
    id: "run-1",
    workspaceId: "workspace-1",
    taskId: "task-1",
    botId: "bot-1",
    status: "failed",
    retryNonces: [] as string[],
    updatedAt: new Date("2026-09-07T12:00:00Z"),
  };
  let resets = 0;
  const findFirst = vi.fn(async () => ({ ...saved }));
  const updateMany = vi.fn(async ({ where, data }) => {
    if (saved.status !== where.status || saved.updatedAt.getTime() !== where.updatedAt.getTime())
      return { count: 0 };
    Object.assign(saved, data, {
      retryNonces: data.retryNonces
        ? [...saved.retryNonces, data.retryNonces.push]
        : saved.retryNonces,
      updatedAt: new Date(saved.updatedAt.getTime() + 1),
    });
    resets += 1;
    return { count: 1 };
  });
  const audit = vi.fn(async () => ({}));
  const taskUpdate = vi.fn(async () => ({}));
  const prisma = {
    run: { findFirst },
    $transaction: vi.fn(async (callback) =>
      callback({
        run: { updateMany },
        task: { update: taskUpdate },
        brandwellAuditLog: { create: audit },
      }),
    ),
  };
  const enqueue = vi.fn(async () => undefined);
  const app = new Hono();
  mountBrandwellManagementRoutes(app, {
    token: "management-secret",
    prisma: prisma as unknown as PrismaClient,
    jobs: { enqueue } as never,
  });
  const request = (key = "retry-key-1") =>
    app.request("/internal/runs/run-1/retry", {
      method: "POST",
      headers: {
        authorization: "Bearer management-secret",
        "x-brandwell-operator-ref": "user:42",
        "x-brandwell-operator-name": "Test User",
        "x-idempotency-key": key,
      },
    });
  return { request, saved, enqueue, audit, taskUpdate, resets: () => resets };
}

describe("durable managed run retry", () => {
  it("reports lost dispatch and recovers it with the same retry identity", async () => {
    const f = fixture();
    f.enqueue.mockRejectedValueOnce(new Error("Publisher unavailable"));
    const first = await f.request();
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({ accepted: true, runId: "run-1", status: "queued" });
    expect(f.saved.status).toBe("queued");
    const replay = await f.request();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({
      ok: true,
      runId: "run-1",
      status: "queued",
      replayed: true,
    });
    expect(f.resets()).toBe(1);
    expect(f.enqueue).toHaveBeenCalledTimes(2);
    expect(f.taskUpdate).toHaveBeenCalledTimes(1);
    expect(f.audit).toHaveBeenCalledTimes(1);
  });

  it("does not reset a progressed run on replay and requires a fresh retry after a new failure", async () => {
    const f = fixture();
    await f.request();
    for (const status of ["running", "waiting_input", "completed", "failed", "cancelled"]) {
      f.saved.status = status;
      const replay = await f.request();
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ status, replayed: true });
    }
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(f.resets()).toBe(1);
    expect((await f.request("retry-key-2")).status).toBe(409);
    f.saved.status = "failed";
    expect((await f.request("retry-key-2")).status).toBe(200);
    expect(f.resets()).toBe(2);
    f.saved.status = "failed";
    expect(await (await f.request("retry-key-1")).json()).toMatchObject({
      status: "failed",
      replayed: true,
    });
    expect(f.resets()).toBe(2);
  });

  it("resets a concurrent same-key retry once", async () => {
    const f = fixture();
    const responses = await Promise.all([f.request(), f.request()]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(f.resets()).toBe(1);
    expect(f.audit).toHaveBeenCalledTimes(1);
  });
});
