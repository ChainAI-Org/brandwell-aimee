import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  type BrandwellAlertAudience,
  type BrandwellAlertCandidate,
  reconcileBrandwellAlerts,
} from "./alerting.js";

export type BrandwellFleetHealthThresholds = {
  runStuckMs: number;
  routineOverdueMs: number;
  computerTransitionStuckMs: number;
  failedRunLookbackMs: number;
  providerUsageStaleMs: number;
};

export const DEFAULT_BRANDWELL_HEALTH_THRESHOLDS: BrandwellFleetHealthThresholds = {
  runStuckMs: 30 * 60_000,
  routineOverdueMs: 5 * 60_000,
  computerTransitionStuckMs: 10 * 60_000,
  failedRunLookbackMs: 24 * 60 * 60_000,
  providerUsageStaleMs: 10 * 60_000,
};

export async function reconcileBrandwellFleetHealth(
  prisma: PrismaClient,
  now = new Date(),
  thresholds: BrandwellFleetHealthThresholds = DEFAULT_BRANDWELL_HEALTH_THRESHOLDS,
): Promise<{
  candidates: number;
  upserted: number;
  resolved: number;
  notifications: number;
}> {
  validateThresholds(thresholds);
  const mappings = await prisma.brandwellAiWorkspace.findMany({
    where: { subscriptionStatus: { in: ["provisioning", "active", "trialing", "canceling"] } },
    select: {
      brandwellCustomerId: true,
      rakazoWorkspaceId: true,
      provisioningStatus: true,
      provisioningError: true,
    },
  });
  if (!mappings.length) return { candidates: 0, upserted: 0, resolved: 0, notifications: 0 };
  const workspaceIds = mappings.map((mapping) => mapping.rakazoWorkspaceId);
  const clientIdByWorkspace = new Map(
    mappings.map((mapping) => [mapping.rakazoWorkspaceId, mapping.brandwellCustomerId]),
  );

  const [
    runs,
    routines,
    computers,
    connectors,
    workspaceCredentials,
    sidekickCredentials,
    cancellationFailures,
    existing,
  ] = await Promise.all([
    prisma.run.findMany({
      where: {
        workspaceId: { in: workspaceIds },
        OR: [
          { status: { in: ["queued", "leased", "running", "waiting_takeover"] } },
          { status: "failed", createdAt: { gte: before(now, thresholds.failedRunLookbackMs) } },
        ],
      },
      select: {
        id: true,
        workspaceId: true,
        botId: true,
        status: true,
        error: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.routine.findMany({
      where: {
        workspaceId: { in: workspaceIds },
        active: true,
        nextRunAt: { lt: before(now, thresholds.routineOverdueMs) },
      },
      select: { id: true, workspaceId: true, botId: true, name: true, nextRunAt: true },
    }),
    prisma.computer.findMany({
      where: {
        workspaceId: { in: workspaceIds },
        state: { in: ["error", "booting", "suspending"] },
      },
      select: {
        id: true,
        workspaceId: true,
        state: true,
        updatedAt: true,
        executionBotId: true,
        controlBotId: true,
      },
    }),
    prisma.connection.findMany({
      where: {
        workspaceId: { in: workspaceIds },
        status: { in: ["error", "expired", "disconnected"] },
      },
      select: { id: true, workspaceId: true, provider: true, displayName: true, status: true },
    }),
    prisma.brandwellWorkspaceModelCredential.findMany({
      where: { workspaceId: { in: workspaceIds } },
      select: {
        id: true,
        workspaceId: true,
        externalKeyHash: true,
        status: true,
        disabledAt: true,
        currentUsageMicros: true,
        monthlyLimitMicros: true,
        limitReset: true,
        warningLimitMicros: true,
        providerLimitMicros: true,
        providerLimitReset: true,
        providerIncludeByokInLimit: true,
        providerUsageSyncedAt: true,
        providerUsageSyncError: true,
      },
    }),
    prisma.brandwellSidekickModelCredential.findMany({
      where: { workspaceId: { in: workspaceIds } },
      select: {
        id: true,
        workspaceId: true,
        externalKeyHash: true,
        status: true,
        disabledAt: true,
        currentUsageMicros: true,
        monthlyLimitMicros: true,
        limitReset: true,
        warningLimitMicros: true,
        providerLimitMicros: true,
        providerLimitReset: true,
        providerIncludeByokInLimit: true,
        providerUsageSyncedAt: true,
        providerUsageSyncError: true,
        sidekick: { select: { botId: true, email: true, status: true } },
      },
    }),
    prisma.brandwellCancellationEvent.findMany({
      where: { workspaceId: { in: workspaceIds }, status: "failed" },
      select: { id: true, workspaceId: true, stage: true, lastError: true },
    }),
    prisma.brandwellAlert.findMany({
      where: { workspaceId: { in: workspaceIds } },
      select: { id: true, workspaceId: true, dedupeKey: true, status: true },
    }),
  ]);

  const candidates: BrandwellAlertCandidate[] = [];
  for (const mapping of mappings) {
    if (["failed", "rollback_failed"].includes(mapping.provisioningStatus)) {
      candidates.push({
        workspaceId: mapping.rakazoWorkspaceId,
        type: "PROVISIONING_FAILED",
        resourceId: mapping.brandwellCustomerId,
        source: "gtm",
        severity: "ERROR",
        summary: "AIMEE provisioning did not complete.",
        clientActionRequired: false,
        brandwellActionRequired: true,
        technicalDetails: {
          provisioningStatus: mapping.provisioningStatus,
          error: mapping.provisioningError ?? undefined,
        },
      });
    }
  }
  for (const run of runs) {
    if (run.status === "failed") {
      candidates.push({
        workspaceId: run.workspaceId,
        type: "RUN_FAILED",
        resourceId: run.id,
        source: "run",
        severity: "ERROR",
        summary: "An AIMEE run failed.",
        clientActionRequired: false,
        brandwellActionRequired: true,
        technicalDetails: { status: run.status, error: run.error ?? undefined },
      });
    } else if (run.status === "waiting_takeover") {
      candidates.push({
        workspaceId: run.workspaceId,
        type: "LOGIN_REQUIRED",
        resourceId: run.id,
        source: "computer",
        severity: "WARNING",
        summary: "AIMEE needs the client to complete a login or verification step.",
        clientActionRequired: true,
        brandwellActionRequired: false,
        technicalDetails: { status: run.status, botId: run.botId },
      });
    } else if (run.updatedAt < before(now, thresholds.runStuckMs)) {
      candidates.push({
        workspaceId: run.workspaceId,
        type: "RUN_STUCK",
        resourceId: run.id,
        source: "run",
        severity: "ERROR",
        summary: "An AIMEE run has not made progress within the expected time.",
        clientActionRequired: false,
        brandwellActionRequired: true,
        technicalDetails: { status: run.status, updatedAt: run.updatedAt.toISOString() },
      });
    }
  }
  for (const routine of routines) {
    candidates.push({
      workspaceId: routine.workspaceId,
      type: "ROUTINE_OVERDUE",
      resourceId: routine.id,
      source: "run",
      severity: "WARNING",
      summary: `${routine.name} is overdue.`,
      clientActionRequired: false,
      brandwellActionRequired: true,
      technicalDetails: { nextRunAt: routine.nextRunAt?.toISOString(), botId: routine.botId },
    });
  }
  for (const computer of computers) {
    const transitionStuck =
      computer.state !== "error" &&
      computer.updatedAt < before(now, thresholds.computerTransitionStuckMs);
    if (computer.state !== "error" && !transitionStuck) continue;
    candidates.push({
      workspaceId: computer.workspaceId,
      type: computer.state === "error" ? "COMPUTER_ERROR" : "COMPUTER_TRANSITION_STUCK",
      resourceId: computer.id,
      source: "computer",
      severity: "ERROR",
      summary:
        computer.state === "error"
          ? "The client computer is unavailable."
          : `The client computer is stuck while ${computer.state}.`,
      clientActionRequired: false,
      brandwellActionRequired: true,
      technicalDetails: { state: computer.state, updatedAt: computer.updatedAt.toISOString() },
    });
  }
  for (const connection of connectors) {
    candidates.push({
      workspaceId: connection.workspaceId,
      type: "CONNECTION_REQUIRED",
      resourceId: connection.id,
      source: "connector",
      severity: "WARNING",
      summary: `${connection.displayName || connection.provider} needs to be reconnected.`,
      clientActionRequired: true,
      brandwellActionRequired: false,
      technicalDetails: { provider: connection.provider, status: connection.status },
    });
  }
  const credentials = [
    ...workspaceCredentials.map((credential) => ({
      ...credential,
      sidekick: null as { botId: string | null; email: string; status: string } | null,
    })),
    ...sidekickCredentials,
  ];
  for (const credential of credentials) {
    const subject = credential.sidekick ? "Sidekick" : "workspace";
    const technicalDetails = credential.sidekick?.botId
      ? { botId: credential.sidekick.botId, sidekickEmail: credential.sidekick.email }
      : undefined;
    if (credential.providerUsageSyncError) {
      candidates.push({
        workspaceId: credential.workspaceId,
        type: "OPENROUTER_USAGE_SYNC_FAILED",
        resourceId: credential.id,
        source: "model",
        severity: "ERROR",
        summary: `OpenRouter usage and limit status could not be synchronized for this ${subject}.`,
        clientActionRequired: false,
        brandwellActionRequired: true,
        technicalDetails: {
          error: credential.providerUsageSyncError,
          lastSuccessfulSyncAt: credential.providerUsageSyncedAt?.toISOString(),
          ...technicalDetails,
        },
      });
    } else if (
      credential.externalKeyHash &&
      (!credential.providerUsageSyncedAt ||
        credential.providerUsageSyncedAt < before(now, thresholds.providerUsageStaleMs))
    ) {
      candidates.push({
        workspaceId: credential.workspaceId,
        type: "OPENROUTER_USAGE_SYNC_STALE",
        resourceId: credential.id,
        source: "model",
        severity: "ERROR",
        summary: `OpenRouter usage and limit status is stale for this ${subject}.`,
        clientActionRequired: false,
        brandwellActionRequired: true,
        technicalDetails: {
          lastSuccessfulSyncAt: credential.providerUsageSyncedAt?.toISOString(),
          ...technicalDetails,
        },
      });
    }
    const intentionallyPausedSidekick =
      credential.sidekick?.status === "paused" || credential.sidekick?.status === "canceled";
    if ((credential.status !== "active" || credential.disabledAt) && !intentionallyPausedSidekick) {
      candidates.push({
        workspaceId: credential.workspaceId,
        type: "OPENROUTER_DISABLED",
        resourceId: credential.id,
        source: "model",
        severity: "CRITICAL",
        summary: `Managed model inference is disabled for this ${subject}.`,
        clientActionRequired: false,
        brandwellActionRequired: true,
        technicalDetails,
      });
    } else if (
      credential.monthlyLimitMicros > 0n &&
      credential.currentUsageMicros >= credential.monthlyLimitMicros
    ) {
      candidates.push({
        workspaceId: credential.workspaceId,
        type: "OPENROUTER_BUDGET",
        resourceId: credential.id,
        source: "model",
        severity: "CRITICAL",
        summary: `The ${subject} reached its managed model budget.`,
        clientActionRequired: false,
        brandwellActionRequired: true,
        technicalDetails,
      });
    } else if (
      credential.warningLimitMicros > 0n &&
      credential.currentUsageMicros >= credential.warningLimitMicros
    ) {
      candidates.push({
        workspaceId: credential.workspaceId,
        type: "OPENROUTER_BUDGET_WARNING",
        resourceId: credential.id,
        source: "model",
        severity: "WARNING",
        summary: `The ${subject} is approaching its managed model budget.`,
        clientActionRequired: false,
        brandwellActionRequired: true,
        technicalDetails,
      });
    }
    if (
      credential.externalKeyHash &&
      credential.status === "active" &&
      !credential.disabledAt &&
      credential.providerUsageSyncedAt &&
      !credential.providerUsageSyncError &&
      (credential.providerLimitMicros !== credential.monthlyLimitMicros ||
        credential.providerLimitReset !== credential.limitReset ||
        credential.providerIncludeByokInLimit !== true)
    ) {
      candidates.push({
        workspaceId: credential.workspaceId,
        type: "OPENROUTER_LIMIT_DRIFT",
        resourceId: credential.id,
        source: "model",
        severity: "CRITICAL",
        summary: `The OpenRouter provider limit does not match the managed budget for this ${subject}.`,
        clientActionRequired: false,
        brandwellActionRequired: true,
        technicalDetails: {
          managedLimitMicros: credential.monthlyLimitMicros.toString(),
          providerLimitMicros: credential.providerLimitMicros?.toString() ?? null,
          managedLimitReset: credential.limitReset,
          providerLimitReset: credential.providerLimitReset,
          providerIncludeByokInLimit: credential.providerIncludeByokInLimit,
          ...technicalDetails,
        },
      });
    }
  }
  for (const event of cancellationFailures) {
    candidates.push({
      workspaceId: event.workspaceId,
      type: "CANCELLATION_ACTION_FAILED",
      resourceId: event.id,
      source: "gtm",
      severity: "CRITICAL",
      summary: `Cancellation cleanup failed during ${event.stage}.`,
      clientActionRequired: false,
      brandwellActionRequired: true,
      technicalDetails: { stage: event.stage, error: event.lastError ?? undefined },
    });
  }

  const typedExisting = existing.map((alert) => ({
    ...alert,
    status: alertStatus(alert.status),
  }));
  const reconciliation = reconcileBrandwellAlerts(typedExisting, candidates);
  const existingByKey = new Map(typedExisting.map((alert) => [alert.dedupeKey, alert]));
  let notifications = 0;
  for (const item of reconciliation.upsert) {
    const clientId = clientIdByWorkspace.get(item.workspaceId);
    if (!clientId) continue;
    const prior = existingByKey.get(item.dedupeKey);
    await prisma.brandwellAlert.upsert({
      where: {
        workspaceId_dedupeKey: { workspaceId: item.workspaceId, dedupeKey: item.dedupeKey },
      },
      create: alertCreateData(clientId, item),
      update: {
        source: item.source,
        severity: item.severity,
        type: item.type,
        summary: item.summary,
        technicalDetails: json(item.technicalDetails ?? {}),
        clientActionRequired: item.clientActionRequired,
        brandwellActionRequired: item.brandwellActionRequired,
        ...(prior?.status === "RESOLVED"
          ? { status: "OPEN", resolvedAt: null, acknowledgedAt: null }
          : {}),
      },
    });
    if (item.audience !== "brandwell" && (!prior || prior.status === "RESOLVED")) {
      await prisma.brandwellClientNotification.upsert({
        where: {
          workspaceId_dedupeKey: {
            workspaceId: item.workspaceId,
            dedupeKey: `alert:${item.dedupeKey}`,
          },
        },
        create: notificationData(item, now),
        update: {
          title: notificationTitle(item.type),
          body: item.summary,
          severity: item.severity,
          requiresAction: item.clientActionRequired,
          actionType: notificationActionType(item),
          actionTarget: notificationActionTarget(
            item,
            stringDetail(item.technicalDetails, "botId"),
          ),
          readAt: null,
          resolvedAt: null,
          resolvedBy: null,
          pushDeliveryStatus: "pending",
          pushDeliveryAttempts: 0,
          pushDeliveryNextAt: now,
          pushDeliveryLeaseOwner: null,
          pushDeliveryLeaseExpiresAt: null,
          pushDeliveryLastError: null,
          pushSentAt: null,
        },
      });
      notifications += 1;
    }
  }

  if (reconciliation.resolveIds.length) {
    const resolved = typedExisting.filter((alert) => reconciliation.resolveIds.includes(alert.id));
    await prisma.brandwellAlert.updateMany({
      where: { id: { in: reconciliation.resolveIds } },
      data: { status: "RESOLVED", resolvedAt: now },
    });
    await prisma.brandwellClientNotification.updateMany({
      where: {
        OR: resolved.map((alert) => ({
          workspaceId: alert.workspaceId,
          dedupeKey: `alert:${alert.dedupeKey}`,
        })),
      },
      data: { resolvedAt: now, resolvedBy: "brandwell_health_reconciler" },
    });
  }

  return {
    candidates: candidates.length,
    upserted: reconciliation.upsert.length,
    resolved: reconciliation.resolveIds.length,
    notifications,
  };
}

function alertCreateData(
  clientId: string,
  item: BrandwellAlertCandidate & { dedupeKey: string; audience: BrandwellAlertAudience },
) {
  return {
    workspaceId: item.workspaceId,
    clientId,
    source: item.source,
    severity: item.severity,
    status: "OPEN",
    type: item.type,
    dedupeKey: item.dedupeKey,
    summary: item.summary,
    technicalDetails: json(item.technicalDetails ?? {}),
    clientActionRequired: item.clientActionRequired,
    brandwellActionRequired: item.brandwellActionRequired,
    botId: stringDetail(item.technicalDetails, "botId"),
    runId: item.source === "run" || item.type === "LOGIN_REQUIRED" ? item.resourceId : null,
  };
}

function notificationData(
  item: BrandwellAlertCandidate & { dedupeKey: string; audience: BrandwellAlertAudience },
  now: Date,
) {
  const botId = stringDetail(item.technicalDetails, "botId");
  return {
    workspaceId: item.workspaceId,
    botId,
    runId: item.source === "run" || item.type === "LOGIN_REQUIRED" ? item.resourceId : null,
    dedupeKey: `alert:${item.dedupeKey}`,
    type: item.type,
    title: notificationTitle(item.type),
    body: item.summary,
    severity: item.severity,
    requiresAction: item.clientActionRequired,
    actionType: notificationActionType(item),
    actionTarget: notificationActionTarget(item, botId),
    pushDeliveryNextAt: now,
  };
}

function notificationTitle(type: string): string {
  if (type === "LOGIN_REQUIRED" || type === "MFA_REQUIRED") return "AIMEE needs your help";
  if (type === "CONNECTION_REQUIRED") return "Reconnect an app";
  if (type === "APPROVAL_REQUIRED") return "AIMEE needs approval";
  return "AIMEE status update";
}

function notificationActionType(
  item: BrandwellAlertCandidate & { audience: BrandwellAlertAudience },
): string | null {
  if (!item.clientActionRequired) return null;
  if (item.source === "computer") return "OPEN_COMPUTER";
  if (item.source === "connector") return "OPEN_INTEGRATIONS";
  return "OPEN_ACTIVITY";
}

function notificationActionTarget(
  item: BrandwellAlertCandidate & { audience: BrandwellAlertAudience },
  botId: string | null,
): string | null {
  if (!item.clientActionRequired) return null;
  if (item.source === "computer")
    return botId ? `/computer?botId=${encodeURIComponent(botId)}` : "/computer";
  if (item.source === "connector") return "/integrations";
  return `/activity/run/${encodeURIComponent(item.resourceId)}`;
}

function before(now: Date, milliseconds: number): Date {
  return new Date(now.getTime() - milliseconds);
}

function validateThresholds(thresholds: BrandwellFleetHealthThresholds): void {
  for (const [name, value] of Object.entries(thresholds)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  }
}

function stringDetail(details: Record<string, unknown> | undefined, key: string): string | null {
  const value = details?.[key];
  return typeof value === "string" && value ? value : null;
}

function json(value: Record<string, unknown>): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

function alertStatus(
  value: string,
): "OPEN" | "ACKNOWLEDGED" | "WAITING_CLIENT" | "WAITING_BRANDWELL" | "RESOLVED" | "IGNORED" {
  if (
    value === "ACKNOWLEDGED" ||
    value === "WAITING_CLIENT" ||
    value === "WAITING_BRANDWELL" ||
    value === "RESOLVED" ||
    value === "IGNORED"
  ) {
    return value;
  }
  return "OPEN";
}
