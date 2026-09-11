import { describe, expect, it } from "vitest";
import { managedRunAttention, runChatDestination } from "./managed-run-status";

const idle = { notifications: [], activeRuns: [], recentRuns: [] };

describe("managed task status", () => {
  it("flags the latest failed task even though failed tasks are not active", () => {
    expect(
      managedRunAttention({
        ...idle,
        recentRuns: [{ status: "failed", updatedAt: "2026-09-11T12:00:00Z" }],
      }),
    ).toBe("The latest task failed. Review activity");
  });

  it("does not keep warning about an older failure after a newer success", () => {
    expect(
      managedRunAttention({
        ...idle,
        recentRuns: [
          { status: "failed", updatedAt: "2026-09-10T12:00:00Z" },
          { status: "completed", updatedAt: "2026-09-11T12:00:00Z" },
        ],
      }),
    ).toBeNull();
  });

  it.each(["waiting_input", "waiting_takeover"] as const)(
    "explains a task needing %s",
    (status) => {
      expect(managedRunAttention({ ...idle, activeRuns: [{ status }] })).toBe(
        "A run is waiting for input",
      );
    },
  );

  it("prioritizes outstanding notifications and ignores resolved ones", () => {
    expect(
      managedRunAttention({
        ...idle,
        notifications: [{ requiresAction: true, resolvedAt: null }],
      }),
    ).toBe("An action needs your review");
    expect(
      managedRunAttention({
        ...idle,
        notifications: [{ requiresAction: true, resolvedAt: "2026-09-11T12:00:00Z" }],
      }),
    ).toBeNull();
    expect(managedRunAttention(idle)).toBeNull();
  });

  it("opens the task's exact conversation instead of the currently selected chat", () => {
    expect(runChatDestination({ botId: "bot-1", threadId: "task-2", groupId: null })).toBe(
      "/app/bot-1?thread=task-2",
    );
    expect(runChatDestination({ botId: "bot-1", threadId: "thread&2", groupId: null })).toBe(
      "/app/bot-1?thread=thread%262",
    );
  });

  it("keeps group activity in its group conversation", () => {
    expect(runChatDestination({ botId: "bot-1", threadId: "task-2", groupId: "group-2" })).toBe(
      "/app/g/group-2",
    );
  });
});
