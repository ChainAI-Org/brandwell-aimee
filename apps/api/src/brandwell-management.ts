import { timingSafeEqual } from "node:crypto";
import {
  type BrandwellProvisioningCheckpoint,
  BrandwellProvisioningError,
  type BrandwellProvisioningInput,
} from "@brandwell/aimee";
import type { PrismaClient } from "@rakazo/db";
import type { Hono } from "hono";

export interface BrandwellManagementDeps {
  prisma: PrismaClient;
  token: string;
  provisionWorkspace?: (
    input: BrandwellProvisioningInput,
  ) => Promise<BrandwellProvisioningCheckpoint>;
  cancelWorkspace?: (
    workspaceId: string,
    reason: string | undefined,
  ) => Promise<{ retentionEndsAt: Date; executed: string[] }>;
}

type WorkspaceMapping = Awaited<ReturnType<typeof findWorkspaceMapping>>;

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
          actorType: "brandwell_service",
          action: "employee.pause",
          resourceType: "bot",
          resourceId: bot.id,
        },
      }),
    ]);
    return c.json({ ok: true, status: "paused" });
  });

  app.post("/internal/bots/:id/resume", async (c) => {
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
          actorType: "brandwell_service",
          action: "employee.resume",
          resourceType: "bot",
          resourceId: bot.id,
        },
      }),
    ]);
    return c.json({ ok: true, status: "active" });
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
