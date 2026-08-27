import {
  createBrandwellManagedModelResolver,
  OpenRouterManagementClient,
  reconcileBrandwellFleetHealth,
  reconcileBrandwellRetentionCleanupWithPrisma,
} from "@brandwell/aimee";
import type { JobPublisher, JobWorkerHost } from "@rakazo/adapter-kit";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";

loadRootEnv();

import {
  BrandwellNativeConnector,
  createBackgroundJobHandlers,
  createConnectorStack,
  createJobReconciler,
  createPostgresReconciliationLeadership,
  createRunExecutor,
  createRunSandbox,
  createRunSecretWriter,
  EncryptedSecretStore,
  ExpoPushProvider,
  GraphileJobPublisher,
  GraphileJobWorkerHost,
  InMemoryJobQueue,
  InstalledConnectorProvider,
  isComposioEnabled,
  isPipedreamEnabled,
  LocalAgentHomeStore,
  LocalArtifactStore,
  McpConnector,
  McpOAuthBroker,
  PiAgentRuntime,
  PipedreamConnector,
  PostgresRealtimeFanout,
  pipedreamConfigFromEnv,
  resolveDeploymentModel,
  ScriptedAgentRuntime,
  toComputerRef,
  WorkspaceMemoryProviderResolver,
} from "@rakazo/adapters";
import { resolveEncryptionKey } from "@rakazo/core";
import { createDb, createThreadEvents } from "@rakazo/db";
import { MarkdownMemoryStore } from "@rakazo/memory";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const { prisma, pool } = createDb(databaseUrl);
  const realtime = new PostgresRealtimeFanout({
    connectionString: process.env.REALTIME_DATABASE_URL ?? databaseUrl,
    publisher: pool,
  });
  const secrets = new EncryptedSecretStore(resolveEncryptionKey(process.env));
  const events = createThreadEvents(prisma, realtime, {
    runSecretWriter: createRunSecretWriter(secrets),
  });
  const runtime =
    process.env.AGENT_RUNTIME === "scripted" ? new ScriptedAgentRuntime() : new PiAgentRuntime();
  const dataDir = process.env.DATA_DIR ?? "./data";
  // Same resolver the API uses, so both processes agree on provider, model and key.
  const { key: deploymentModelKey } = resolveDeploymentModel();
  const sandbox = createRunSandbox(process.env.SANDBOX_PROVIDER ?? "docker", {
    supervisorUrl: process.env.SANDBOX_SUPERVISOR_URL ?? "http://127.0.0.1:7091",
    e2bApiKey: process.env.E2B_API_KEY,
    daytonaApiKey: process.env.DAYTONA_API_KEY,
    daytonaApiUrl: process.env.DAYTONA_API_URL,
    daytonaTarget: process.env.DAYTONA_TARGET,
    boxApiKey: process.env.BOX_API_KEY,
    boxApiUrl: process.env.BOX_API_URL ?? process.env.BOX_BASE_URL,
    dataDir,
    prisma,
  });
  const mcpOAuth = new McpOAuthBroker(prisma, secrets);
  const mcp = new McpConnector(
    prisma,
    secrets,
    {
      stdioEnabled: process.env.MCP_STDIO_ENABLED === "true",
      allowedCommands: (process.env.MCP_STDIO_ALLOWED_COMMANDS ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    },
    mcpOAuth,
  );
  const pipedreamConfig = pipedreamConfigFromEnv({
    pipedreamClientId: process.env.PIPEDREAM_CLIENT_ID,
    pipedreamClientSecret: process.env.PIPEDREAM_CLIENT_SECRET,
    pipedreamProjectId: process.env.PIPEDREAM_PROJECT_ID,
    pipedreamEnvironment: process.env.PIPEDREAM_ENVIRONMENT,
    encryptionKey: resolveEncryptionKey(process.env),
  });
  const pipedream = isPipedreamEnabled(pipedreamConfig)
    ? new PipedreamConnector(pipedreamConfig)
    : undefined;
  const brandwellPlatform = brandwellPlatformConfig(process.env);
  const brandwellNative = brandwellPlatform
    ? new BrandwellNativeConnector(prisma, brandwellPlatform)
    : undefined;
  const stack = createConnectorStack(isComposioEnabled(process.env.COMPOSIO_API_KEY), undefined, [
    new InstalledConnectorProvider(prisma, secrets),
    ...(pipedream ? [pipedream] : []),
    ...(brandwellNative ? [brandwellNative] : []),
    mcp,
  ]);
  const connector = stack.destination;
  await connector.start();
  const memoryProviders = new WorkspaceMemoryProviderResolver(prisma, secrets);
  const home = new LocalAgentHomeStore(dataDir);
  const artifacts = new LocalArtifactStore(dataDir);
  const inMemoryJobs = process.env.WAKEUP_DRIVER === "memory" ? new InMemoryJobQueue() : undefined;
  const jobs: JobPublisher = inMemoryJobs ?? new GraphileJobPublisher(databaseUrl);
  const jobHost: JobWorkerHost = inMemoryJobs ?? new GraphileJobWorkerHost(databaseUrl);
  const executor = createRunExecutor({
    prisma,
    runtime,
    sandbox,
    memory: new MarkdownMemoryStore(prisma),
    memoryProviders,
    home,
    artifacts,
    connector: stack.connector,
    connectors: stack.connector,
    listConnectedPluginSlugs: stack.composio?.listConnectedSlugs.bind(stack.composio),
    secrets: [
      deploymentModelKey ?? "",
      process.env.COMPOSIO_API_KEY ?? "",
      brandwellPlatform?.serviceToken ?? "",
    ].filter(Boolean),
    secretStore: secrets,
    deploymentModelKey,
    managedModelResolver: createBrandwellManagedModelResolver(prisma),
    dataDir,
    notifications: new ExpoPushProvider(dataDir),
    jobs,
    events,
  });

  const jobHandlers = createBackgroundJobHandlers({
    executor,
    prisma,
    sandbox,
    home,
    jobs,
    events,
    workerId: process.pid.toString(),
    runtime,
    secretStore: secrets,
    memoryProviders,
    deploymentModelKey,
  });
  await jobHost.start(jobHandlers);
  const reconciler = createJobReconciler({
    prisma,
    jobs,
    leadership: createPostgresReconciliationLeadership(pool),
  });
  reconciler.start();

  const brandwellMaintenanceIntervalMs = boundedInterval(
    process.env.BRANDWELL_HEALTH_INTERVAL_MS,
    60_000,
  );
  const openRouterManagement = process.env.OPENROUTER_MANAGEMENT_KEY?.trim()
    ? new OpenRouterManagementClient(process.env.OPENROUTER_MANAGEMENT_KEY.trim())
    : null;
  let brandwellMaintenanceRunning = false;
  const reconcileBrandwell = async () => {
    if (brandwellMaintenanceRunning) return;
    brandwellMaintenanceRunning = true;
    try {
      if (openRouterManagement) {
        await reconcileBrandwellRetentionCleanupWithPrisma(
          {
            prisma,
            openRouter: openRouterManagement,
            computerLifecycle: {
              suspend: (computer) =>
                computer.providerRef
                  ? sandbox.stop(toComputerRef(computer), cancellationComputerContext(computer))
                  : Promise.resolve(),
              destroy: (computer) =>
                computer.providerRef
                  ? sandbox.destroy(toComputerRef(computer), cancellationComputerContext(computer))
                  : Promise.resolve(),
            },
          },
          {
            retentionDays: nonNegativeInteger(process.env.BRANDWELL_RETENTION_DAYS, 30),
            deleteAfterRetention: process.env.BRANDWELL_DELETE_AFTER_RETENTION !== "false",
          },
        );
      }
      await reconcileBrandwellFleetHealth(prisma);
    } finally {
      brandwellMaintenanceRunning = false;
    }
  };
  const brandwellMaintenanceTimer = setInterval(() => {
    void reconcileBrandwell().catch((error) =>
      console.error("BrandWell fleet reconciliation", error),
    );
  }, brandwellMaintenanceIntervalMs);
  brandwellMaintenanceTimer.unref?.();
  void reconcileBrandwell().catch((error) =>
    console.error("BrandWell fleet reconciliation", error),
  );

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(brandwellMaintenanceTimer);
    await reconciler.stop();
    await jobHost.stop();
    await jobs.close();
    await realtime.close();
    await connector.stop();
    await mcp.close();
    await prisma.$disconnect().catch(() => undefined);
    await pool.end().catch(() => undefined);
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());

  console.log("rakazo worker ready");
}

function cancellationComputerContext(computer: {
  id: string;
  workspaceId: string;
  userId: string;
}) {
  return {
    operationId: `brandwell-retention:${computer.id}`,
    traceId: `brandwell-retention:${computer.id}`,
    workspaceId: computer.workspaceId,
    userId: computer.userId,
    signal: new AbortController().signal,
  };
}

function boundedInterval(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed >= 60_000 ? Math.trunc(parsed) : fallback;
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function brandwellPlatformConfig(source: NodeJS.ProcessEnv) {
  const apiBaseUrl = source.BRANDWELL_PLATFORM_API_URL?.trim();
  const serviceToken = source.BRANDWELL_PLATFORM_SERVICE_TOKEN?.trim();
  if (Boolean(apiBaseUrl) !== Boolean(serviceToken)) {
    throw new Error(
      "BRANDWELL_PLATFORM_API_URL and BRANDWELL_PLATFORM_SERVICE_TOKEN must be configured together",
    );
  }
  if (!apiBaseUrl || !serviceToken) return undefined;
  if (serviceToken.length < 32) {
    throw new Error("BRANDWELL_PLATFORM_SERVICE_TOKEN must be at least 32 characters");
  }
  return { apiBaseUrl, serviceToken };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
