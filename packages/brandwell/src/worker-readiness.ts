import type { PrismaClient } from "@rakazo/db";

export const BRANDWELL_READINESS_MIGRATION = "20260831011000_brandwell_production_readiness";
export const BRANDWELL_WORKER_HEARTBEAT_INTERVAL_MS = 15_000;
export const BRANDWELL_WORKER_HEARTBEAT_MAX_AGE_MS = 45_000;

type WorkerHeartbeatClient = Pick<PrismaClient, "brandwellWorkerHeartbeat">;

export interface BrandwellWorkerHeartbeatOptions {
  workerId: string;
  revision?: string;
  intervalMs?: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

export interface BrandwellWorkerHeartbeatHandle {
  stop(): Promise<void>;
}

export async function publishBrandwellWorkerHeartbeat(
  prisma: WorkerHeartbeatClient,
  options: Pick<BrandwellWorkerHeartbeatOptions, "workerId" | "revision"> & {
    now?: () => Date;
  },
): Promise<void> {
  const heartbeatAt = (options.now ?? (() => new Date()))();
  await prisma.brandwellWorkerHeartbeat.upsert({
    where: { id: options.workerId },
    create: {
      id: options.workerId,
      revision: options.revision,
      heartbeatAt,
    },
    update: {
      revision: options.revision,
      heartbeatAt,
    },
  });
}

export async function startBrandwellWorkerHeartbeat(
  prisma: WorkerHeartbeatClient,
  options: BrandwellWorkerHeartbeatOptions,
): Promise<BrandwellWorkerHeartbeatHandle> {
  const intervalMs = options.intervalMs ?? BRANDWELL_WORKER_HEARTBEAT_INTERVAL_MS;
  if (!Number.isInteger(intervalMs) || intervalMs < 1_000) {
    throw new Error("BrandWell worker heartbeat interval must be at least 1000 ms");
  }

  let stopped = false;
  let publishing = false;
  await publishBrandwellWorkerHeartbeat(prisma, options);

  const timer = setInterval(() => {
    if (stopped || publishing) return;
    publishing = true;
    void publishBrandwellWorkerHeartbeat(prisma, options)
      .catch((error) => options.onError?.(error))
      .finally(() => {
        publishing = false;
      });
  }, intervalMs);
  timer.unref?.();

  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await prisma.brandwellWorkerHeartbeat.deleteMany({
        where: { id: options.workerId },
      });
    },
  };
}
