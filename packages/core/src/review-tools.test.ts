import { describe, expect, it } from "vitest";
import { reviewPreparationToolAllowed } from "./review-tools.js";

describe("review preparation tools", () => {
  it("allows read-only research without granting sending or indirect execution", () => {
    expect(reviewPreparationToolAllowed("search_profiles", true)).toBe(true);
    expect(reviewPreparationToolAllowed("read_file", false)).toBe(true);
    for (const name of [
      "linkedin_send_message",
      "computer_act",
      "shell",
      "write_file",
      "run_subagent",
      "spawn_bot",
      "schedule_create",
      "destination.write",
    ]) {
      expect(reviewPreparationToolAllowed(name, false)).toBe(false);
    }
  });
});
