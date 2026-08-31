import type {
  AdapterContext,
  AgentHomeStore,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { runJobKey } from "@rakazo/adapter-kit";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { toComputerRef } from "./computer-support.js";
import { checkpointAndRecordComputerWorkspace } from "./computer-workspace.js";

export class ManagedComputerStopPendingError extends Error {
  constructor(message = "The managed computer stop must be retried") {
    super(message);
    this.name = "ManagedComputerStopPendingError";
  }
}

export async function fenceManagedComputerForLifecycleInTransaction(
  tx: Prisma.TransactionClient,
  input: { computerId: string; botId: string; reason: string },
) {
  const now = new Date();
  const computer = await tx.computer.findFirst({
    where: {
      id: input.computerId,
      scope: "dedicated",
      bots: { some: { id: input.botId } },
    },
  });
  if (!computer) throw new ManagedComputerStopPendingError("Managed computer not found");

  const activeRuns = await tx.run.findMany({
    where: { botId: input.botId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    select: { id: true, taskId: true },
  });
  const runIds = activeRuns.map((run) => run.id);
  const taskIds = [...new Set(activeRuns.map((run) => run.taskId))];
  if (runIds.length > 0) {
    await tx.run.updateMany({
      where: { id: { in: runIds }, status: { in: [...ACTIVE_RUN_STATUSES] } },
      data: {
        status: "cancelled",
        completedAt: now,
        error: input.reason.slice(0, 500),
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
  }
  if (taskIds.length > 0) {
    await tx.task.updateMany({
      where: { id: { in: taskIds } },
      data: { status: "cancelled" },
    });
  }
  await tx.computerExecutionLease.deleteMany({ where: { computerId: computer.id } });
  const claimed = await tx.computer.updateMany({
    where: {
      id: computer.id,
      state: computer.state,
      providerRef: computer.providerRef,
    },
    data: {
      state: computer.providerRef ? "suspending" : "stopped",
      screenUrl: null,
      controlHolder: "none",
      controlLeaseId: null,
      controlLeaseExpiresAt: null,
      controlBotId: null,
      controlRunId: null,
      controlUserId: null,
      controlActorType: null,
      controlActorName: null,
      controlStartedAt: null,
      controlFence: { increment: 1 },
      executionRunId: null,
      executionBotId: null,
      executionLeaseExpiresAt: null,
      executionFence: { increment: 1 },
      lastComputerState: computer.state,
      lastComputerActivityAt: now,
    },
  });
  if (claimed.count !== 1) throw new ManagedComputerStopPendingError();
  return { computer, runIds };
}

export async function stopManagedComputerForLifecycle(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    home: AgentHomeStore;
    jobs?: JobPublisher;
  },
  input: {
    computerId: string;
    botId: string;
    reason: string;
    checkpointRequired: boolean;
    markCheckpointed(): Promise<void>;
  },
  context: AdapterContext,
): Promise<void> {
  const fenced = await deps.prisma.$transaction(
    (tx) => fenceManagedComputerForLifecycleInTransaction(tx, input),
    { isolationLevel: "Serializable" },
  );

  await Promise.allSettled(fenced.runIds.map((runId) => deps.jobs?.cancel(runJobKey(runId))));
  if (!fenced.computer.providerRef) return;

  const ref = toComputerRef(fenced.computer);
  if (
    input.checkpointRequired &&
    (fenced.computer.state === "running" || fenced.computer.state === "suspending")
  ) {
    await checkpointAndRecordComputerWorkspace(deps, fenced.computer, ref, context);
    await input.markCheckpointed();
  }
  await deps.sandbox.releaseScreen?.(ref, context).catch(() => undefined);
  await deps.sandbox.stop(ref, context);
  const stopped = await deps.prisma.computer.updateMany({
    where: {
      id: fenced.computer.id,
      state: "suspending",
      providerRef: fenced.computer.providerRef,
    },
    data: {
      state: "stopped",
      screenUrl: null,
      lastComputerState: fenced.computer.state,
      lastComputerActivityAt: new Date(),
    },
  });
  if (stopped.count === 1) return;
  const current = await deps.prisma.computer.findUnique({
    where: { id: fenced.computer.id },
    select: { state: true, providerRef: true },
  });
  if (current?.state === "stopped" && current.providerRef === fenced.computer.providerRef) return;
  throw new ManagedComputerStopPendingError();
}
