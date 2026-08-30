import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import {
  type BrandwellCancellationAction,
  type BrandwellCancellationActionRunner,
  type BrandwellCancellationPolicy,
  executeBrandwellCancellation,
  executeBrandwellRetentionCleanup,
} from "./cancellation.js";
import type { OpenRouterManagementClient } from "./openrouter-management.js";

export type BrandwellManagedComputer = {
  id: string;
  workspaceId: string;
  userId: string;
  homeKey: string;
  kind: string;
  providerRef: string | null;
  state: string;
};

export type PrismaBrandwellCancellationOptions = {
  prisma: PrismaClient;
  openRouter: Pick<OpenRouterManagementClient, "disableKey" | "deleteKey">;
  computerLifecycle: {
    suspend(computer: BrandwellManagedComputer): Promise<void>;
    destroy(computer: BrandwellManagedComputer): Promise<void>;
  };
  now?: () => Date;
  leaseMs?: number;
};

export async function cancelBrandwellWorkspaceWithPrisma(
  workspaceLookupId: string,
  reason: string | undefined,
  policy: BrandwellCancellationPolicy,
  options: PrismaBrandwellCancellationOptions,
) {
  const mapping = await findMapping(options.prisma, workspaceLookupId);
  if (!mapping) throw new Error("BrandWell workspace not found");
  const now = options.now?.() ?? new Date();
  const runner = createCancellationRunner(mapping.rakazoWorkspaceId, reason, options);
  return executeBrandwellCancellation(now, policy, runner);
}

export async function reconcileBrandwellRetentionCleanupWithPrisma(
  options: PrismaBrandwellCancellationOptions,
  policy: BrandwellCancellationPolicy,
): Promise<Array<{ workspaceId: string; executed: BrandwellCancellationAction[] }>> {
  const now = options.now?.() ?? new Date();
  const due = await options.prisma.brandwellCancellationEvent.findMany({
    where: {
      stage: "retention_cleanup",
      executedAt: null,
      scheduledAt: { lte: now },
      OR: [
        { status: { in: ["pending", "failed"] } },
        { status: "running", leaseExpiresAt: { lt: now } },
      ],
    },
    orderBy: [{ scheduledAt: "asc" }, { workspaceId: "asc" }],
  });
  const results: Array<{ workspaceId: string; executed: BrandwellCancellationAction[] }> = [];
  for (const event of due) {
    const leaseOwner = `retention:${randomUUID()}`;
    if (
      !(await claimCancellationEvent(
        options.prisma,
        event.workspaceId,
        event.stage,
        leaseOwner,
        now,
        options.leaseMs,
      ))
    ) {
      continue;
    }
    const runner = createCancellationRunner(event.workspaceId, event.reason ?? undefined, options);
    try {
      const executed = await executeBrandwellRetentionCleanup(now, policy, runner);
      await options.prisma.brandwellCancellationEvent.update({
        where: { workspaceId_stage: { workspaceId: event.workspaceId, stage: event.stage } },
        data: {
          status: "completed",
          executedAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: null,
          details: { completedActions: executed },
        },
      });
      results.push({ workspaceId: event.workspaceId, executed });
    } catch (error) {
      await failCancellationEvent(options.prisma, event.workspaceId, event.stage, error, now);
    }
  }
  return results;
}

