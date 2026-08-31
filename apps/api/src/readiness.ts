import {
  BRANDWELL_READINESS_MIGRATION,
  BRANDWELL_WORKER_HEARTBEAT_MAX_AGE_MS,
} from "@brandwell/aimee";
import {
  type ProductionReadiness,
  type ProductionReadinessCheck,
  ProductionReadinessSchema,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import type { Hono } from "hono";
import type { AppEnv } from "./env.js";

export type ProductionReadinessConfig = Pick<
  AppEnv,
  | "agentRuntime"
  | "brandwellManagementApiToken"
  | "brandwellPlatformApiUrl"
  | "brandwellPlatformServiceToken"
  | "brandwellSystemUserId"
  | "daytonaApiKey"
  | "daytonaSnapshot"
  | "defaultModel"
  | "defaultProvider"
  | "deploymentModelKey"
  | "gitSha"
  | "openRouterManagementKey"
  | "sandboxProvider"
  | "wakeupDriver"
>;

export interface ProductionReadinessDataSource {
  ping(): Promise<void>;
  migrationApplied(migrationName: string): Promise<boolean>;
  systemUserExists(userId: string): Promise<boolean>;
  latestWorkerHeartbeat(revision?: string): Promise<{
    revision: string | null;
    heartbeatAt: Date;
  } | null>;
}

export interface ProductionReadinessDependencies {
  config: ProductionReadinessConfig;
  dataSource: ProductionReadinessDataSource;
  now?: () => Date;
  workerMaxAgeMs?: number;
}

const PASS: ProductionReadinessCheck = { status: "pass", code: "ok" };

function fail(code: string): ProductionReadinessCheck {
  return { status: "fail", code };
}

function configured(...values: Array<string | undefined>): boolean {
  return values.every((value) => Boolean(value?.trim()));
}

export function createPrismaProductionReadinessDataSource(
  prisma: PrismaClient,
): ProductionReadinessDataSource {
  return {
    ping: async () => {
      await prisma.$queryRawUnsafe("SELECT 1");
    },
    migrationApplied: async (migrationName) => {
      const rows = await prisma.$queryRawUnsafe<Array<{ applied: boolean }>>(
        `SELECT EXISTS (
           SELECT 1
           FROM "_prisma_migrations"
           WHERE "migration_name" = $1
             AND "finished_at" IS NOT NULL
             AND "rolled_back_at" IS NULL
         ) AS "applied"`,
        migrationName,
      );
      return rows[0]?.applied === true;
    },
    systemUserExists: async (userId) =>
      Boolean(
        await prisma.user.findUnique({
          where: { id: userId },
          select: { id: true },
        }),
      ),
    latestWorkerHeartbeat: (revision) =>
      prisma.brandwellWorkerHeartbeat.findFirst({
        ...(revision ? { where: { revision } } : {}),
        orderBy: { heartbeatAt: "desc" },
        select: { revision: true, heartbeatAt: true },
      }),
  };
}

export async function evaluateProductionReadiness(
  dependencies: ProductionReadinessDependencies,
): Promise<ProductionReadiness> {
  const { config, dataSource } = dependencies;
  const now = (dependencies.now ?? (() => new Date()))();
  const workerMaxAgeMs = dependencies.workerMaxAgeMs ?? BRANDWELL_WORKER_HEARTBEAT_MAX_AGE_MS;

  const managedAdminConfigured = configured(
    config.brandwellManagementApiToken,
    config.brandwellSystemUserId,
  );
  const checks: ProductionReadiness["checks"] = {
    deploymentRevision: /^[0-9a-f]{40}$/.test(config.gitSha ?? "")
      ? PASS
      : fail("revision_invalid"),
    database: fail("not_checked"),
    migrations: fail("not_checked"),
    worker:
      config.wakeupDriver === "graphile" ? fail("not_checked") : fail("unsupported_job_driver"),
    managedAdmin: managedAdminConfigured ? fail("not_checked") : fail("configuration_missing"),
    openRouterManagement: configured(config.openRouterManagementKey)
      ? PASS
      : fail("configuration_missing"),
    runtimeInference:
      config.agentRuntime !== "pi"
        ? fail("unsupported_runtime")
        : config.defaultProvider !== "openrouter"
          ? fail("unsupported_provider")
          : configured(config.defaultModel, config.deploymentModelKey)
            ? PASS
            : fail("configuration_missing"),
    daytona:
      config.sandboxProvider !== "daytona"
        ? fail("unsupported_sandbox")
        : configured(config.daytonaApiKey, config.daytonaSnapshot)
          ? PASS
          : fail("configuration_missing"),
    brandwellBridge: configured(
      config.brandwellPlatformApiUrl,
      config.brandwellPlatformServiceToken,
    )
      ? PASS
      : fail("configuration_missing"),
  };

  try {
    await dataSource.ping();
    checks.database = PASS;
  } catch {
    checks.database = fail("database_unreachable");
    checks.migrations = fail("dependency_unavailable");
    if (config.wakeupDriver === "graphile") {
      checks.worker = fail("dependency_unavailable");
    }
    if (managedAdminConfigured) checks.managedAdmin = fail("dependency_unavailable");
  }

  if (checks.database.status === "pass") {
    const [migration, worker, systemUser] = await Promise.allSettled([
      dataSource.migrationApplied(BRANDWELL_READINESS_MIGRATION),
      config.wakeupDriver === "graphile"
        ? dataSource.latestWorkerHeartbeat(config.gitSha)
        : Promise.resolve(null),
      managedAdminConfigured
        ? dataSource.systemUserExists(config.brandwellSystemUserId!)
        : Promise.resolve(false),
    ]);

    checks.migrations =
      migration.status === "fulfilled" && migration.value
        ? PASS
        : fail(migration.status === "fulfilled" ? "migration_missing" : "migration_query_failed");

    if (config.wakeupDriver === "graphile") {
      if (worker.status === "rejected") {
        checks.worker = fail("worker_query_failed");
      } else if (worker.value === null) {
        checks.worker = fail("worker_missing");
      } else {
        const ageMs = now.getTime() - worker.value.heartbeatAt.getTime();
        if (ageMs < 0 || ageMs > workerMaxAgeMs) {
          checks.worker = fail("worker_stale");
        } else if (config.gitSha && worker.value.revision !== config.gitSha) {
          checks.worker = fail("worker_revision_mismatch");
        } else {
          checks.worker = PASS;
        }
      }
    }

    if (managedAdminConfigured) {
      checks.managedAdmin =
        systemUser.status === "fulfilled" && systemUser.value
          ? PASS
          : fail(
              systemUser.status === "fulfilled"
                ? "system_user_missing"
                : "system_user_query_failed",
            );
    }
  }

  const report: ProductionReadiness = {
    ok: Object.values(checks).every((check) => check.status === "pass"),
    service: "aimee",
    revision: config.gitSha ?? null,
    checkedAt: now.toISOString(),
    checks,
  };
  return ProductionReadinessSchema.parse(report);
}

export function mountProductionReadinessRoute(
  app: Hono,
  dependencies: ProductionReadinessDependencies,
): void {
  app.get("/ready", async (context) => {
    const report = await evaluateProductionReadiness(dependencies);
    context.header("cache-control", "no-store");
    return context.json(report, report.ok ? 200 : 503);
  });
}
