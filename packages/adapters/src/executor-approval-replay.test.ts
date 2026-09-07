import { describe, expect, it } from "vitest";
import { createApprovedEffectReplayQueue, restoreApprovedToolInput } from "./approval-effect.js";
import { APPROVED_EFFECT_REPLAY_ORDER, buildApprovalContinuation } from "./executor.js";

describe("executor approval replay", () => {
  it("rejects a different opportunity restored from an approved payload", () => {
    const name = "brandwell_socialstreams_update_opportunity";
    const assigned = "b15e3b32-2be5-4d0f-9da7-cf1609b9167b";
    const other = "ecec7644-2c7b-48e5-a988-4e52d5d6ab0a";
    const queue = createApprovedEffectReplayQueue([
      { kind: name, request: { record_id: other, action: "review" } },
    ]);
    const result = restoreApprovedToolInput(
      queue,
      name,
      { record_id: assigned, action: "review" },
      {
        socialReview: true,
        socialRecordId: assigned,
      },
    );
    expect(result).toMatchObject({ ok: false });
    expect(result).not.toHaveProperty("args");
    expect(queue.assertDrained).not.toThrow();
  });

  it("checks the actual approved input rather than the model's reconstructed arguments", () => {
    const name = "brandwell_socialstreams_update_opportunity";
    const assigned = "b15e3b32-2be5-4d0f-9da7-cf1609b9167b";
    const approved = { record_id: assigned, action: "review" };
    const queue = createApprovedEffectReplayQueue([{ kind: name, request: approved }]);
    expect(
      restoreApprovedToolInput(
        queue,
        name,
        { record_id: "another-record", action: "claim" },
        {
          socialReview: true,
          socialRecordId: assigned,
        },
      ),
    ).toEqual({ ok: true, args: approved });
  });
  it("lists and replays every approved request in FIFO order when a tool repeats", () => {
    const effects = [
      { kind: "destination.write", request: { sequence: 1 } },
      { kind: "destination.write", request: { sequence: 2 } },
    ];

    const continuation = buildApprovalContinuation(effects, JSON.stringify);
    expect(continuation).toContain(
      "Call each listed approved request exactly once, in the listed order",
    );
    expect(continuation?.indexOf('{"sequence":1}')).toBeLessThan(
      continuation?.indexOf('{"sequence":2}') ?? -1,
    );

    const queue = createApprovedEffectReplayQueue(effects);
    expect(queue.take("destination.write")).toEqual({ sequence: 1 });
    expect(queue.assertDrained).toThrow("Approved tool requests were not fully replayed");
    expect(queue.take("destination.write")).toEqual({ sequence: 2 });
    expect(queue.take("destination.write")).toBeUndefined();
    expect(queue.assertDrained).not.toThrow();
  });

  it("uses a stable secondary key when approval timestamps match", () => {
    expect(APPROVED_EFFECT_REPLAY_ORDER).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
  });
});
