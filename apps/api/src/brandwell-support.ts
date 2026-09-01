import { randomUUID } from "node:crypto";
import type { AgentHomeStore, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import { computerControlExpireJobKey } from "@rakazo/adapter-kit";
import {
  acquireComputerExecutionLease,
  ComputerBusyError,
  type ComputerExecutionLease,
  enqueueTakeoverContinuation,
  expireComputerControl,
  hasActiveComputerControl,
  provisionComputer,
  releaseComputerExecutionLease,
  scheduleComputerControlExpiry,
  scheduleComputerSleep,
  screenLeaseIdForRun,
  takeoverLeaseMs,
  toComputerRef,
} from "@rakazo/adapters";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { executionBlocksUserTakeover } from "./computer-status.js";
import { addScreenProxyCapability } from "./screen-proxy.js";

export type BrandwellSupportActor = {
  reference: string;
  name: string;
  email?: string;
};

export type BrandwellSupportComputerDeps = {
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  jobs: JobPublisher;
  events: ThreadEvents;
  dataDir: string;
  systemUserId: string;
  screenProxySecret: string;
  webOrigin: string;
};

export class BrandwellSupportComputerError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 503 = 409,
  ) {
    super(message);
    this.name = "BrandwellSupportComputerError";
  }
}

export async function bootBrandwellSupportComputer(
  deps: BrandwellSupportComputerDeps,
  input: {
    workspaceId: string;
    botId?: string | null;
    actor: BrandwellSupportActor;
    reason?: string;
  },
) {
  const resource = await managedComputer(deps.prisma, input.workspaceId, input.botId);
  if (resource.computer.state === "running" && resource.computer.providerRef) {
    scheduleComputerSleep(deps.jobs, resource.computer.id);
    return { computer: supportComputerDto(resource.computer), alreadyRunning: true };
  }
  const runId = `brandwell-support-boot:${randomUUID()}`;
  let lease: ComputerExecutionLease | null;
  try {
    lease = await acquireComputerExecutionLease(deps.prisma, {
      computerId: resource.computer.id,
      runId,
      botId: resource.id,
    });
  } catch (error) {
    if (error instanceof ComputerBusyError) {
      throw new BrandwellSupportComputerError("The client computer is busy.");
    }
    throw error;
  }
  try {
    await provisionComputer(deps, resource.computer.id, {
      ...supportContext(resource, input.actor, "brandwell-support.boot"),
      screenLeaseId: screenLeaseIdForRun(lease, runId),
    });
  } catch (error) {
    if (error instanceof ComputerBusyError) {
      throw new BrandwellSupportComputerError("The client computer is busy.");
    }
    throw error;
  } finally {
    await releaseComputerExecutionLease(deps.prisma, lease);
  }
  await auditSupportAction(deps.prisma, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: "computer.support_boot",
    resourceId: resource.computer.id,
    reason: input.reason,
  });
  scheduleComputerSleep(deps.jobs, resource.computer.id);
  const computer = await deps.prisma.computer.findUniqueOrThrow({
    where: { id: resource.computer.id },
  });
  return { computer: supportComputerDto(computer), alreadyRunning: false };
}

