import { describe, expect, it } from "vitest";
import { placementReviewToolScopeError, reviewPreparationToolAllowed } from "./review-tools.js";

describe("placement review assignment", () => {
  const taskId = "b15e3b32-2be5-4d0f-9da7-cf1609b9167b";
  const opportunityId = "115e3b32-2be5-4d0f-9da7-cf1609b9167b";
  const scope = { kind: "link_builder", taskId, opportunityId };

  it("binds placement reads, updates and checks to the immutable assignment", () => {
    for (const tool of ["details", "update", "verify"]) {
      const name = `brandwell_link_builder_${tool}`;
      expect(placementReviewToolScopeError(name, { id: opportunityId }, scope)).toBeNull();
      expect(placementReviewToolScopeError(name, { id: taskId }, scope)).toContain(
        "assigned placement",
      );
    }
    expect(
      placementReviewToolScopeError("brandwell_link_builder_task", { id: taskId }, scope),
    ).toBeNull();
    expect(
      placementReviewToolScopeError("brandwell_link_builder_task", { id: opportunityId }, scope),
    ).toContain("assigned placement task");
  });

  it("fails closed for legacy or malformed assignments", () => {
    for (const invalid of [
      null,
      {},
      [],
      { ...scope, taskId: "-".repeat(36) },
      { ...scope, kind: "other" },
    ]) {
      expect(
        placementReviewToolScopeError("brandwell_link_builder_task", { id: taskId }, invalid),
      ).toContain("no valid assignment");
    }
  });

  it("allows project research and unrelated read-only tools without widening mutation access", () => {
    expect(placementReviewToolScopeError("brandwell_link_builder_workspace", {}, scope)).toBeNull();
    expect(placementReviewToolScopeError("brandwell_link_builder_sources", {}, scope)).toBeNull();
    expect(placementReviewToolScopeError("read_file", {}, scope)).toBeNull();
    expect(reviewPreparationToolAllowed("brandwell_link_builder_add", false, false, true)).toBe(
      false,
    );
  });
});

describe("review preparation tools", () => {
  it("allows placement coordination only for Link Builder review tasks", () => {
    for (const name of [
      "brandwell_link_builder_update",
      "brandwell_link_builder_task",
      "brandwell_link_builder_verify",
    ]) {
      expect(reviewPreparationToolAllowed(name, false)).toBe(false);
      expect(reviewPreparationToolAllowed(name, false, false, true)).toBe(true);
    }
    for (const name of [
      "brandwell_link_builder_add",
      "brandwell_socialstreams_queue_outreach",
      "shell",
      "computer_act",
      "email_send",
    ]) {
      expect(reviewPreparationToolAllowed(name, false, false, true)).toBe(false);
    }
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
