import type { PrismaClient } from "@rakazo/db";

export type BrandwellPushMessage = {
  notificationId: string;
  workspaceId: string;
  userId: string;
  botId: string;
  threadId: string;
  kind: "completion" | "failure" | "help" | "takeover";
  title: string;
  body: string;
  actionTarget: string | null;
};

export type BrandwellPushDelivery = (message: BrandwellPushMessage) => Promise<void>;

export async function deliverPendingBrandwellClientNotifications(
  prisma: PrismaClient,
  deliver: BrandwellPushDelivery,
  options: {
    workerId: string;
    now?: Date;
    limit?: number;
    leaseMs?: number;
    maxAttempts?: number;
  },
) {
  const now = options.now ?? new Date();
  const limit = bounded(options.limit, 1, 100, 25);
  const leaseMs = bounded(options.leaseMs, 5_000, 10 * 60_000, 60_000);
  const maxAttempts = bounded(options.maxAttempts, 1, 20, 5);
  const rows = await prisma.brandwellClientNotification.findMany({
    where: {
      resolvedAt: null,
      pushSentAt: null,
      pushDeliveryStatus: { in: ["pending", "retry"] },
      pushDeliveryAttempts: { lt: maxAttempts },
      pushDeliveryNextAt: { lte: now },
      OR: [
        { pushDeliveryLeaseOwner: null },
        { pushDeliveryLeaseExpiresAt: null },
        { pushDeliveryLeaseExpiresAt: { lte: now } },
      ],
    },
    orderBy: [{ requiresAction: "desc" }, { createdAt: "asc" }],
    take: limit,
  });
  const result = { scanned: rows.length, claimed: 0, sent: 0, partial: 0, skipped: 0, retry: 0 };
  for (const row of rows) {
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const claimed = await prisma.brandwellClientNotification.updateMany({
      where: {
        id: row.id,
        resolvedAt: null,
        pushSentAt: null,
        pushDeliveryStatus: { in: ["pending", "retry"] },
        pushDeliveryAttempts: { lt: maxAttempts },
        pushDeliveryNextAt: { lte: now },
        OR: [
          { pushDeliveryLeaseOwner: null },
          { pushDeliveryLeaseExpiresAt: null },
          { pushDeliveryLeaseExpiresAt: { lte: now } },
        ],
      },
      data: {
        pushDeliveryStatus: "delivering",
        pushDeliveryLeaseOwner: options.workerId,
        pushDeliveryLeaseExpiresAt: leaseExpiresAt,
        pushDeliveryAttempts: { increment: 1 },
        pushDeliveryLastError: null,
      },
    });
    if (claimed.count !== 1) continue;
    result.claimed += 1;
    const attempt = row.pushDeliveryAttempts + 1;
    try {
      const bot = await notificationBot(prisma, row.workspaceId, row.botId);
      if (!bot?.thread) throw new Error("No managed AIMEE thread is available for this notice.");
      const threadId = bot.thread.id;
      const members = await prisma.member.findMany({
        where: { organizationId: row.workspaceId },
        select: { userId: true },
      });
      const userIds = members
        .map((member) => member.userId)
        .filter((id) => !row.targetUserIds?.length || row.targetUserIds.includes(id));
      const preferences = userIds.length
        ? await prisma.notificationPreference.findMany({
            where: { workspaceId: row.workspaceId, userId: { in: userIds } },
          })
        : [];
      const preferencesByUser = new Map(preferences.map((item) => [item.userId, item]));
      const kind = pushKind(row.type, row.severity);
      const recipients = userIds.filter((userId) =>
        pushAllowed(preferencesByUser.get(userId), kind),
      );
      if (!recipients.length) {
        await finishDelivery(prisma, row.id, options.workerId, {
          status: "skipped",
          sentAt: now,
          error: null,
        });
        result.skipped += 1;
        continue;
      }
      const deliveries = await Promise.allSettled(
        recipients.map((userId) =>
          deliver({
            notificationId: row.id,
            workspaceId: row.workspaceId,
            userId,
            botId: bot.id,
            threadId,
            kind,
            title: row.title,
            body: row.body,
            actionTarget: row.actionTarget,
          }),
        ),
      );
      const failures = deliveries.filter((delivery) => delivery.status === "rejected");
      if (!failures.length) {
        await finishDelivery(prisma, row.id, options.workerId, {
          status: "sent",
          sentAt: now,
          error: null,
        });
        result.sent += 1;
      } else if (failures.length < deliveries.length) {
        await finishDelivery(prisma, row.id, options.workerId, {
          status: "partial",
          sentAt: now,
          error: `${failures.length} of ${deliveries.length} push deliveries failed.`,
        });
        result.partial += 1;
      } else {
        throw new Error("Every push delivery failed.");
      }
    } catch (error) {
      const terminal = attempt >= maxAttempts;
      await prisma.brandwellClientNotification.updateMany({
        where: { id: row.id, pushDeliveryLeaseOwner: options.workerId },
        data: {
          pushDeliveryStatus: terminal ? "failed" : "retry",
          pushDeliveryNextAt: terminal ? now : new Date(now.getTime() + retryDelayMs(attempt)),
          pushDeliveryLeaseOwner: null,
          pushDeliveryLeaseExpiresAt: null,
          pushDeliveryLastError: safeError(error),
        },
      });
      result.retry += 1;
    }
  }
  return result;
}

async function notificationBot(prisma: PrismaClient, workspaceId: string, botId: string | null) {
  const where = {
    workspaceId,
    managedByBrandWell: true,
    archivedAt: null,
    ...(botId ? { id: botId } : {}),
  };
  const bot = await prisma.bot.findFirst({
    where,
    select: { id: true, thread: { select: { id: true } } },
  });
  if (bot || !botId) return bot;
  return prisma.bot.findFirst({
    where: { workspaceId, managedByBrandWell: true, archivedAt: null },
    select: { id: true, thread: { select: { id: true } } },
    orderBy: [{ pinned: "desc" }, { createdAt: "asc" }],
  });
}

function pushKind(type: string, severity: string): "completion" | "failure" | "help" | "takeover" {
  const normalized = type.toUpperCase();
  if (["LOGIN_REQUIRED", "MFA_REQUIRED"].includes(normalized)) return "takeover";
  if (normalized === "SUCCESS") return "completion";
  if (["ERROR", "CRITICAL"].includes(severity.toUpperCase())) return "failure";
  return "help";
}

function pushAllowed(
  preference: { finish: boolean; help: boolean; takeover: boolean } | undefined,
  kind: "completion" | "failure" | "help" | "takeover",
) {
  if (!preference) return true;
  if (kind === "completion") return preference.finish;
  if (kind === "takeover") return preference.takeover;
  return preference.help;
}

async function finishDelivery(
  prisma: PrismaClient,
  id: string,
  workerId: string,
  input: { status: string; sentAt: Date; error: string | null },
) {
  await prisma.brandwellClientNotification.updateMany({
    where: { id, pushDeliveryLeaseOwner: workerId },
    data: {
      pushDeliveryStatus: input.status,
      pushSentAt: input.sentAt,
      pushDeliveryLeaseOwner: null,
      pushDeliveryLeaseExpiresAt: null,
      pushDeliveryLastError: input.error,
    },
  });
}

function retryDelayMs(attempt: number) {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1));
}

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : "Push delivery failed.").slice(0, 500);
}

function bounded(value: number | undefined, minimum: number, maximum: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value as number)));
}