export async function takeBrandwellSupportControl(
  deps: BrandwellSupportComputerDeps,
  input: {
    workspaceId: string;
    botId?: string | null;
    actor: BrandwellSupportActor;
    reason?: string;
  },
) {
  let resource = await managedComputer(deps.prisma, input.workspaceId, input.botId);
  if (!resource.computer.providerRef || resource.computer.state !== "running") {
    throw new BrandwellSupportComputerError("Boot the client computer before taking control.", 400);
  }
  if (resource.computer.controlLeaseId && !hasActiveComputerControl(resource.computer)) {
    await expireComputerControl(deps, resource.computer.id, resource.computer.controlLeaseId).catch(
      () => undefined,
    );
    resource = await managedComputer(deps.prisma, input.workspaceId, input.botId);
  }
  if (hasActiveComputerControl(resource.computer)) {
    const session = await deps.prisma.brandwellSupportSession.findFirst({
      where: {
        workspaceId: input.workspaceId,
        computerId: resource.computer.id,
        controlLeaseId: resource.computer.controlLeaseId,
        status: "active",
      },
      orderBy: { startedAt: "desc" },
    });
    if (session?.operatorReference === input.actor.reference) {
      return {
        sessionId: session.id,
        leaseId: resource.computer.controlLeaseId,
        expiresAt: resource.computer.controlLeaseExpiresAt?.toISOString() ?? null,
        replayed: true,
      };
    }
    throw new BrandwellSupportComputerError(
      `The client computer is already controlled by ${resource.computer.controlActorName || "another user"}.`,
    );
  }

  const executionLease = await deps.prisma.computerExecutionLease.findFirst({
    where: { computerId: resource.computer.id },
    orderBy: { expiresAt: "desc" },
  });
  const executionRun = executionLease
    ? await deps.prisma.run.findUnique({
        where: { id: executionLease.runId },
        select: { botId: true, status: true },
      })
    : null;
  const waitingForTakeover =
    executionLease?.botId === resource.id &&
    executionRun?.botId === resource.id &&
    executionRun.status === "waiting_takeover";
  if (
    executionBlocksUserTakeover({
      hasLease: Boolean(executionLease),
      leaseExpiresAt: executionLease?.expiresAt,
      runStatus: executionRun?.status,
    })
  ) {
    throw new BrandwellSupportComputerError("AIMEE is actively using the client computer.");
  }
  const executionLeaseActive = Boolean(
    executionLease && executionLease.expiresAt.getTime() > Date.now(),
  );
  const executionRunActive = Boolean(
    executionRun && (ACTIVE_RUN_STATUSES as readonly string[]).includes(executionRun.status),
  );
  if (executionLease && !executionLeaseActive && !executionRunActive) {
    await deps.prisma.computerExecutionLease.deleteMany({ where: { id: executionLease.id } });
  }

  const leaseId = randomUUID();
  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + takeoverLeaseMs());
  const session = await deps.prisma.$transaction(async (tx) => {
    const claimed = await tx.computer.updateMany({
      where: {
        id: resource.computer.id,
        workspaceId: input.workspaceId,
        state: "running",
        controlHolder: { not: "user" },
        controlLeaseId: null,
      },
      data: {
        controlHolder: "user",
        controlLeaseId: leaseId,
        controlLeaseExpiresAt: expiresAt,
        controlBotId: resource.id,
        controlRunId: waitingForTakeover ? executionLease?.runId : null,
        controlUserId: deps.systemUserId,
        controlActorType: "brandwell_operator",
        controlActorName: input.actor.name,
        controlStartedAt: startedAt,
      },
    });
    if (claimed.count !== 1) {
      throw new BrandwellSupportComputerError("The client computer was claimed by another user.");
    }
    const created = await tx.brandwellSupportSession.create({
      data: {
        workspaceId: input.workspaceId,
        computerId: resource.computer.id,
        botId: resource.id,
        operatorUserId: deps.systemUserId,
        operatorReference: input.actor.reference,
        operatorName: input.actor.name,
        operatorEmail: input.actor.email,
        controlLeaseId: leaseId,
        controlLeaseExpiresAt: expiresAt,
        reason: input.reason,
        actionsMetadata: {
          operatorReference: input.actor.reference,
          operatorName: input.actor.name,
          operatorEmail: input.actor.email ?? null,
        },
      },
    });
    await tx.brandwellAuditLog.create({
      data: supportAuditData({
        workspaceId: input.workspaceId,
        actor: input.actor,
        action: "computer.support_takeover",
        resourceType: "support_session",
        resourceId: created.id,
        reason: input.reason,
        metadata: { computerId: resource.computer.id, botId: resource.id, leaseId },
      }),
    });
    return created;
  });

  try {
    await scheduleComputerControlExpiry(deps.jobs, resource.computer.id, leaseId, expiresAt);
  } catch (error) {
    await deps.prisma.$transaction([
      deps.prisma.computer.updateMany({
        where: { id: resource.computer.id, controlLeaseId: leaseId },
        data: clearSupportControl(),
      }),
      deps.prisma.brandwellSupportSession.updateMany({
        where: { id: session.id, status: "active" },
        data: { status: "failed", releasedAt: new Date() },
      }),
    ]);
    throw error;
  }
  if (resource.thread) {
    await deps.events.append({
      workspaceId: input.workspaceId,
      threadId: resource.thread.id,
      botId: resource.id,
      type: "computer.takeover.granted",
      payload: {
        leaseId,
        takeoverRequested: waitingForTakeover,
        actorType: "brandwell_operator",
        actorName: input.actor.name,
      },
    });
  }
  scheduleComputerSleep(deps.jobs, resource.computer.id);
  return { sessionId: session.id, leaseId, expiresAt: expiresAt.toISOString(), replayed: false };
}

