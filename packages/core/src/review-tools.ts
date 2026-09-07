// Review preparation cannot inherit an employee's permission to send or change data.
const REVIEW_TOOLS = new Set([
  "computer_observe",
  "list_files",
  "read_file",
  "recall_memory",
  "schedule_list",
  "scratchpad_list",
  "skill_read",
]);

export function reviewPreparationToolAllowed(
  name: string,
  readOnlyConnector: boolean,
  socialReview = false,
  placementReview = false,
): boolean {
  return (
    REVIEW_TOOLS.has(name) ||
    readOnlyConnector ||
    (socialReview && name === "brandwell_socialstreams_update_opportunity") ||
    (placementReview &&
      [
        "brandwell_link_builder_update",
        "brandwell_link_builder_task",
        "brandwell_link_builder_verify",
      ].includes(name))
  );
}

// The assigned record comes from the authenticated dispatch, never from the prompt or tool input.
export function placementReviewToolScopeError(
  name: string,
  args: Record<string, unknown>,
  scope: unknown,
): string | null {
  if (!name.startsWith("brandwell_link_builder_")) return null;
  if (!scope || typeof scope !== "object" || Array.isArray(scope))
    return "This placement run has no valid assignment. Requeue it from Link Builder.";
  const assignment = scope as Record<string, unknown>;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  if (
    assignment.kind !== "link_builder" ||
    !/^[A-Za-z0-9._:-]{8,160}$/.test(String(assignment.requestKey || "")) ||
    !uuid.test(String(assignment.taskId || "")) ||
    !uuid.test(String(assignment.opportunityId || ""))
  )
    return "This placement run has no valid assignment. Requeue it from Link Builder.";
  if (
    [
      "brandwell_link_builder_details",
      "brandwell_link_builder_update",
      "brandwell_link_builder_verify",
    ].includes(name) &&
    args.id !== assignment.opportunityId
  )
    return "This run can only access its assigned placement.";
  if (name === "brandwell_link_builder_task" && args.id !== assignment.taskId)
    return "This run can only coordinate its assigned placement task.";
  return null;
}