function createCancellationRunner(
  workspaceId: string,
  reason: string | undefined,
  options: PrismaBrandwellCancellationOptions,
): BrandwellCancellationActionRunner {
  const now = options.now ?? (() => new Date());
  return {
    async completed(action) {
      const event = await options.prisma.brandwellCancellationEvent.findUnique({
        where: { workspaceId_stage: { workspaceId, stage: action } },
        select: { status: true, executedAt: true },
      });
      return event?.status === "completed" && Boolean(event.executedAt);
    },
    async execute(action) {
      const event = await options.prisma.brandwellCancellationEvent.upsert({
        where: { workspaceId_stage: { workspaceId, stage: action } },
        create: { workspaceId, stage: action, reason, details: {}, status: "pending" },
        update: { reason },
      });
      if (event.status === "completed" && event.executedAt) return;
      const leaseOwner = `action:${action}:${randomUUID()}`;
      if (
        !(await claimCancellationEvent(
          options.prisma,
          workspaceId,
          action,
          leaseOwner,
          now(),
          options.leaseMs,
        ))
      ) {
        const current = await options.prisma.brandwellCancellationEvent.findUnique({
          where: { workspaceId_stage: { workspaceId, stage: action } },
          select: { status: true },
        });
        if (current?.status === "completed") return;
        throw new Error(`Cancellation action ${action} is already running`);
      }
      try {
        await executePrismaCancellationAction(workspaceId, action, options, now());
        await options.prisma.brandwellCancellationEvent.update({
          where: { workspaceId_stage: { workspaceId, stage: action } },
          data: {
            status: "completed",
            executedAt: now(),
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: null,
            details: { ok: true },
          },
        });
      } catch (error) {
        await failCancellationEvent(options.prisma, workspaceId, action, error, now());
        throw error;
      }
    },
    async scheduleRetentionCleanup(at) {
      await options.prisma.$transaction([
        options.prisma.brandwellCancellationEvent.upsert({
          where: { workspaceId_stage: { workspaceId, stage: "retention_cleanup" } },
          create: {
            workspaceId,
            stage: "retention_cleanup",
            reason,
            scheduledAt: at,
            status: "pending",
            details: { status: "scheduled" },
          },
          update: {
            reason,
            scheduledAt: at,
            executedAt: null,
            status: "pending",
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: null,
            details: { status: "scheduled" },
          },
        }),
        options.prisma.brandwellAiWorkspace.update({
          where: { rakazoWorkspaceId: workspaceId },
          data: { retentionEndsAt: at },
        }),
      ]);
    },
  };
}

async function claimCancellationEvent(
  prisma: PrismaClient,
  workspaceId: string,
  stage: string,
  leaseOwner: string,
  now: Date,
  leaseMs = 5 * 60_000,
): Promise<boolean> {
  const claimed = await prisma.brandwellCancellationEvent.updateMany({
    where: {
      workspaceId,
      stage,
      executedAt: null,
      OR: [
        { status: { in: ["pending", "failed"] } },
        { status: "running", leaseExpiresAt: { lt: now } },
      ],
    },
    data: {
      status: "running",
      leaseOwner,
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      lastError: null,
    },
  });
  return claimed.count === 1;
}

async function failCancellationEvent(
  prisma: PrismaClient,
  workspaceId: string,
  stage: string,
  error: unknown,
  now: Date,
): Promise<void> {
  const message = safeError(error);
  await prisma.brandwellCancellationEvent.update({
    where: { workspaceId_stage: { workspaceId, stage } },
    data: {
      status: "failed",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: message,
      details: { ok: false, failedAt: now.toISOString(), error: message },
    },
  });
}

