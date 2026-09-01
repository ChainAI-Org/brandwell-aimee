import { describe, expect, it } from "vitest";
import { AIMEE_SCREEN_STATE_MESSAGE, readAimeeScreenStateMessage } from "./screen-connection.js";

describe("AIMEE screen connection messages", () => {
  it.each(["connecting", "connected", "disconnected"] as const)("accepts the %s state", (state) => {
    expect(readAimeeScreenStateMessage({ type: AIMEE_SCREEN_STATE_MESSAGE, state })).toEqual({
      type: AIMEE_SCREEN_STATE_MESSAGE,
      state,
    });
  });

  it("rejects unrelated or malformed window messages", () => {
    expect(readAimeeScreenStateMessage(null)).toBeNull();
    expect(readAimeeScreenStateMessage({ type: "other", state: "connected" })).toBeNull();
    expect(
      readAimeeScreenStateMessage({ type: AIMEE_SCREEN_STATE_MESSAGE, state: "running" }),
    ).toBeNull();
  });
});
