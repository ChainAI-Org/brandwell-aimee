import type { PrismaClient } from "@rakazo/db";

export async function reconcileBrandwellSupportSessions(
  prisma: PrismaClient,
  now = new Date(),
): Promise<{ scanned: number; closed: number }> {
  const sessions = await prisma.brandwellSupportSession.findMany({
    where: { status: "active" },
    orderBy: { startedAt: "asc" },
    take: 100,
  });
  if (!sessions.length) return { scanned: 0, closed: 0 };
  const computers = await prisma.computer.findMany({
    where: { id: { in: [...new Set(sessions.map((session) => session.computerId))] } },
    select: {
      id: true,
      controlLeaseId: true,
      controlLeaseExpiresAt: true,
      controlActorType: true,
    },
  });
  const computerById = new Map(computers.map((computer) => [computer.id, computer]));
  let closed = 0;
  for (const session of sessions) {
    const computer = computerById.get(session.computerId);
    const ownsCurrentLease = Boolean(
      computer &&
        session.controlLeaseId &&
        computer.controlLeaseId === session.controlLeaseId &&
        computer.controlActorType === "brandwell_operator" &&
        computer.controlLeaseExpiresAt &&
        computer.controlLeaseExpiresAt.getTime() > now.getTime(),
    );
    if (ownsCurrentLease) continue;
    const expired = Boolean(
      session.controlLeaseExpiresAt && session.controlLeaseExpiresAt.getTime() <= now.getTime(),
    );
    const durationMs = Math.max(0, now.getTime() - session.startedAt.getTime());
    const updated = await prisma.brandwellSupportSession.updateMany({
      where: { id: session.id, status: "active" },
      data: { status: expired ? "expired" : "released", releasedAt: now, durationMs },
    });
    if (updated.count !== 1) continue;
    await prisma.brandwellAuditLog.create({
      data: {
        workspaceId: session.workspaceId,
        actorType: "brandwell_service",
        action: expired ? "computer.support_expired" : "computer.support_reconciled",
        resourceType: "support_session",
        resourceId: session.id,
        metadata: {
          computerId: session.computerId,
          botId: session.botId,
          operatorReference: session.operatorReference,
          controlLeaseId: session.controlLeaseId,
        },
      },
    });
    closed += 1;
  }
  return { scanned: sessions.length, closed };
}