export async function getBrandwellSupportScreen(
  deps: BrandwellSupportComputerDeps,
  input: {
    workspaceId: string;
    botId?: string | null;
    actor: BrandwellSupportActor;
    reason?: string;
  },
) {
  const resource = await managedComputer(deps.prisma, input.workspaceId, input.botId);
  if (!resource.computer.providerRef || !["running", "booting"].includes(resource.computer.state)) {
    return { url: null, interactive: false };
  }
  const activeControl = hasActiveComputerControl(resource.computer);
  const session = activeControl
    ? await deps.prisma.brandwellSupportSession.findFirst({
        where: {
          workspaceId: input.workspaceId,
          computerId: resource.computer.id,
          controlLeaseId: resource.computer.controlLeaseId,
          operatorReference: input.actor.reference,
          status: "active",
        },
        orderBy: { startedAt: "desc" },
      })
    : null;
  const interactive = Boolean(session);
  const context = await supportScreenContext(deps.prisma, resource, input.actor);
  const screen = await deps.sandbox.connectScreen(
    toComputerRef(resource.computer),
    {
      view: "stream",
      interactive,
      controlToken: interactive ? (resource.computer.controlLeaseId ?? undefined) : undefined,
    },
    context,
  );
  if (!screen.url) return { url: null, interactive };
  await auditSupportAction(deps.prisma, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: interactive ? "computer.support_control_view" : "computer.support_preview",
    resourceId: resource.computer.id,
    reason: input.reason,
  });
  scheduleComputerSleep(deps.jobs, resource.computer.id);
  return {
    url: addScreenProxyCapability(
      withViewOnly(screen.url, !interactive),
      deps.screenProxySecret,
      deps.webOrigin,
      undefined,
      { proxyExternal: true },
    ),
    interactive,
  };
}

export async function releaseBrandwellSupportControl(
  deps: BrandwellSupportComputerDeps,
  input: {
    workspaceId: string;
    botId?: string | null;
    actor: BrandwellSupportActor;
    reason?: string;
  },
) {
  const resource = await managedComputer(deps.prisma, input.workspaceId, input.botId);
  const session = await deps.prisma.brandwellSupportSession.findFirst({
    where: {
      workspaceId: input.workspaceId,
      computerId: resource.computer.id,
      operatorReference: input.actor.reference,
      status: "active",
    },
    orderBy: { startedAt: "desc" },
  });
  if (!session) return { ok: true as const, replayed: true };
  const leaseId = session.controlLeaseId;
  if (!leaseId || resource.computer.controlLeaseId !== leaseId) {
    await closeSupportSession(deps.prisma, session.id, session.startedAt, "released");
    return { ok: true as const, replayed: true };
  }
  if (resource.computer.providerRef) {
    await deps.sandbox.setScreenControl?.(
      toComputerRef(resource.computer),
      false,
      supportContext(resource, input.actor, "brandwell-support.release"),
      leaseId,
    );
  }
  const released = await deps.events.finalizeComputerControlRelease({
    workspaceId: input.workspaceId,
    computerId: resource.computer.id,
    botId: resource.id,
    runId: resource.computer.controlRunId,
    leaseId,
    holder: resource.computer.controlRunId ? "bot" : "none",
    reason: "released",
  });
  if (!released) {
    throw new BrandwellSupportComputerError("The support control lease changed before release.");
  }
  const releasedAt = new Date();
  await deps.prisma.$transaction([
    deps.prisma.brandwellSupportSession.updateMany({
      where: { id: session.id, status: "active" },
      data: {
        status: "released",
        releasedAt,
        durationMs: Math.max(0, releasedAt.getTime() - session.startedAt.getTime()),
      },
    }),
    deps.prisma.brandwellAuditLog.create({
      data: supportAuditData({
        workspaceId: input.workspaceId,
        actor: input.actor,
        action: "computer.support_release",
        resourceType: "support_session",
        resourceId: session.id,
        reason: input.reason,
        metadata: { computerId: resource.computer.id, botId: resource.id, leaseId },
      }),
    }),
  ]);
  await deps.jobs
    .cancel(computerControlExpireJobKey(resource.computer.id, leaseId))
    .catch(() => {});
  await enqueueTakeoverContinuation(deps.jobs, released.runId);
  scheduleComputerSleep(deps.jobs, resource.computer.id);
  return { ok: true as const, replayed: false };
}

