export type BrandwellAlertAudience = "brandwell" | "client" | "both";

export type BrandwellAlertCandidate = {
  workspaceId: string;
  type: string;
  resourceId: string;
  source: "run" | "computer" | "connector" | "model" | "gtm";
  severity: "INFO" | "WARNING" | "ERROR" | "CRITICAL";
  summary: string;
  clientActionRequired: boolean;
  brandwellActionRequired: boolean;
  technicalDetails?: Record<string, unknown>;
};

export type ExistingBrandwellAlert = {
  id: string;
  workspaceId: string;
  dedupeKey: string;
  status: "OPEN" | "ACKNOWLEDGED" | "WAITING_CLIENT" | "WAITING_BRANDWELL" | "RESOLVED" | "IGNORED";
};

export function brandwellAlertDedupeKey(
  workspaceId: string,
  type: string,
  resourceId: string,
): string {
  return `${workspaceId}:${type}:${resourceId}`;
}

export function routeBrandwellAlert(type: string): BrandwellAlertAudience {
  if (
    ["LOGIN_REQUIRED", "MFA_REQUIRED", "APPROVAL_REQUIRED", "CONNECTION_REQUIRED"].includes(type)
  ) {
    return "client";
  }
  if (
    [
      "OPENROUTER_DISABLED",
      "OPENROUTER_BUDGET",
      "OPENROUTER_USAGE_SYNC_FAILED",
      "OPENROUTER_USAGE_SYNC_STALE",
      "OPENROUTER_LIMIT_DRIFT",
      "WORKER_RETRY",
      "CHECKPOINT_WARNING",
      "COMPUTER_PROVISIONING_FAILED",
    ].includes(type)
  ) {
    return "brandwell";
  }
  return "both";
}

export function reconcileBrandwellAlerts(
  existing: readonly ExistingBrandwellAlert[],
  candidates: readonly BrandwellAlertCandidate[],
): {
  upsert: Array<BrandwellAlertCandidate & { dedupeKey: string; audience: BrandwellAlertAudience }>;
  resolveIds: string[];
} {
  const candidatesByKey = new Map(
    candidates.map((candidate) => [
      brandwellAlertDedupeKey(candidate.workspaceId, candidate.type, candidate.resourceId),
      candidate,
    ]),
  );
  const unresolved = existing.filter(
    (alert) => alert.status !== "RESOLVED" && alert.status !== "IGNORED",
  );

  return {
    upsert: [...candidatesByKey.entries()].map(([dedupeKey, candidate]) => ({
      ...candidate,
      dedupeKey,
      audience: routeBrandwellAlert(candidate.type),
    })),
    resolveIds: unresolved
      .filter((alert) => !candidatesByKey.has(alert.dedupeKey))
      .map((alert) => alert.id),
  };
}
