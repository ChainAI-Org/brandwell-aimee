import type { BrandwellClientNotification, RunActivityRow } from "@rakazo/contracts";

export function managedRunAttention({
  notifications,
  activeRuns,
  recentRuns,
}: {
  notifications: Pick<BrandwellClientNotification, "requiresAction" | "resolvedAt">[];
  activeRuns: Pick<RunActivityRow, "status">[];
  recentRuns: Pick<RunActivityRow, "status" | "updatedAt">[];
}): string | null {
  if (notifications.some((notice) => notice.requiresAction && !notice.resolvedAt)) {
    return "An action needs your review";
  }
  if (activeRuns.some((run) => ["waiting_input", "waiting_takeover"].includes(run.status))) {
    return "A run is waiting for input";
  }
  const latest = recentRuns.reduce<(typeof recentRuns)[number] | undefined>(
    (newest, run) => (!newest || run.updatedAt > newest.updatedAt ? run : newest),
    undefined,
  );
  if (latest?.status === "failed") return "The latest task failed. Review activity";
  return null;
}

export function runChatDestination(run: Pick<RunActivityRow, "botId" | "threadId" | "groupId">) {
  if (run.groupId) return `/app/g/${encodeURIComponent(run.groupId)}`;
  return `/app/${encodeURIComponent(run.botId)}?thread=${encodeURIComponent(run.threadId)}`;
}
