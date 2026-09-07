import { describe, expect, it } from "vitest";
import { reviewPreparationToolAllowed, socialReviewUpdateAllowed } from "./review-tools.js";

describe("review preparation tools", () => {
  it("binds review updates to the persisted opportunity and denies new claims", () => {
    const recordId = "b15e3b32-2be5-4d0f-9da7-cf1609b9167b";
    for (const action of ["review", "skip", "complete"]) {
      expect(socialReviewUpdateAllowed({ record_id: recordId, action }, recordId)).toBe(true);
      expect(socialReviewUpdateAllowed({ record_id: "another-record", action }, recordId)).toBe(
        false,
      );
    }
    expect(socialReviewUpdateAllowed({ record_id: recordId, action: "claim" }, recordId)).toBe(
      false,
    );
    expect(socialReviewUpdateAllowed({ record_id: recordId, action: "review" }, null)).toBe(false);
    expect(socialReviewUpdateAllowed({ action: "review" }, recordId)).toBe(false);
  });
  it("allows social review state only in a SocialStreams review task", () => {
    expect(reviewPreparationToolAllowed("brandwell_socialstreams_update_opportunity", false)).toBe(
      false,
    );
    expect(
      reviewPreparationToolAllowed("brandwell_socialstreams_update_opportunity", false, true),
    ).toBe(true);
    for (const name of [
      "brandwell_socialstreams_queue_outreach",
      "linkedin_send_message",
      "shell",
      "computer_act",
    ]) {
      expect(reviewPreparationToolAllowed(name, false, true)).toBe(false);
    }
  });
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
