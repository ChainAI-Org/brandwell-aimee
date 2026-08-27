export type BrandwellCancellationPolicy = {
  retentionDays: number;
  deleteAfterRetention: boolean;
};

export type BrandwellCancellationAction =
  | "mark_canceling"
  | "pause_routines"
  | "block_new_runs"
  | "disable_openrouter"
  | "suspend_computer"
  | "delete_openrouter"
  | "revoke_connectors"
  | "destroy_computer"
  | "delete_secrets"
  | "archive_workspace";

export function buildCancellationLifecycle(
  now: Date,
  policy: BrandwellCancellationPolicy,
): {
  immediate: BrandwellCancellationAction[];
  retentionEndsAt: Date;
  afterRetention: BrandwellCancellationAction[];
} {
  if (!Number.isInteger(policy.retentionDays) || policy.retentionDays < 0) {
    throw new Error("retentionDays must be a non-negative integer");
  }
  const retentionEndsAt = new Date(now.getTime() + policy.retentionDays * 86_400_000);
  return {
    immediate: [
      "mark_canceling",
      "pause_routines",
      "block_new_runs",
      "disable_openrouter",
      "suspend_computer",
    ],
    retentionEndsAt,
    afterRetention: policy.deleteAfterRetention
      ? [
          "delete_openrouter",
          "revoke_connectors",
          "destroy_computer",
          "delete_secrets",
          "archive_workspace",
        ]
      : ["revoke_connectors", "archive_workspace"],
  };
}

export type BrandwellCancellationActionRunner = {
  completed(action: BrandwellCancellationAction): Promise<boolean>;
  execute(action: BrandwellCancellationAction): Promise<void>;
  scheduleRetentionCleanup(at: Date): Promise<void>;
};

export async function executeBrandwellCancellation(
  now: Date,
  policy: BrandwellCancellationPolicy,
  runner: BrandwellCancellationActionRunner,
): Promise<{ retentionEndsAt: Date; executed: BrandwellCancellationAction[] }> {
  const lifecycle = buildCancellationLifecycle(now, policy);
  const executed = await executeCancellationActions(lifecycle.immediate, runner);
  await runner.scheduleRetentionCleanup(lifecycle.retentionEndsAt);
  return { retentionEndsAt: lifecycle.retentionEndsAt, executed };
}

export async function executeBrandwellRetentionCleanup(
  now: Date,
  policy: BrandwellCancellationPolicy,
  runner: BrandwellCancellationActionRunner,
): Promise<BrandwellCancellationAction[]> {
  const lifecycle = buildCancellationLifecycle(now, policy);
  return executeCancellationActions(lifecycle.afterRetention, runner);
}

async function executeCancellationActions(
  actions: readonly BrandwellCancellationAction[],
  runner: BrandwellCancellationActionRunner,
): Promise<BrandwellCancellationAction[]> {
  const executed: BrandwellCancellationAction[] = [];
  for (const action of actions) {
    if (await runner.completed(action)) continue;
    await runner.execute(action);
    executed.push(action);
  }
  return executed;
}
