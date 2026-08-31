import { afterEach, describe, expect, it, vi } from "vitest";
import {
  publishBrandwellWorkerHeartbeat,
  startBrandwellWorkerHeartbeat,
} from "./worker-readiness.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("BrandWell worker readiness heartbeat", () => {
  it("publishes an initial signal, refreshes it, and removes it on graceful stop", async () => {
    vi.useFakeTimers();
    const upsert = vi.fn(async (_input: unknown) => undefined);
    const deleteMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      brandwellWorkerHeartbeat: { upsert, deleteMany },
    } as never;
    let now = new Date("2026-08-31T01:00:00.000Z");

    const heartbeat = await startBrandwellWorkerHeartbeat(prisma, {
      workerId: "worker:test:1",
      revision: "a".repeat(40),
      intervalMs: 1_000,
      now: () => now,
    });

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: "worker:test:1" },
        create: expect.objectContaining({
          revision: "a".repeat(40),
          heartbeatAt: now,
        }),
      }),
    );

    now = new Date("2026-08-31T01:00:01.000Z");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ heartbeatAt: now }) }),
    );

    await heartbeat.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: "worker:test:1" } });
  });

  it("does not claim readiness when the initial database write fails", async () => {
    const error = new Error("database unavailable");
    const prisma = {
      brandwellWorkerHeartbeat: {
        upsert: vi.fn(async () => Promise.reject(error)),
      },
    } as never;

    await expect(
      startBrandwellWorkerHeartbeat(prisma, {
        workerId: "worker:test:2",
      }),
    ).rejects.toBe(error);
  });

  it("stores only worker identity, revision, and timestamps", async () => {
    const upsert = vi.fn(async (_input: unknown) => undefined);
    const at = new Date("2026-08-31T01:00:00.000Z");
    await publishBrandwellWorkerHeartbeat({ brandwellWorkerHeartbeat: { upsert } } as never, {
      workerId: "worker:test:3",
      revision: "b".repeat(40),
      now: () => at,
    });

    expect(upsert.mock.calls[0]?.[0]).toEqual({
      where: { id: "worker:test:3" },
      create: {
        id: "worker:test:3",
        revision: "b".repeat(40),
        heartbeatAt: at,
      },
      update: {
        revision: "b".repeat(40),
        heartbeatAt: at,
      },
    });
  });
});
