import { describe, expect, it, vi } from "vitest";
import {
  buildCancellationLifecycle,
  executeBrandwellCancellation,
  executeBrandwellRetentionCleanup,
} from "./cancellation.js";

describe("BrandWell cancellation lifecycle", () => {
  it("disables execution immediately and defers destructive cleanup", () => {
    const now = new Date("2026-08-27T12:00:00.000Z");
    const lifecycle = buildCancellationLifecycle(now, {
      retentionDays: 30,
      deleteAfterRetention: true,
    });

    expect(lifecycle.immediate).toEqual([
      "mark_canceling",
      "pause_routines",
      "block_new_runs",
      "disable_openrouter",
      "suspend_computer",
    ]);
    expect(lifecycle.retentionEndsAt.toISOString()).toBe("2026-09-26T12:00:00.000Z");
    expect(lifecycle.afterRetention).toEqual([
      "delete_openrouter",
      "revoke_connectors",
      "destroy_computer",
      "delete_secrets",
      "archive_workspace",
    ]);
  });

  it("runs immediate actions once and schedules durable retention cleanup", async () => {
    const completed = new Set<string>(["pause_routines"]);
    const execute = vi.fn(async (action: string) => {
      completed.add(action);
    });
    const scheduleRetentionCleanup = vi.fn(async () => undefined);
    const result = await executeBrandwellCancellation(
      new Date("2026-08-27T12:00:00.000Z"),
      { retentionDays: 30, deleteAfterRetention: true },
      {
        completed: async (action) => completed.has(action),
        execute,
        scheduleRetentionCleanup,
      },
    );

    expect(result.executed).toEqual([
      "mark_canceling",
      "block_new_runs",
      "disable_openrouter",
      "suspend_computer",
    ]);
    expect(scheduleRetentionCleanup).toHaveBeenCalledWith(new Date("2026-09-26T12:00:00.000Z"));
  });

  it("performs destructive cleanup only when retention processing runs", async () => {
    const execute = vi.fn(async () => undefined);
    const actions = await executeBrandwellRetentionCleanup(
      new Date("2026-09-26T12:00:00.000Z"),
      { retentionDays: 0, deleteAfterRetention: true },
      {
        completed: async () => false,
        execute,
        scheduleRetentionCleanup: async () => undefined,
      },
    );
    expect(actions).toEqual([
      "delete_openrouter",
      "revoke_connectors",
      "destroy_computer",
      "delete_secrets",
      "archive_workspace",
    ]);
  });
});