async function managedComputer(prisma: PrismaClient, workspaceId: string, botId?: string | null) {
  const bot = await prisma.bot.findFirst({
    where: {
      workspaceId,
      managedByBrandWell: true,
      archivedAt: null,
      ...(botId ? { id: botId } : {}),
      computerId: { not: null },
    },
    include: { computer: true, thread: { select: { id: true } } },
    orderBy: [{ pinned: "desc" }, { createdAt: "asc" }],
  });
  if (!bot?.computer) {
    throw new BrandwellSupportComputerError("Managed client computer not found.", 404);
  }
  return { ...bot, computer: bot.computer };
}

function supportContext(
  resource: Awaited<ReturnType<typeof managedComputer>>,
  actor: BrandwellSupportActor,
  operationId: string,
) {
  return {
    operationId,
    traceId: `${operationId}:${actor.reference}`,
    workspaceId: resource.workspaceId,
    userId: resource.computer.userId,
    botId: resource.id,
    signal: new AbortController().signal,
  };
}

async function supportScreenContext(
  prisma: PrismaClient,
  resource: Awaited<ReturnType<typeof managedComputer>>,
  actor: BrandwellSupportActor,
) {
  const context = supportContext(resource, actor, "brandwell-support.screen");
  const lease = await prisma.computerExecutionLease.findUnique({
    where: { computerId_botId: { computerId: resource.computer.id, botId: resource.id } },
    select: { runId: true, fence: true, expiresAt: true },
  });
  if (!lease || lease.expiresAt.getTime() <= Date.now()) return context;
  return { ...context, screenLeaseId: screenLeaseIdForRun(lease, lease.runId) };
}

function supportComputerDto(computer: {
  id: string;
  state: string;
  kind: string;
  scope: string;
  controlHolder: string;
  controlActorType: string | null;
  controlActorName: string | null;
  controlStartedAt: Date | null;
  updatedAt: Date;
}) {
  return {
    id: computer.id,
    state: computer.state,
    kind: computer.kind,
    scope: computer.scope,
    controlHolder: computer.controlHolder,
    controlActorType: computer.controlActorType,
    controlActorName: computer.controlActorName,
    controlStartedAt: computer.controlStartedAt,
    updatedAt: computer.updatedAt,
  };
}

function clearSupportControl() {
  return {
    controlHolder: "none",
    controlLeaseId: null,
    controlLeaseExpiresAt: null,
    controlBotId: null,
    controlRunId: null,
    controlUserId: null,
    controlActorType: null,
    controlActorName: null,
    controlStartedAt: null,
  };
}

async function closeSupportSession(
  prisma: PrismaClient,
  id: string,
  startedAt: Date,
  status: string,
) {
  const releasedAt = new Date();
  await prisma.brandwellSupportSession.updateMany({
    where: { id, status: "active" },
    data: {
      status,
      releasedAt,
      durationMs: Math.max(0, releasedAt.getTime() - startedAt.getTime()),
    },
  });
}

async function auditSupportAction(
  prisma: PrismaClient,
  input: {
    workspaceId: string;
    actor: BrandwellSupportActor;
    action: string;
    resourceId: string;
    reason?: string;
  },
) {
  await prisma.brandwellAuditLog.create({
    data: supportAuditData({
      ...input,
      resourceType: "computer",
    }),
  });
}

function supportAuditData(input: {
  workspaceId: string;
  actor: BrandwellSupportActor;
  action: string;
  resourceType: string;
  resourceId: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}) {
  return {
    workspaceId: input.workspaceId,
    actorType: "brandwell_operator",
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    metadata: {
      operatorReference: input.actor.reference,
      operatorName: input.actor.name,
      operatorEmail: input.actor.email ?? null,
      reason: input.reason ?? null,
      ...(input.metadata ?? {}),
    },
  };
}

function withViewOnly(url: string, viewOnly: boolean) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("view_only", viewOnly ? "true" : "false");
    return parsed.toString();
  } catch {
    const join = url.includes("?") ? "&" : "?";
    return `${url}${join}view_only=${viewOnly ? "true" : "false"}`;
  }
}
