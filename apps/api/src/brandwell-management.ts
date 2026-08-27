import { timingSafeEqual } from "node:crypto";
import {
  type BrandwellProvisioningCheckpoint,
  BrandwellProvisioningError,
  type BrandwellProvisioningInput,
} from "@brandwell/aimee";
import { type JobPublisher, runContinueJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import type { Context, Hono } from "hono";
import type { BrandwellSupportActor } from "./brandwell-support.js";
import { BrandwellSupportComputerError } from "./brandwell-support.js";

export interface BrandwellManagementDeps {
  prisma: PrismaClient;
  token: string;
  jobs?: JobPublisher;
  provisionWorkspace?: (
    input: BrandwellProvisioningInput,
  ) => Promise<BrandwellProvisioningCheckpoint>;
  cancelWorkspace?: (
    workspaceId: string,
    reason: string | undefined,
  ) => Promise<{ retentionEndsAt: Date; executed: string[] }>;
  computerSupport?: {
    boot(input: BrandwellSupportRequest): Promise<unknown>;
    takeControl(input: BrandwellSupportRequest): Promise<unknown>;
    screen(input: BrandwellSupportRequest): Promise<unknown>;
    release(input: BrandwellSupportRequest): Promise<unknown>;
  };
}

type BrandwellSupportRequest = {
  workspaceId: string;
  botId?: string | null;
  actor: BrandwellSupportActor;
  reason?: string;
};

type WorkspaceMapping = Awaited<ReturnType<typeof findWorkspaceMapping>>;
type ClientNotificationRecord = {
  id: string;
  type: string;
  title: string;
  severity: string;
  requiresAction: boolean;
  createdAt: Date;
};

export function constantTimeBearerMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = header.slice("Bearer ".length).trim();
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return (
    suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes)
  );
}