async function executePrismaCancellationAction(
  workspaceId: string,
  action: BrandwellCancellationAction,
  options: PrismaBrandwellCancellationOptions,
  now: Date,
): Promise<void> {
  switch (action) {
    case "mark_canceling": {
      const mapping = await options.prisma.brandwellAiWorkspace.update({
        where: { rakazoWorkspaceId: workspaceId },
        data: {
          subscriptionStatus: "canceling",
          canceledAt: now,
        },
      });
      await options.prisma.brandwellAuditLog.create({
        data: {
          workspaceId,
          actorType: "brandwell_service",
          action: "workspace.cancel",
          resourceType: "brandwell_ai_workspace",
          resourceId: mapping.id,
        },
      });
      return;
    }
    case "pause_routines":
      await options.prisma.routine.updateMany({ where: { workspaceId }, data: { active: false } });
      return;
    case "block_new_runs":
      await options.prisma.$transaction([
        options.prisma.bot.updateMany({
          where: { workspaceId, managedByBrandWell: true },
          data: { managedStatus: "canceled" },
        }),
        options.prisma.brandwellServiceIdentity.updateMany({
          where: { workspaceId },
          data: { status: "disabled" },
        }),
      ]);
      return;
    case "disable_openrouter": {
      const credential = await options.prisma.brandwellWorkspaceModelCredential.findUnique({
        where: { workspaceId },
      });
      if (!credential) return;
      if (credential.externalKeyHash)
        await options.openRouter.disableKey(credential.externalKeyHash);
      await options.prisma.brandwellWorkspaceModelCredential.update({
        where: { id: credential.id },
        data: { status: "disabled", disabledAt: now },
      });
      return;
    }
    case "suspend_computer": {
      const computers = await managedComputers(options.prisma, workspaceId);
      for (const computer of computers) {
        if (computer.providerRef && !["stopped", "suspended"].includes(computer.state)) {
          await options.computerLifecycle.suspend(computer);
        }
        await options.prisma.computer.update({
          where: { id: computer.id },
          data: {
            state: computer.providerRef ? "suspended" : "stopped",
            lastComputerState: computer.state,
            lastComputerActivityAt: now,
            screenUrl: null,
            controlHolder: "none",
            controlLeaseId: null,
            controlLeaseExpiresAt: null,
            controlUserId: null,
            controlActorType: null,
            controlActorName: null,
            controlStartedAt: null,
          },
        });
      }
      return;
    }
    case "delete_openrouter": {
      const credential = await options.prisma.brandwellWorkspaceModelCredential.findUnique({
        where: { workspaceId },
      });
      if (credential?.externalKeyHash)
        await options.openRouter.deleteKey(credential.externalKeyHash);
      return;
    }
    case "revoke_connectors":
      await options.prisma.connection.updateMany({
        where: { workspaceId },
        data: { status: "revoked", providerRef: null, secretId: null },
      });
      return;
    case "destroy_computer": {
      const computers = await managedComputers(options.prisma, workspaceId);
      for (const computer of computers) {
        if (computer.providerRef) await options.computerLifecycle.destroy(computer);
        await options.prisma.computer.update({
          where: { id: computer.id },
          data: {
            state: "stopped",
            providerRef: null,
            screenUrl: null,
            lastComputerState: computer.state,
            lastComputerActivityAt: now,
          },
        });
      }
      return;
    }
    case "delete_secrets": {
      const identityIds = (
        await options.prisma.brandwellServiceIdentity.findMany({
          where: { workspaceId },
          select: { id: true },
        })
      ).map((identity) => identity.id);
      await options.prisma.brandwellWorkspaceModelCredential.deleteMany({ where: { workspaceId } });
      await options.prisma.secret.deleteMany({
        where: { workspaceId, serviceIdentityId: { in: identityIds } },
      });
      return;
    }
    case "archive_workspace":
      await options.prisma.$transaction([
        options.prisma.bot.updateMany({
          where: { workspaceId, archivedAt: null },
          data: { archivedAt: now, managedStatus: "canceled" },
        }),
        options.prisma.brandwellAiWorkspace.update({
          where: { rakazoWorkspaceId: workspaceId },
          data: { subscriptionStatus: "canceled", retentionEndsAt: now },
        }),
      ]);
      return;
  }
}

async function managedComputers(prisma: PrismaClient, workspaceId: string) {
  return prisma.computer.findMany({
    where: { workspaceId },
    select: {
      id: true,
      workspaceId: true,
      userId: true,
      homeKey: true,
      kind: true,
      providerRef: true,
      state: true,
    },
  });
}

function findMapping(prisma: PrismaClient, id: string) {
  return prisma.brandwellAiWorkspace.findFirst({
    where: { OR: [{ id }, { brandwellCustomerId: id }, { rakazoWorkspaceId: id }] },
  });
}

function safeError(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message.slice(0, 500)
    : "Cancellation action failed";
}
