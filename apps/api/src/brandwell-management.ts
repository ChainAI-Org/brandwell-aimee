import { timingSafeEqual } from "node:crypto";
import {
  type BrandwellProvisioningCheckpoint,
  BrandwellProvisioningError,
  type BrandwellProvisioningInput,
} from "@brandwell/aimee";
import {
  type JobPublisher,
  routineJobKey,
  routineWakeupJob,
  runContinueJob,
} from "@rakazo/adapter-kit";
import {
  hasMixedOneShotSchedule,
  isOneShotRoutineCrons,
  nextCronDateAcrossStrict,
} from "@rakazo/core";
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

  app.get("/internal/workspaces/:id/integrations", async (c) => {
    const mapping = await findWorkspaceMapping(deps.prisma, c.req.param("id"));
    if (!mapping) return c.json({ error: "Workspace not found" }, 404);
    const integrations = await deps.prisma.connection.findMany({
      where: {
        workspaceId: mapping.rakazoWorkspaceId,
        ownerType: "service",
      },
      orderBy: [{ status: "asc" }, { displayName: "asc" }],
    });
    return c.json({ integrations: integrations.map(integrationDto) });
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

  app.post("/internal/bots/:id/instructions", async (c) => {
    const operator = supportActor(c.req.header());
    if (!operator.ok) return c.json({ error: operator.error }, 400);
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const input = employeeInstructionsInput(body);
    if (!input.ok) return c.json({ error: input.error }, 400);
    const bot = await deps.prisma.bot.findFirst({
      where: { id: c.req.param("id"), managedByBrandWell: true, archivedAt: null },
      select: { id: true, workspaceId: true },
    });
    if (!bot) return c.json({ error: "AI employee not found" }, 404);
    const updated = await deps.prisma.$transaction(async (tx) => {
      const row = await tx.bot.update({
        where: { id: bot.id },
        data: { instructions: input.value.instructions },
        select: { id: true, instructions: true, updatedAt: true },
      });
      await tx.brandwellAuditLog.create({
        data: {
          workspaceId: bot.workspaceId,
          actorType: "brandwell_operator",
          action: "employee.instructions.update",
          resourceType: "bot",
          resourceId: bot.id,
          metadata: {
            characterCount: row.instructions.length,
            ...operatorAuditMetadata(operator.value),
          },
        },
      });
      return row;
    });
    return c.json({
      ok: true,
      employeeId: updated.id,
      instructions: updated.instructions,
      updatedAt: updated.updatedAt,
    });
  });

  app.post("/internal/routines/:id/settings", async (c) => {
    const operator = supportActor(c.req.header());
    if (!operator.ok) return c.json({ error: operator.error }, 400);
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const input = routineSettingsInput(body);
    if (!input.ok) return c.json({ error: input.error }, 400);
    const scheduleMutation =
      input.value.crons !== undefined ||
      input.value.timezone !== undefined ||
      input.value.active !== undefined;
    if (scheduleMutation && !deps.jobs) {
      return c.json({ error: "AIMEE routine scheduling is not configured" }, 503);
    }
    const existing = await deps.prisma.routine.findFirst({
      where: {
        id: c.req.param("id"),
        bot: { managedByBrandWell: true, archivedAt: null },
      },
      include: { bot: { select: { managedStatus: true } } },
    });
    if (!existing) return c.json({ error: "AIMEE routine not found" }, 404);
    const active = input.value.active ?? existing.active;
    const crons = input.value.crons ?? existing.crons;
    const timezone = input.value.timezone ?? existing.timezone;
    if (active && existing.bot.managedStatus !== "active") {
      return c.json({ error: "Resume the AI employee before activating a routine" }, 409);
    }
    if (active) {
      const mapping = await deps.prisma.brandwellAiWorkspace.findUnique({
        where: { rakazoWorkspaceId: existing.workspaceId },
        select: { subscriptionStatus: true },
      });
      if (!mapping || !["trialing", "active"].includes(mapping.subscriptionStatus)) {
        return c.json({ error: "The AIMEE subscription is not active" }, 409);
      }
    }
    const scheduleChanged =
      input.value.active !== undefined ||
      input.value.timezone !== undefined ||
      input.value.crons !== undefined;
    const schedule = managedRoutineSchedule(crons, timezone);
    if (!schedule.ok) return c.json({ error: schedule.error }, 400);
    const nextRunAt = active ? schedule.nextRunAt : null;
    const updated = await deps.prisma.$transaction(async (tx) => {
      const row = await tx.routine.update({
        where: { id: existing.id },
        data: {
          name: input.value.name,
          prompt: input.value.prompt,
          crons: input.value.crons,
          timezone: input.value.timezone,
          active: input.value.active,
          notify: input.value.notify,
          ...(scheduleChanged ? { nextRunAt } : {}),
        },
      });
      await tx.brandwellAuditLog.create({
        data: {
          workspaceId: existing.workspaceId,
          actorType: "brandwell_operator",
          action: "routine.settings.update",
          resourceType: "routine",
          resourceId: existing.id,
          metadata: {
            active: row.active,
            timezone: row.timezone,
            schedules: row.crons.length,
            ...operatorAuditMetadata(operator.value),
          },
        },
      });
      return row;
    });
    if (scheduleChanged) {
      if (updated.active && updated.nextRunAt) {
        await deps.jobs!.enqueue(routineWakeupJob(updated.id, updated.nextRunAt));
      } else {
        await deps.jobs!.cancel(routineJobKey(updated.id));
      }
    }
    return c.json({ ok: true, routine: routineDto(updated) });
  });

  app.post("/internal/workspaces/:id/model-policy", async (c) => {
    const operator = supportActor(c.req.header());
    if (!operator.ok) return c.json({ error: operator.error }, 400);
    const mapping = await findWorkspaceMapping(deps.prisma, c.req.param("id"));
    if (!mapping) return c.json({ error: "Workspace not found" }, 404);
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const input = modelPolicyInput(body);
    if (!input.ok) return c.json({ error: input.error }, 400);
    const current = await deps.prisma.brandwellWorkspaceModelCredential.findUnique({
      where: { workspaceId: mapping.rakazoWorkspaceId },
    });
    if (!current) return c.json({ error: "AIMEE model policy is not provisioned" }, 409);
    const limits = resolvedModelLimits(current, input.value);
    if (!limits.ok) return c.json({ error: limits.error }, 400);
    const updated = await deps.prisma.$transaction(async (tx) => {
      const row = await tx.brandwellWorkspaceModelCredential.update({
        where: { id: current.id },
        data: {
          preferredModel: input.value.preferredModel,
          computerModel: input.value.computerModel,
          lightweightModel: input.value.lightweightModel,
          reasoningModel: input.value.reasoningModel,
          fallbackModels: input.value.fallbackModels,
          maxTokens: input.value.maxTokens,
          thinkingLevel: input.value.thinkingLevel,
          monthlyLimitMicros: input.value.monthlyLimitMicros,
          dailyLimitMicros: input.value.dailyLimitMicros,
          warningLimitMicros: input.value.warningLimitMicros,
        },
      });
      await tx.brandwellAuditLog.create({
        data: {
          workspaceId: mapping.rakazoWorkspaceId,
          actorType: "brandwell_operator",
          action: "model.policy.update",
          resourceType: "model_policy",
          resourceId: row.id,
          metadata: {
            preferredModel: row.preferredModel,
            monthlyLimitMicros: row.monthlyLimitMicros.toString(),
            ...operatorAuditMetadata(operator.value),
          },
        },
      });
      return row;
    });
    return c.json({ ok: true, modelPolicy: modelPolicyDto(updated) });
  });

  app.post("/internal/alerts/:id/status", async (c) => {
    const operator = supportActor(c.req.header());
    if (!operator.ok) return c.json({ error: operator.error }, 400);
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const input = alertStatusInput(body);
    if (!input.ok) return c.json({ error: input.error }, 400);
    const alert = await deps.prisma.brandwellAlert.findUnique({
      where: { id: c.req.param("id") },
    });
    if (!alert) return c.json({ error: "AIMEE alert not found" }, 404);
    const now = new Date();
    const updated = await deps.prisma.$transaction(async (tx) => {
      const row = await tx.brandwellAlert.update({
        where: { id: alert.id },
        data: {
          status: input.value.status,
          acknowledgedAt: input.value.status === "OPEN" ? null : (alert.acknowledgedAt ?? now),
          resolvedAt: ["RESOLVED", "IGNORED"].includes(input.value.status) ? now : null,
        },
      });
      await tx.brandwellAuditLog.create({
        data: {
          workspaceId: alert.workspaceId,
          actorType: "brandwell_operator",
          action: `alert.${input.value.status.toLowerCase()}`,
          resourceType: "alert",
          resourceId: alert.id,
          metadata: operatorAuditMetadata(operator.value),
        },
      });
      return row;
    });
    return c.json({ ok: true, alert: updated });
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
  const [summary, routines, alerts, recentRuns, notifications, integrations, modelPolicy] =
    await Promise.all([
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
      prisma.connection.findMany({
        where: { workspaceId: mapping.rakazoWorkspaceId, ownerType: "service" },
        orderBy: [{ status: "asc" }, { displayName: "asc" }],
      }),
      prisma.brandwellWorkspaceModelCredential.findUnique({
        where: { workspaceId: mapping.rakazoWorkspaceId },
      }),
    ]);
  return {
    ...summary,
    routines,
    alerts,
    recentRuns,
    notifications,
    integrations: integrations.map(integrationDto),
    modelPolicy: modelPolicy ? modelPolicyDto(modelPolicy) : null,
  };
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
  instructions: string;
  managedStatus: string;
  computerId: string | null;
  updatedAt: Date;
}) {
  return {
    id: agent.id,
    name: agent.name,
    title: agent.title,
    description: agent.description,
    instructions: agent.instructions,
    status: agent.managedStatus,
    computerId: agent.computerId,
    updatedAt: agent.updatedAt,
  };
}

function integrationDto(connection: {
  id: string;
  connectorId: string;
  provider: string;
  displayName: string;
  status: string;
  ownerType: string;
  updatedAt: Date;
}) {
  return {
    id: connection.id,
    connectorId: connection.connectorId,
    provider: connection.provider,
    displayName: connection.displayName,
    status: connection.status,
    ownerType: connection.ownerType,
    updatedAt: connection.updatedAt,
  };
}

function routineDto(routine: {
  id: string;
  botId: string;
  name: string;
  prompt: string;
  crons: string[];
  timezone: string;
  active: boolean;
  notify: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  updatedAt: Date;
}) {
  return {
    id: routine.id,
    botId: routine.botId,
    name: routine.name,
    prompt: routine.prompt,
    crons: routine.crons,
    timezone: routine.timezone,
    active: routine.active,
    notify: routine.notify,
    lastRunAt: routine.lastRunAt,
    nextRunAt: routine.nextRunAt,
    updatedAt: routine.updatedAt,
  };
}

function modelPolicyDto(policy: {
  id: string;
  provider: string;
  status: string;
  preferredModel: string;
  computerModel: string | null;
  lightweightModel: string | null;
  reasoningModel: string | null;
  fallbackModels: unknown;
  maxTokens: number | null;
  thinkingLevel: string | null;
  monthlyLimitMicros: bigint;
  dailyLimitMicros: bigint | null;
  warningLimitMicros: bigint;
  currentUsageMicros: bigint;
  disabledAt: Date | null;
  updatedAt: Date;
}) {
  return {
    id: policy.id,
    provider: policy.provider,
    status: policy.status,
    preferredModel: policy.preferredModel,
    computerModel: policy.computerModel,
    lightweightModel: policy.lightweightModel,
    reasoningModel: policy.reasoningModel,
    fallbackModels: Array.isArray(policy.fallbackModels) ? policy.fallbackModels : [],
    maxTokens: policy.maxTokens,
    thinkingLevel: policy.thinkingLevel,
    monthlyLimitMicros: policy.monthlyLimitMicros.toString(),
    dailyLimitMicros: policy.dailyLimitMicros?.toString() ?? null,
    warningLimitMicros: policy.warningLimitMicros.toString(),
    currentUsageMicros: policy.currentUsageMicros.toString(),
    disabledAt: policy.disabledAt,
    updatedAt: policy.updatedAt,
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

function employeeInstructionsInput(
  body: Record<string, unknown> | null,
): { ok: true; value: { instructions: string } } | { ok: false; error: string } {
  if (!body) return { ok: false, error: "A JSON request body is required" };
  if (typeof body.instructions !== "string") {
    return { ok: false, error: "instructions is required" };
  }
  const instructions = body.instructions.trim();
  if (!instructions || instructions.length > 50_000) {
    return { ok: false, error: "instructions must contain 1 to 50000 characters" };
  }
  return { ok: true, value: { instructions } };
}

type RoutineSettingsInput = {
  name?: string;
  prompt?: string;
  crons?: string[];
  timezone?: string;
  active?: boolean;
  notify?: boolean;
};

function routineSettingsInput(
  body: Record<string, unknown> | null,
): { ok: true; value: RoutineSettingsInput } | { ok: false; error: string } {
  if (!body) return { ok: false, error: "A JSON request body is required" };
  const value: RoutineSettingsInput = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 120) {
      return { ok: false, error: "name must contain 1 to 120 characters" };
    }
    value.name = body.name.trim();
  }
  if (body.prompt !== undefined) {
    if (
      typeof body.prompt !== "string" ||
      !body.prompt.trim() ||
      body.prompt.trim().length > 50_000
    ) {
      return { ok: false, error: "prompt must contain 1 to 50000 characters" };
    }
    value.prompt = body.prompt.trim();
  }
  if (body.crons !== undefined) {
    if (
      !Array.isArray(body.crons) ||
      body.crons.length < 1 ||
      body.crons.length > 8 ||
      body.crons.some((cron) => typeof cron !== "string" || !cron.trim() || cron.length > 120)
    ) {
      return { ok: false, error: "crons must contain 1 to 8 valid schedules" };
    }
    value.crons = body.crons.map((cron) => String(cron).trim());
  }
  if (body.timezone !== undefined) {
    if (typeof body.timezone !== "string" || !validTimezone(body.timezone.trim())) {
      return { ok: false, error: "timezone must be a valid IANA timezone" };
    }
    value.timezone = body.timezone.trim();
  }
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") return { ok: false, error: "active must be boolean" };
    value.active = body.active;
  }
  if (body.notify !== undefined) {
    if (typeof body.notify !== "boolean") return { ok: false, error: "notify must be boolean" };
    value.notify = body.notify;
  }
  if (Object.keys(value).length === 0) {
    return { ok: false, error: "At least one routine setting is required" };
  }
  return { ok: true, value };
}

function managedRoutineSchedule(
  crons: string[],
  timezone: string,
): { ok: true; nextRunAt: Date } | { ok: false; error: string } {
  if (hasMixedOneShotSchedule(crons) || isOneShotRoutineCrons(crons)) {
    return { ok: false, error: "BrandWell managed routines must use recurring schedules" };
  }
  try {
    const nextRunAt = nextCronDateAcrossStrict(crons, new Date(), timezone);
    if (!nextRunAt) return { ok: false, error: "Enter at least one recurring schedule" };
    return { ok: true, nextRunAt };
  } catch {
    return { ok: false, error: "Enter valid five-field cron schedules" };
  }
}

function validTimezone(value: string): boolean {
  if (!value || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

type ModelPolicyPatch = {
  preferredModel?: string;
  computerModel?: string | null;
  lightweightModel?: string | null;
  reasoningModel?: string | null;
  fallbackModels?: string[];
  maxTokens?: number | null;
  thinkingLevel?: string | null;
  monthlyLimitMicros?: bigint;
  dailyLimitMicros?: bigint | null;
  warningLimitMicros?: bigint;
};

function modelPolicyInput(
  body: Record<string, unknown> | null,
): { ok: true; value: ModelPolicyPatch } | { ok: false; error: string } {
  if (!body) return { ok: false, error: "A JSON request body is required" };
  const value: ModelPolicyPatch = {};
  for (const field of [
    "preferredModel",
    "computerModel",
    "lightweightModel",
    "reasoningModel",
  ] as const) {
    if (body[field] === undefined) continue;
    if (field !== "preferredModel" && body[field] === null) {
      value[field] = null;
      continue;
    }
    if (typeof body[field] !== "string" || !body[field].trim() || body[field].trim().length > 200) {
      return { ok: false, error: `${field} must contain 1 to 200 characters` };
    }
    value[field] = body[field].trim();
  }
  if (body.fallbackModels !== undefined) {
    if (
      !Array.isArray(body.fallbackModels) ||
      body.fallbackModels.length > 10 ||
      body.fallbackModels.some(
        (model) => typeof model !== "string" || !model.trim() || model.trim().length > 200,
      )
    ) {
      return { ok: false, error: "fallbackModels must contain up to 10 model identifiers" };
    }
    value.fallbackModels = [...new Set(body.fallbackModels.map((model) => String(model).trim()))];
  }
  if (body.maxTokens !== undefined) {
    if (body.maxTokens === null) value.maxTokens = null;
    else if (
      !Number.isInteger(body.maxTokens) ||
      Number(body.maxTokens) < 256 ||
      Number(body.maxTokens) > 1_000_000
    ) {
      return { ok: false, error: "maxTokens must be between 256 and 1000000" };
    } else value.maxTokens = Number(body.maxTokens);
  }
  if (body.thinkingLevel !== undefined) {
    if (body.thinkingLevel === null) value.thinkingLevel = null;
    else if (
      typeof body.thinkingLevel !== "string" ||
      !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(
        body.thinkingLevel,
      )
    ) {
      return { ok: false, error: "thinkingLevel is invalid" };
    } else value.thinkingLevel = body.thinkingLevel;
  }
  for (const field of ["monthlyLimitMicros", "warningLimitMicros"] as const) {
    if (body[field] === undefined) continue;
    const parsed = nonnegativeBigInt(body[field]);
    if (parsed === null) return { ok: false, error: `${field} must be a nonnegative integer` };
    value[field] = parsed;
  }
  if (body.dailyLimitMicros !== undefined) {
    if (body.dailyLimitMicros === null) value.dailyLimitMicros = null;
    else {
      const parsed = nonnegativeBigInt(body.dailyLimitMicros);
      if (parsed === null) {
        return { ok: false, error: "dailyLimitMicros must be a nonnegative integer or null" };
      }
      value.dailyLimitMicros = parsed;
    }
  }
  if (Object.keys(value).length === 0) {
    return { ok: false, error: "At least one model policy setting is required" };
  }
  return { ok: true, value };
}

function nonnegativeBigInt(value: unknown): bigint | null {
  const text = typeof value === "bigint" ? value.toString() : String(value ?? "").trim();
  if (!/^\d{1,20}$/.test(text)) return null;
  try {
    return BigInt(text);
  } catch {
    return null;
  }
}

function resolvedModelLimits(
  current: {
    monthlyLimitMicros: bigint;
    dailyLimitMicros: bigint | null;
    warningLimitMicros: bigint;
  },
  patch: ModelPolicyPatch,
): { ok: true } | { ok: false; error: string } {
  const monthly = patch.monthlyLimitMicros ?? current.monthlyLimitMicros;
  const daily =
    patch.dailyLimitMicros === undefined ? current.dailyLimitMicros : patch.dailyLimitMicros;
  const warning = patch.warningLimitMicros ?? current.warningLimitMicros;
  if (monthly > 0n && warning > monthly) {
    return { ok: false, error: "warningLimitMicros cannot exceed the monthly limit" };
  }
  if (monthly > 0n && daily !== null && daily > monthly) {
    return { ok: false, error: "dailyLimitMicros cannot exceed the monthly limit" };
  }
  return { ok: true };
}

function alertStatusInput(body: Record<string, unknown> | null):
  | {
      ok: true;
      value: {
        status:
          | "OPEN"
          | "ACKNOWLEDGED"
          | "WAITING_CLIENT"
          | "WAITING_BRANDWELL"
          | "RESOLVED"
          | "IGNORED";
      };
    }
  | { ok: false; error: string } {
  if (!body) return { ok: false, error: "A JSON request body is required" };
  const status = String(body.status ?? "")
    .trim()
    .toUpperCase();
  if (
    ![
      "OPEN",
      "ACKNOWLEDGED",
      "WAITING_CLIENT",
      "WAITING_BRANDWELL",
      "RESOLVED",
      "IGNORED",
    ].includes(status)
  ) {
    return { ok: false, error: "status is invalid" };
  }
  return {
    ok: true,
    value: {
      status: status as
        | "OPEN"
        | "ACKNOWLEDGED"
        | "WAITING_CLIENT"
        | "WAITING_BRANDWELL"
        | "RESOLVED"
        | "IGNORED",
    },
  };
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