export function mountBrandwellManagementRoutes(app: Hono, deps: BrandwellManagementDeps): void {
  app.use("/internal/*", async (c, next) => {
    if (!constantTimeBearerMatches(c.req.header("authorization"), deps.token)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  app.get("/internal/workspaces", async (c) => {
    const limit = boundedLimit(c.req.query("limit"));
    const rows = await deps.prisma.brandwellAiWorkspace.findMany({
      take: limit,
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      include: { rakazoWorkspace: { select: { name: true, slug: true } } },
    });
    return c.json({ workspaces: await Promise.all(rows.map((row) => fleetRow(deps.prisma, row))) });
  });

  app.post("/internal/workspaces/provision", async (c) => {
    if (!deps.provisionWorkspace) {
      return c.json({ error: "AIMEE provisioning is not configured" }, 503);
    }
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const input = provisioningInput(body);
    if (!input.ok) return c.json({ error: input.error }, 400);
    try {
      const checkpoint = await deps.provisionWorkspace(input.value);
      const inviteStep = checkpoint.steps.find((step) => step.name === "client_admin_membership");
      return c.json({
        status: checkpoint.status,
        runId: checkpoint.runId,
        workspaceId: checkpoint.steps.find((step) => step.name === "workspace")?.resourceId ?? null,
        botId: checkpoint.steps.find((step) => step.name === "primary_aimee")?.resourceId ?? null,
        clientAccess: inviteStep
          ? {
              kind: inviteStep.metadata?.kind ?? "pending",
              resourceId: inviteStep.resourceId ?? null,
            }
          : null,
      });
    } catch (error) {
      if (error instanceof BrandwellProvisioningError) {
        const conflict = error.message.includes("already running");
        return c.json(
          {
            error: conflict ? "Provisioning is already running" : "AIMEE provisioning failed",
            status: error.checkpoint.status,
            runId: error.checkpoint.runId,
          },
          conflict ? 409 : 500,
        );
      }
      return c.json({ error: "AIMEE provisioning failed" }, 500);
    }
  });

  app.get("/internal/workspaces/:id", async (c) => {
    const mapping = await findWorkspaceMapping(deps.prisma, c.req.param("id"));
    if (!mapping) return c.json({ error: "Workspace not found" }, 404);
    return c.json(await workspaceDetail(deps.prisma, mapping));
  });

  app.post("/internal/workspaces/:id/cancel", async (c) => {
    if (!deps.cancelWorkspace) {
      return c.json({ error: "AIMEE cancellation is not configured" }, 503);
    }
    const body: Record<string, unknown> = await c.req
      .json<Record<string, unknown>>()
      .catch(() => ({}));
    const reason =
      typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : undefined;
    try {
      const result = await deps.cancelWorkspace(c.req.param("id"), reason);
      return c.json({
        status: "canceling",
        retentionEndsAt: result.retentionEndsAt.toISOString(),
        executed: result.executed,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "BrandWell workspace not found") {
        return c.json({ error: "Workspace not found" }, 404);
      }
      return c.json({ error: "AIMEE cancellation failed" }, 500);
    }
  });

  app.get("/internal/workspaces/:id/agents", async (c) => {
    const mapping = await findWorkspaceMapping(deps.prisma, c.req.param("id"));
    if (!mapping) return c.json({ error: "Workspace not found" }, 404);
    const agents = await deps.prisma.bot.findMany({
      where: {
        workspaceId: mapping.rakazoWorkspaceId,
        managedByBrandWell: true,
        archivedAt: null,
      },
      orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
    });
    return c.json({ agents: agents.map(agentDto) });
  });

  app.get("/internal/workspaces/:id/computer", async (c) => {
    const mapping = await findWorkspaceMapping(deps.prisma, c.req.param("id"));
    if (!mapping) return c.json({ error: "Workspace not found" }, 404);
    const computer = await deps.prisma.computer.findFirst({
      where: { workspaceId: mapping.rakazoWorkspaceId, scope: "team" },
      orderBy: [{ updatedAt: "desc" }],
    });
    return c.json({ computer: computer ? computerDto(computer) : null });
  });

  app.post("/internal/workspaces/:id/computer/boot", async (c) => {
    const request = await supportComputerRequest(c, deps);
    if (!request.ok) return c.json({ error: request.error }, request.status);
    try {
      return c.json(await deps.computerSupport!.boot(request.value));
    } catch (error) {
      return supportComputerError(c, error);
    }
  });

  app.post("/internal/workspaces/:id/computer/takeover", async (c) => {
    const request = await supportComputerRequest(c, deps);
    if (!request.ok) return c.json({ error: request.error }, request.status);
    try {
      return c.json(await deps.computerSupport!.takeControl(request.value));
    } catch (error) {
      return supportComputerError(c, error);
    }
  });

  app.get("/internal/workspaces/:id/computer/screen", async (c) => {
    const request = await supportComputerRequest(c, deps, c.req.query("reason"));
    if (!request.ok) return c.json({ error: request.error }, request.status);
    try {
      return c.json(await deps.computerSupport!.screen(request.value));
    } catch (error) {
      return supportComputerError(c, error);
    }
  });

  app.post("/internal/workspaces/:id/computer/release", async (c) => {
    const request = await supportComputerRequest(c, deps);
    if (!request.ok) return c.json({ error: request.error }, request.status);
    try {
      return c.json(await deps.computerSupport!.release(request.value));
    } catch (error) {
      return supportComputerError(c, error);
    }
  });

  app.get("/internal/workspaces/:id/runs", async (c) => {
    const mapping = await findWorkspaceMapping(deps.prisma, c.req.param("id"));
    if (!mapping) return c.json({ error: "Workspace not found" }, 404);
    const runs = await deps.prisma.run.findMany({
      where: { workspaceId: mapping.rakazoWorkspaceId },
      orderBy: [{ createdAt: "desc" }],
      take: boundedLimit(c.req.query("limit")),
    });
    return c.json({ runs });
  });

  app.get("/internal/workspaces/:id/routines", async (c) => {
    const mapping = await findWorkspaceMapping(deps.prisma, c.req.param("id"));
    if (!mapping) return c.json({ error: "Workspace not found" }, 404);
    const routines = await deps.prisma.routine.findMany({
      where: { workspaceId: mapping.rakazoWorkspaceId },
      orderBy: [{ active: "desc" }, { nextRunAt: "asc" }],
    });
    return c.json({ routines });
  });

  app.get("/internal/workspaces/:id/alerts", async (c) => {
    const mapping = await findWorkspaceMapping(deps.prisma, c.req.param("id"));
    if (!mapping) return c.json({ error: "Workspace not found" }, 404);
    const alerts = await deps.prisma.brandwellAlert.findMany({
      where: { workspaceId: mapping.rakazoWorkspaceId },
      orderBy: [{ resolvedAt: "asc" }, { createdAt: "desc" }],
      take: boundedLimit(c.req.query("limit")),
    });
    return c.json({ alerts });
  });

  app.get("/internal/workspaces/:id/usage", async (c) => {
    const mapping = await findWorkspaceMapping(deps.prisma, c.req.param("id"));
    if (!mapping) return c.json({ error: "Workspace not found" }, 404);
    return c.json(await usageDto(deps.prisma, mapping.rakazoWorkspaceId));
  });

  app.post("/internal/bots/:id/pause", async (c) => {
    const operator = supportActor(c.req.header());
    if (!operator.ok) return c.json({ error: operator.error }, 400);
    const bot = await deps.prisma.bot.findFirst({
      where: { id: c.req.param("id"), managedByBrandWell: true, archivedAt: null },
      select: { id: true, workspaceId: true },
    });
    if (!bot) return c.json({ error: "AI employee not found" }, 404);
    await deps.prisma.$transaction([
      deps.prisma.bot.update({ where: { id: bot.id }, data: { managedStatus: "paused" } }),
      deps.prisma.routine.updateMany({ where: { botId: bot.id }, data: { active: false } }),
      deps.prisma.brandwellAuditLog.create({
        data: {
          workspaceId: bot.workspaceId,
          actorType: "brandwell_operator",
          action: "employee.pause",
          resourceType: "bot",
          resourceId: bot.id,
          metadata: operatorAuditMetadata(operator.value),
        },
      }),
    ]);
    return c.json({ ok: true, status: "paused" });
  });

  app.post("/internal/bots/:id/resume", async (c) => {
    const operator = supportActor(c.req.header());
    if (!operator.ok) return c.json({ error: operator.error }, 400);
    const bot = await deps.prisma.bot.findFirst({
      where: { id: c.req.param("id"), managedByBrandWell: true, archivedAt: null },
      select: { id: true, workspaceId: true },
    });
    if (!bot) return c.json({ error: "AI employee not found" }, 404);
    await deps.prisma.$transaction([
      deps.prisma.bot.update({ where: { id: bot.id }, data: { managedStatus: "active" } }),
      deps.prisma.brandwellAuditLog.create({
        data: {
          workspaceId: bot.workspaceId,
          actorType: "brandwell_operator",
          action: "employee.resume",
          resourceType: "bot",
          resourceId: bot.id,
          metadata: operatorAuditMetadata(operator.value),
        },
      }),
    ]);
    return c.json({ ok: true, status: "active" });
  });

  app.post("/internal/bots/:id/run", async (c) => {
    if (!deps.jobs) return c.json({ error: "AIMEE job execution is not configured" }, 503);
    const operator = supportActor(c.req.header());
    if (!operator.ok) return c.json({ error: operator.error }, 400);
    const requestKey = managementIdempotencyKey(c.req.header("x-idempotency-key"));
    if (!requestKey.ok) return c.json({ error: requestKey.error }, 400);
    const bot = await deps.prisma.bot.findFirst({
      where: {
        id: c.req.param("id"),
        managedByBrandWell: true,
        managedStatus: "active",
        archivedAt: null,
        workspace: {
          brandwellWorkspace: { subscriptionStatus: { in: ["trialing", "active"] } },
        },
      },
      select: {
        id: true,
        workspaceId: true,
        userId: true,
        serviceIdentityId: true,
        thread: { select: { id: true } },
      },
    });
    if (!bot?.thread || !bot.serviceIdentityId) {
      return c.json({ error: "Active AI employee not found" }, 404);
    }
    const threadId = bot.thread.id;
    const routine = await deps.prisma.routine.findFirst({
      where: { botId: bot.id, workspaceId: bot.workspaceId, active: true },
      orderBy: [{ nextRunAt: "asc" }, { createdAt: "asc" }],
    });
    if (!routine) return c.json({ error: "No active routine is available to run" }, 409);
    const clientNonce = `brandwell-support:${requestKey.value}`;
    const existing = await deps.prisma.run.findFirst({
      where: { workspaceId: bot.workspaceId, clientNonce },
      select: { id: true, status: true },
    });
    if (existing) return c.json({ runId: existing.id, status: existing.status, replayed: true });
    let run: { id: string; status: string; replayed: boolean };
    try {
      run = await deps.prisma.$transaction(async (tx) => {
        const replay = await tx.run.findFirst({
          where: { workspaceId: bot.workspaceId, clientNonce },
          select: { id: true, status: true },
        });
        if (replay) return { ...replay, replayed: true };
        const task = await tx.task.create({
          data: {
            workspaceId: bot.workspaceId,
            botId: bot.id,
            threadId,
            userId: bot.userId,
            prompt: routine.prompt,
            status: "queued",
          },
        });
        const created = await tx.run.create({
          data: {
            workspaceId: bot.workspaceId,
            botId: bot.id,
            threadId,
            taskId: task.id,
            userId: bot.userId,
            serviceIdentityId: bot.serviceIdentityId,
            routineId: routine.id,
            status: "queued",
            trigger: "brandwell_support",
            clientNonce,
          },
          select: { id: true, status: true },
        });
        await tx.brandwellAuditLog.create({
          data: {
            workspaceId: bot.workspaceId,
            actorType: "brandwell_operator",
            action: "employee.run_now",
            resourceType: "run",
            resourceId: created.id,
            metadata: { routineId: routine.id, ...operatorAuditMetadata(operator.value) },
          },
        });
        return { ...created, replayed: false };
      });
    } catch (error) {
      const replay = await deps.prisma.run.findFirst({
        where: { workspaceId: bot.workspaceId, clientNonce },
        select: { id: true, status: true },
      });
      if (!replay) throw error;
      run = { ...replay, replayed: true };
    }
    await deps.jobs.enqueue(runContinueJob(run.id)).catch(() => undefined);
    return c.json({ runId: run.id, status: run.status, replayed: run.replayed });
  });

  app.post("/internal/runs/:id/retry", async (c) => {
    if (!deps.jobs) return c.json({ error: "AIMEE job execution is not configured" }, 503);
    const operator = supportActor(c.req.header());
    if (!operator.ok) return c.json({ error: operator.error }, 400);
    const run = await deps.prisma.run.findFirst({
      where: {
        id: c.req.param("id"),
        status: "failed",
        bot: {
          managedByBrandWell: true,
          managedStatus: "active",
          archivedAt: null,
          workspace: {
            brandwellWorkspace: { subscriptionStatus: { in: ["trialing", "active"] } },
          },
        },
      },
      select: { id: true, workspaceId: true, taskId: true, botId: true },
    });
    if (!run) return c.json({ error: "Failed AIMEE run not found" }, 404);
    const reset = await deps.prisma.$transaction(async (tx) => {
      const updated = await tx.run.updateMany({
        where: { id: run.id, status: "failed" },
        data: {
          status: "queued",
          error: null,
          startedAt: null,
          completedAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          checkpoint: null,
        },
      });
      if (updated.count !== 1) return false;
      await tx.task.update({ where: { id: run.taskId }, data: { status: "queued" } });
      await tx.brandwellAuditLog.create({
        data: {
          workspaceId: run.workspaceId,
          actorType: "brandwell_operator",
          action: "run.retry",
          resourceType: "run",
          resourceId: run.id,
          metadata: { botId: run.botId, ...operatorAuditMetadata(operator.value) },
        },
      });
      return true;
    });
    if (!reset) return c.json({ error: "Run is no longer retryable" }, 409);
    await deps.jobs.enqueue(runContinueJob(run.id)).catch(() => undefined);
    return c.json({ ok: true, runId: run.id, status: "queued" });
  });

  app.post("/internal/workspaces/:id/notify-client", async (c) => {
    const operator = supportActor(c.req.header());
    if (!operator.ok) return c.json({ error: operator.error }, 400);
    const mapping = await findWorkspaceMapping(deps.prisma, c.req.param("id"));
    if (!mapping) return c.json({ error: "Workspace not found" }, 404);
    const requestKey = managementIdempotencyKey(c.req.header("x-idempotency-key"));
    if (!requestKey.ok) return c.json({ error: requestKey.error }, 400);
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const input = clientNotificationInput(body);
    if (!input.ok) return c.json({ error: input.error }, 400);
    const dedupeKey = `brandwell-notify:${requestKey.value}`;
    const existing = await deps.prisma.brandwellClientNotification.findUnique({
      where: {
        workspaceId_dedupeKey: { workspaceId: mapping.rakazoWorkspaceId, dedupeKey },
      },
    });
    if (existing) return c.json(clientNotificationResponse(existing, true));
    let row: ClientNotificationRecord;
    try {
      row = await deps.prisma.$transaction(async (tx) => {
        const notification = await tx.brandwellClientNotification.create({
          data: {
            workspaceId: mapping.rakazoWorkspaceId,
            dedupeKey,
            type: input.value.type,
            title: input.value.title,
            body: input.value.body,
            severity: input.value.severity,
            requiresAction: input.value.requiresAction,
            actionType: input.value.actionType,
            actionTarget: input.value.actionTarget,
          },
        });
        await tx.brandwellAuditLog.create({
          data: {
            workspaceId: mapping.rakazoWorkspaceId,
            actorType: "brandwell_operator",
            action: "client.notify",
            resourceType: "notification",
            resourceId: notification.id,
            metadata: {
              type: notification.type,
              requiresAction: notification.requiresAction,
              ...operatorAuditMetadata(operator.value),
            },
          },
        });
        return notification;
      });
    } catch (error) {
      const replay = await deps.prisma.brandwellClientNotification.findUnique({
        where: {
          workspaceId_dedupeKey: { workspaceId: mapping.rakazoWorkspaceId, dedupeKey },
        },
      });
      if (!replay) throw error;
      return c.json(clientNotificationResponse(replay, true));
    }
    return c.json(clientNotificationResponse(row, false));
  });
}

async function findWorkspaceMapping(prisma: PrismaClient, id: string) {
  return prisma.brandwellAiWorkspace.findFirst({
    where: {
      OR: [{ id }, { brandwellCustomerId: id }, { rakazoWorkspaceId: id }],
    },
    include: { rakazoWorkspace: { select: { name: true, slug: true } } },
  });
}

async function fleetRow(prisma: PrismaClient, mapping: NonNullable<WorkspaceMapping>) {
  const [agent, computer, lastRun, nextRoutine, alerts, usage] = await Promise.all([
    prisma.bot.findFirst({
      where: {
        workspaceId: mapping.rakazoWorkspaceId,
        managedByBrandWell: true,
        archivedAt: null,
      },
      orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
    }),
    prisma.computer.findFirst({
      where: { workspaceId: mapping.rakazoWorkspaceId, scope: "team" },
      orderBy: [{ updatedAt: "desc" }],
    }),
    prisma.run.findFirst({
      where: { workspaceId: mapping.rakazoWorkspaceId },
      orderBy: [{ createdAt: "desc" }],
    }),
    prisma.routine.findFirst({
      where: { workspaceId: mapping.rakazoWorkspaceId, active: true },
      orderBy: [{ nextRunAt: "asc" }],
    }),
    prisma.brandwellAlert.count({
      where: {
        workspaceId: mapping.rakazoWorkspaceId,
        status: { notIn: ["RESOLVED", "IGNORED"] },
      },
    }),
    usageDto(prisma, mapping.rakazoWorkspaceId),
  ]);
  return {
    id: mapping.id,
    brandwellCustomerId: mapping.brandwellCustomerId,
    workspaceId: mapping.rakazoWorkspaceId,
    client: mapping.rakazoWorkspace.name,
    slug: mapping.rakazoWorkspace.slug,
    subscriptionStatus: mapping.subscriptionStatus,
    plan: mapping.plan,
    provisioningStatus: mapping.provisioningStatus,
    employee: agent ? agentDto(agent) : null,
    computer: computer ? computerDto(computer) : null,
    lastRun,
    nextRunAt: nextRoutine?.nextRunAt ?? null,
    openAlerts: alerts,
    usage,
  };
}

async function workspaceDetail(prisma: PrismaClient, mapping: NonNullable<WorkspaceMapping>) {
  const [summary, routines, alerts, recentRuns, notifications] = await Promise.all([
    fleetRow(prisma, mapping),
    prisma.routine.findMany({
      where: { workspaceId: mapping.rakazoWorkspaceId },
      orderBy: [{ active: "desc" }, { nextRunAt: "asc" }],
    }),
    prisma.brandwellAlert.findMany({
      where: { workspaceId: mapping.rakazoWorkspaceId },
      orderBy: [{ resolvedAt: "asc" }, { createdAt: "desc" }],
      take: 50,
    }),
    prisma.run.findMany({
      where: { workspaceId: mapping.rakazoWorkspaceId },
      orderBy: [{ createdAt: "desc" }],
      take: 50,
    }),
    prisma.brandwellClientNotification.findMany({
      where: { workspaceId: mapping.rakazoWorkspaceId },
      orderBy: [{ createdAt: "desc" }],
      take: 50,
    }),
  ]);
  return { ...summary, routines, alerts, recentRuns, notifications };
}

async function usageDto(prisma: PrismaClient, workspaceId: string) {
  const [aggregate, credential] = await Promise.all([
    prisma.usageRecord.aggregate({
      where: { workspaceId },
      _sum: { inputTokens: true, outputTokens: true, costMicros: true },
      _count: { id: true },
    }),
    prisma.brandwellWorkspaceModelCredential.findUnique({
      where: { workspaceId },
      select: {
        status: true,
        monthlyLimitMicros: true,
        warningLimitMicros: true,
        currentUsageMicros: true,
        preferredModel: true,
        disabledAt: true,
      },
    }),
  ]);
  return {
    records: aggregate._count.id,
    inputTokens: aggregate._sum.inputTokens ?? 0,
    outputTokens: aggregate._sum.outputTokens ?? 0,
    costMicros: (aggregate._sum.costMicros ?? 0n).toString(),
    credential: credential
      ? {
          ...credential,
          monthlyLimitMicros: credential.monthlyLimitMicros.toString(),
          warningLimitMicros: credential.warningLimitMicros.toString(),
          currentUsageMicros: credential.currentUsageMicros.toString(),
        }
      : null,
  };
}

function agentDto(agent: {
  id: string;
  name: string;
  title: string;
  description: string;
  managedStatus: string;
  computerId: string | null;
  updatedAt: Date;
}) {
  return {
    id: agent.id,
    name: agent.name,
    title: agent.title,
    description: agent.description,
    status: agent.managedStatus,
    computerId: agent.computerId,
    updatedAt: agent.updatedAt,
  };
}

function computerDto(computer: {
  id: string;
  state: string;
  scope: string;
  kind: string;
  controlHolder: string;
  controlActorType: string | null;
  controlActorName: string | null;
  controlStartedAt: Date | null;
  lastScreenshotAt: Date | null;
  lastComputerActivityAt: Date | null;
  lastComputerState: string | null;
  updatedAt: Date;
}) {
  return {
    id: computer.id,
    state: computer.state,
    scope: computer.scope,
    kind: computer.kind,
    controlHolder: computer.controlHolder,
    controlActorType: computer.controlActorType,
    controlActorName: computer.controlActorName,
    controlStartedAt: computer.controlStartedAt,
    lastScreenshotAt: computer.lastScreenshotAt,
    lastComputerActivityAt: computer.lastComputerActivityAt,
    lastComputerState: computer.lastComputerState,
    updatedAt: computer.updatedAt,
  };
}

function boundedLimit(value: string | undefined): number {
  const parsed = Number(value ?? 50);
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(100, Math.max(1, Math.trunc(parsed)));
}

function managementIdempotencyKey(
  value: string | undefined,
): { ok: true; value: string } | { ok: false; error: string } {
  const key = String(value ?? "").trim();
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(key)) {
    return { ok: false, error: "A valid x-idempotency-key header is required" };
  }
  return { ok: true, value: key };
}

function clientNotificationInput(body: Record<string, unknown> | null):
  | {
      ok: true;
      value: {
        type: string;
        title: string;
        body: string;
        severity: string;
        requiresAction: boolean;
        actionType: string | null;
        actionTarget: string | null;
      };
    }
  | { ok: false; error: string } {
  if (!body) return { ok: false, error: "A JSON request body is required" };
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const message = typeof body.body === "string" ? body.body.trim() : "";
  if (!title || title.length > 120) return { ok: false, error: "title is required" };
  if (!message || message.length > 1_000) return { ok: false, error: "body is required" };
  const type =
    typeof body.type === "string" && body.type.trim() ? body.type.trim().slice(0, 80) : "INFO";
  const severity =
    typeof body.severity === "string" && body.severity.trim()
      ? body.severity.trim().slice(0, 40)
      : "info";
  const actionType =
    typeof body.actionType === "string" && body.actionType.trim()
      ? body.actionType.trim().slice(0, 80)
      : null;
  const actionTarget =
    typeof body.actionTarget === "string" && body.actionTarget.trim()
      ? body.actionTarget.trim().slice(0, 500)
      : null;
  return {
    ok: true,
    value: {
      type,
      title,
      body: message,
      severity,
      requiresAction: body.requiresAction === true,
      actionType,
      actionTarget,
    },
  };
}

function clientNotificationResponse(row: ClientNotificationRecord, replayed: boolean) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    severity: row.severity,
    requiresAction: row.requiresAction,
    createdAt: row.createdAt,
    replayed,
  };
}

async function supportComputerRequest(
  c: Context,
  deps: BrandwellManagementDeps,
  queryReason?: string,
): Promise<
  | { ok: true; value: BrandwellSupportRequest }
  | { ok: false; error: string; status: 400 | 404 | 409 | 503 }
> {
  if (!deps.computerSupport) {
    return { ok: false, error: "AIMEE computer support is not configured", status: 503 };
  }
  const mappingId = c.req.param("id");
  if (!mappingId) return { ok: false, error: "Workspace not found", status: 404 };
  const mapping = await findWorkspaceMapping(deps.prisma, mappingId);
  if (!mapping) return { ok: false, error: "Workspace not found", status: 404 };
  if (!["active", "trialing"].includes(mapping.subscriptionStatus)) {
    return { ok: false, error: "The AIMEE subscription is not active", status: 409 };
  }
  const actor = supportActor(c.req.header());
  if (!actor.ok) return { ok: false, error: actor.error, status: 400 };
  const body: Record<string, unknown> | null =
    c.req.method === "GET" ? null : await c.req.json<Record<string, unknown>>().catch(() => ({}));
  const rawReason = queryReason ?? (typeof body?.reason === "string" ? body.reason : "");
  const reason = rawReason.trim().slice(0, 500) || undefined;
  return {
    ok: true,
    value: {
      workspaceId: mapping.rakazoWorkspaceId,
      botId: mapping.primaryBotId,
      actor: actor.value,
      reason,
    },
  };
}

export function supportActor(
  headers: Record<string, string>,
): { ok: true; value: BrandwellSupportActor } | { ok: false; error: string } {
  const reference = String(headers["x-brandwell-operator-ref"] ?? "").trim();
  const name = String(headers["x-brandwell-operator-name"] ?? "").trim();
  const email = String(headers["x-brandwell-operator-email"] ?? "")
    .trim()
    .toLowerCase();
  if (!/^[A-Za-z0-9._:@-]{1,160}$/.test(reference)) {
    return { ok: false, error: "A valid BrandWell operator reference is required" };
  }
  if (!name || name.length > 120) {
    return { ok: false, error: "A valid BrandWell operator name is required" };
  }
  if (email && (!email.includes("@") || email.length > 254)) {
    return { ok: false, error: "The BrandWell operator email is invalid" };
  }
  return { ok: true, value: { reference, name, ...(email ? { email } : {}) } };
}

function operatorAuditMetadata(actor: BrandwellSupportActor) {
  return {
    operatorReference: actor.reference,
    operatorName: actor.name,
    ...(actor.email ? { operatorEmail: actor.email } : {}),
  };
}

function supportComputerError(c: Context, error: unknown) {
  if (error instanceof BrandwellSupportComputerError) {
    return c.json({ error: error.message }, error.status);
  }
  console.error("BrandWell support computer operation", error);
  return c.json({ error: "AIMEE could not complete the computer support request" }, 503);
}

function provisioningInput(
  body: Record<string, unknown> | null,
): { ok: true; value: BrandwellProvisioningInput } | { ok: false; error: string } {
  if (!body) return { ok: false, error: "A JSON request body is required" };
  const required = [
    "brandwellCustomerId",
    "companyName",
    "primaryContactName",
    "primaryContactEmail",
    "timezone",
  ] as const;
  for (const field of required) {
    if (typeof body[field] !== "string" || !body[field].trim()) {
      return { ok: false, error: `${field} is required` };
    }
  }
  return {
    ok: true,
    value: {
      brandwellCustomerId: String(body.brandwellCustomerId),
      companyName: String(body.companyName),
      primaryContactName: String(body.primaryContactName),
      primaryContactEmail: String(body.primaryContactEmail),
      plan: typeof body.plan === "string" && body.plan.trim() ? body.plan : "aimee",
      timezone: String(body.timezone),
    },
  };
}
