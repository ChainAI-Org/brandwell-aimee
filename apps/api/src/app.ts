import { rm } from "node:fs/promises";
import {
  bindBrandwellUserAccess,
  brandwellPlatformModelDefault,
  cancelBrandwellWorkspaceWithPrisma,
  createBrandwellManagedModelResolver,
  microsToUsd,
  OpenRouterManagementClient,
  provisionBrandwellSidekickWithPrisma,
  provisionBrandwellWorkspaceWithPrisma,
  reconcileBrandwellOpenRouterUsage,
  requireBrandwellUserAccess,
  rolloutBrandwellSkillBundleWithPrisma,
  setBrandwellSidekickLifecycleWithPrisma,
  syncBrandwellWorkspaceDesiredStateWithPrisma,
} from "@brandwell/aimee";
import { RPCHandler } from "@orpc/server/fetch";
import type {
  JobPublisher,
  ManagedConnectorProvider,
  RealtimeFanout,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import {
  BrandwellNativeConnector,
  type ComposioProvider,
  type ConnectorRegistry,
  createBackgroundJobHandlers,
  createConnectorStack,
  createJobReconciler,
  createRunExecutor,
  createRunSandbox,
  createRunSecretWriter,
  type DestinationEmulator,
  destroyBot,
  EncryptedSecretStore,
  ExpoPushProvider,
  fenceManagedComputerForLifecycleInTransaction,
  GraphileJobPublisher,
  InMemoryJobQueue,
  InMemoryRealtimeFanout,
  InstalledConnectorProvider,
  isComposioEnabled,
  isPipedreamEnabled,
  LocalAgentHomeStore,
  LocalArtifactStore,
  McpConnector,
  McpOAuthBroker,
  PiAgentRuntime,
  PiOAuthLogins,
  PipedreamConnector,
  PostgresRealtimeFanout,
  pipedreamConfigFromEnv,
  pushTokenPath,
  type RemoteConnectorDependencies,
  ScriptedAgentRuntime,
  stopManagedComputerForLifecycle,
  toComputerRef,
  WorkspaceMemoryProviderResolver,
} from "@rakazo/adapters";
import { blockedAuthPaths, createAuth } from "@rakazo/auth";
import { createDb, createThreadEvents, type PrismaClient, requireMembership } from "@rakazo/db";
import { MarkdownMemoryStore } from "@rakazo/memory";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { mountBrandwellManagementRoutes } from "./brandwell-management.js";
import {
  bootBrandwellSupportComputer,
  getBrandwellSupportScreen,
  releaseBrandwellSupportControl,
  takeBrandwellSupportControl,
} from "./brandwell-support.js";
import { BrandwellPlatformAuthClient } from "./brandwell-user-auth.js";
import { type AppEnv, loadEnv } from "./env.js";
import { BRANDWELL_MANAGED_ORIGINS, isTrustedOrigin } from "./origin-policy.js";
import {
  createPrismaProductionReadinessDataSource,
  mountProductionReadinessRoute,
} from "./readiness.js";
import { createRouter } from "./router.js";
import { mountVoiceHttpRoutes } from "./voice.js";

export interface AppHandles {
  app: Hono;
  prisma: PrismaClient;
  jobs: JobPublisher;
  sandbox: SandboxProvider;
  connector: DestinationEmulator;
  composio?: ComposioProvider;
  connectors: ConnectorRegistry;
  executor: ReturnType<typeof createRunExecutor>;
  stop: () => Promise<void>;
}

export async function createApp(
  overrides: Partial<AppEnv> & {
    prisma?: PrismaClient;
    realtime?: RealtimeFanout;
    composio?: ComposioProvider;
    pipedream?: ManagedConnectorProvider;
    remoteConnectors?: RemoteConnectorDependencies;
  } = {},
): Promise<AppHandles> {
  const {
    prisma: prismaOverride,
    realtime: realtimeOverride,
    composio: composioOverride,
    pipedream: pipedreamOverride,
    remoteConnectors,
    ...envOverrides
  } = overrides;
  const env = { ...loadEnv(process.env), ...envOverrides };
  const created = prismaOverride
    ? { prisma: prismaOverride, pool: undefined }
    : createDb(env.databaseUrl);
  const { prisma } = created;
  created.pool?.on("error", () => undefined);
  const realtime =
    realtimeOverride ??
    (created.pool
      ? new PostgresRealtimeFanout({
          connectionString: env.realtimeDatabaseUrl,
          publisher: created.pool,
        })
      : new InMemoryRealtimeFanout());
  const secrets = new EncryptedSecretStore(env.encryptionKey);
  const events = createThreadEvents(prisma, realtime, {
    runSecretWriter: createRunSecretWriter(secrets),
  });
  await prisma.deploymentSettings.upsert({
    where: { id: "default" },
    create: { id: "default" },
    update: {},
  });

  const jobKind = env.wakeupDriver;
  const inMemoryJobs = jobKind === "memory" ? new InMemoryJobQueue() : undefined;
  const jobs = inMemoryJobs ?? new GraphileJobPublisher(env.databaseUrl);
  const sandbox: SandboxProvider = createRunSandbox(env.sandboxProvider, {
    supervisorUrl: env.sandboxSupervisorUrl,
    supervisorToken: env.sandboxSupervisorToken,
    e2bApiKey: env.e2bApiKey,
    daytonaApiKey: env.daytonaApiKey,
    daytonaApiUrl: env.daytonaApiUrl,
    daytonaTarget: env.daytonaTarget,
    daytonaSnapshot: env.daytonaSnapshot,
    daytonaAutoStopInterval: env.daytonaAutoStopInterval,
    daytonaAutoArchiveInterval: env.daytonaAutoArchiveInterval,
    daytonaAutoDeleteInterval: env.daytonaAutoDeleteInterval,
    daytonaVncResolution: env.daytonaVncResolution,
    daytonaLocale: env.daytonaLocale,
    daytonaTimezone: env.daytonaTimezone,
    boxApiKey: env.boxApiKey,
    boxApiUrl: env.boxApiUrl,
    dataDir: env.dataDir,
    prisma,
  });
  const mcpOAuth = new McpOAuthBroker(prisma, secrets, remoteConnectors);
  const memoryProviders = new WorkspaceMemoryProviderResolver(prisma, secrets);
  const oauthLogins = new PiOAuthLogins();
  const home = new LocalAgentHomeStore(env.dataDir);
  const artifacts = new LocalArtifactStore(env.dataDir);
  const memory = new MarkdownMemoryStore(prisma);
  const mcp = new McpConnector(
    prisma,
    secrets,
    {
      stdioEnabled: env.mcpStdioEnabled,
      allowedCommands: env.mcpStdioAllowedCommands,
      network: remoteConnectors,
    },
    mcpOAuth,
  );
  const pipedreamConfig = pipedreamConfigFromEnv(env);
  const pipedream =
    pipedreamOverride ??
    (isPipedreamEnabled(pipedreamConfig) ? new PipedreamConnector(pipedreamConfig) : undefined);
  const installed = new InstalledConnectorProvider(prisma, secrets, remoteConnectors);
  const brandwellNative =
    env.brandwellPlatformApiUrl && env.brandwellPlatformServiceToken
      ? new BrandwellNativeConnector(prisma, {
          apiBaseUrl: env.brandwellPlatformApiUrl,
          serviceToken: env.brandwellPlatformServiceToken,
        })
      : undefined;
  const stack = createConnectorStack(isComposioEnabled(env.composioApiKey), composioOverride, [
    installed,
    ...(pipedream ? [pipedream] : []),
    ...(brandwellNative ? [brandwellNative] : []),
    mcp,
  ]);
  const connector = stack.destination;
  await connector.start();
  void stack.composio?.warmDirectory().catch(() => undefined);
  void pipedream?.warmDirectory?.().catch(() => undefined);
  const runtime =
    env.agentRuntime === "scripted" ? new ScriptedAgentRuntime() : new PiAgentRuntime();
  const notifications = new ExpoPushProvider(env.dataDir);
  const brandwellUserAuth =
    env.brandwellPlatformApiUrl && env.brandwellPlatformServiceToken
      ? new BrandwellPlatformAuthClient(
          env.brandwellPlatformApiUrl,
          env.brandwellPlatformServiceToken,
        )
      : null;
  const auth = createAuth(prisma, {
    secret: env.authSecret,
    baseURL: env.authUrl,
    webOrigin: env.webOrigin,
    signupsEnabled: env.signupsEnabled,
    signupAllowlist: env.signupAllowlist,
    ...(brandwellUserAuth
      ? {
          authenticateBrandwell: async (credentials) =>
            bindBrandwellUserAccess(
              prisma,
              await brandwellUserAuth.authenticate(credentials.email, credentials.password),
            ),
        }
      : {}),
    extraOrigins: [
      ...BRANDWELL_MANAGED_ORIGINS,
      "aimee://",
      "exp://",
      "exp://*",
      "http://localhost:8081",
      "http://127.0.0.1:8081",
      "http://localhost:19006",
      "http://127.0.0.1:19006",
    ],
    beforeDeleteUser: async (userId) => {
      const bots = await prisma.bot.findMany({
        where: { userId },
        select: { id: true, workspaceId: true, name: true, archivedAt: true },
      });
      await Promise.all(
        bots.map((bot) =>
          destroyBot(
            { prisma, sandbox, home, jobs, artifacts, dataDir: env.dataDir },
            bot,
            {
              operationId: `account-delete:${userId}`,
              traceId: `account-delete:${userId}`,
              workspaceId: bot.workspaceId,
              userId,
              botId: bot.id,
              signal: new AbortController().signal,
            },
            { deleteMemories: true },
          ),
        ),
      );
      await rm(pushTokenPath(env.dataDir, userId), { force: true }).catch(() => undefined);
    },
  });
  const executor = createRunExecutor({
    prisma,
    runtime,
    sandbox,
    memory,
    memoryProviders,
    home,
    artifacts,
    connector: stack.connector,
    connectors: stack.connector,
    listConnectedPluginSlugs: stack.composio?.listConnectedSlugs.bind(stack.composio),
    secrets: [
      env.deploymentModelKey ?? "",
      env.composioApiKey ?? "",
      env.brandwellPlatformServiceToken ?? "",
    ].filter(Boolean),
    secretStore: secrets,
    deploymentModelKey: env.deploymentModelKey,
    managedModelResolver: createBrandwellManagedModelResolver(prisma),
    dataDir: env.dataDir,
    notifications,
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
    workerId: "api",
    runtime,
    secretStore: secrets,
    memoryProviders,
    deploymentModelKey: env.deploymentModelKey,
  });
  if (inMemoryJobs) {
    await inMemoryJobs.start(jobHandlers);
  }
  const reconciler = inMemoryJobs ? createJobReconciler({ prisma, jobs }) : undefined;
  reconciler?.start();

  const router = createRouter({
    prisma,
    events,
    auth,
    jobs,
    sandbox,
    memory,
    memoryProviders,
    home,
    secrets,
    oauthLogins,
    mcpOAuth,
    composio: stack.composio,
    connectors: stack.connector,
    remoteConnectors,
    artifacts,
    dataDir: env.dataDir,
    env: {
      defaultProvider: env.defaultProvider,
      defaultModel: env.defaultModel,
      deploymentModelKey: env.deploymentModelKey,
      webOrigin: env.webOrigin,
      screenProxySecret: env.authSecret,
      sandboxProvider: env.sandboxProvider,
    },
  });
  const rpc = new RPCHandler(router);
  const app = new Hono();
  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (!origin) return env.webOrigin;
        return isTrustedOrigin(origin, env) ? origin : "";
      },
      credentials: true,
    }),
  );
  app.on(["GET", "POST"], "/api/auth/*", async (c) => {
    const path = new URL(c.req.url).pathname.replace("/api/auth", "");
    if (blockedAuthPaths.some((blocked) => path.startsWith(blocked))) {
      return c.json({ error: "Not available in version 1" }, 404);
    }
    if (
      brandwellUserAuth &&
      [
        "/sign-in/email",
        "/sign-up/email",
        "/change-password",
        "/set-password",
        "/change-email",
        "/delete-user",
      ].some((blocked) => path.startsWith(blocked))
    ) {
      return c.json(
        {
          error: "Sign in with your BrandWell account.",
          code: "aimee_brandwell_login_required",
        },
        404,
      );
    }
    if (brandwellUserAuth && path === "/get-session") {
      const session = await auth.api.getSession({ headers: sessionHeaders(c.req.raw) });
      if (session?.user) {
        try {
          await requireBrandwellUserAccess(prisma, session.user.id);
        } catch (error) {
          await prisma.session.deleteMany({ where: { userId: session.user.id } });
          return managedAccessError(c, error);
        }
      }
    }
    return auth.handler(c.req.raw);
  });
  if (env.brandwellManagementApiToken) {
    const openRouterManagement = env.openRouterManagementKey
      ? new OpenRouterManagementClient(env.openRouterManagementKey)
      : null;
    const supportComputerDeps = env.brandwellSystemUserId
      ? {
          prisma,
          sandbox,
          home,
          jobs,
          events,
          dataDir: env.dataDir,
          systemUserId: env.brandwellSystemUserId,
          screenProxySecret: env.authSecret,
          webOrigin: env.webOrigin,
        }
      : null;
    mountBrandwellManagementRoutes(app, {
      prisma,
      token: env.brandwellManagementApiToken,
      jobs,
      ...(supportComputerDeps
        ? {
            computerSupport: {
              boot: (input) => bootBrandwellSupportComputer(supportComputerDeps, input),
              takeControl: (input) => takeBrandwellSupportControl(supportComputerDeps, input),
              screen: (input) => getBrandwellSupportScreen(supportComputerDeps, input),
              release: (input) => releaseBrandwellSupportControl(supportComputerDeps, input),
            },
          }
        : {}),
      ...(openRouterManagement
        ? {
            provisionWorkspace: async (input) =>
              provisionBrandwellWorkspaceWithPrisma(input, {
                prisma,
                secretCipher: {
                  encrypt: async (plaintext, context) => {
                    const stored = await secrets.put(plaintext, {
                      operationId: `brandwell-provision:${context.workspaceId}`,
                      traceId: `brandwell-provision:${context.workspaceId}`,
                      workspaceId: context.workspaceId,
                      userId: context.userId,
                      signal: new AbortController().signal,
                    });
                    return stored.ciphertext;
                  },
                },
                openRouter: openRouterManagement,
                systemUserId: env.brandwellSystemUserId,
                sandboxKind: env.sandboxProvider,
                defaultModel: await brandwellPlatformModelDefault(prisma),
                computerModel: env.brandwellComputerModel,
                lightweightModel: env.brandwellLightweightModel,
                reasoningModel: env.brandwellReasoningModel,
                fallbackModels: env.brandwellFallbackModels,
                monthlyLimitMicros: usdToMicros(env.brandwellOpenRouterMonthlyLimitUsd),
                warningLimitMicros: usdToMicros(env.brandwellOpenRouterWarningLimitUsd),
                ...(env.brandwellOpenRouterDailyLimitUsd
                  ? { dailyLimitMicros: usdToMicros(env.brandwellOpenRouterDailyLimitUsd) }
                  : {}),
              }),
            cancelWorkspace: (workspaceId, reason) =>
              cancelBrandwellWorkspaceWithPrisma(
                workspaceId,
                reason,
                {
                  retentionDays: env.brandwellRetentionDays,
                  deleteAfterRetention: env.brandwellDeleteAfterRetention,
                },
                {
                  prisma,
                  openRouter: openRouterManagement,
                  computerLifecycle: {
                    suspend: (computer) =>
                      computer.providerRef
                        ? sandbox.stop(toComputerRef(computer), brandwellComputerContext(computer))
                        : Promise.resolve(),
                    destroy: (computer) =>
                      computer.providerRef
                        ? sandbox.destroy(
                            toComputerRef(computer),
                            brandwellComputerContext(computer),
                          )
                        : Promise.resolve(),
                  },
                },
              ),
            syncDesiredState: (workspaceId, input) =>
              syncBrandwellWorkspaceDesiredStateWithPrisma(
                workspaceId,
                input,
                prisma,
                openRouterManagement,
              ),
            provisionSidekick: async (workspaceId, input) =>
              provisionBrandwellSidekickWithPrisma(workspaceId, input, {
                prisma,
                secretCipher: {
                  encrypt: async (plaintext, context) => {
                    const stored = await secrets.put(plaintext, {
                      operationId: `brandwell-sidekick:${input.brandwellSidekickId}`,
                      traceId: `brandwell-sidekick:${input.brandwellSidekickId}`,
                      workspaceId: context.workspaceId,
                      userId: context.userId,
                      signal: new AbortController().signal,
                    });
                    return stored.ciphertext;
                  },
                },
                openRouter: openRouterManagement,
                systemUserId: env.brandwellSystemUserId,
                sandboxKind: env.sandboxProvider,
                defaultModel: await brandwellPlatformModelDefault(prisma),
                monthlyLimitMicros: usdToMicros(env.brandwellOpenRouterMonthlyLimitUsd),
                warningLimitMicros: usdToMicros(env.brandwellOpenRouterWarningLimitUsd),
                ...(env.brandwellOpenRouterDailyLimitUsd
                  ? { dailyLimitMicros: usdToMicros(env.brandwellOpenRouterDailyLimitUsd) }
                  : {}),
              }),
            setSidekickLifecycle: (sidekickId, action, input) =>
              setBrandwellSidekickLifecycleWithPrisma(sidekickId, action, {
                prisma,
                openRouter: openRouterManagement,
                idempotencyKey: input.idempotencyKey,
                auditMetadata: input.auditMetadata,
                computerLifecycle: {
                  fence: (tx, request) =>
                    fenceManagedComputerForLifecycleInTransaction(tx, {
                      computerId: request.computerId,
                      botId: request.botId,
                      reason: `BrandWell Sidekick ${request.action} requested`,
                    }).then(() => undefined),
                  stop: (request) =>
                    stopManagedComputerForLifecycle(
                      { prisma, sandbox, home, jobs },
                      {
                        computerId: request.computerId,
                        botId: request.botId,
                        reason: `BrandWell Sidekick ${request.action} requested`,
                        checkpointRequired: request.checkpointRequired,
                        markCheckpointed: request.markCheckpointed,
                      },
                      brandwellSidekickLifecycleContext(request),
                    ),
                },
              }),
            rolloutSkillBundle: (workspaceId) =>
              rolloutBrandwellSkillBundleWithPrisma(workspaceId, prisma),
            reconcileModelUsage: (workspaceId) =>
              reconcileBrandwellOpenRouterUsage(prisma, openRouterManagement, workspaceId),
            validateOpenRouterModel: async (modelId) => {
              const model = await openRouterManagement.getModel(modelId);
              if (
                !model?.outputModalities.includes("text") ||
                !model.supportedParameters.includes("tools")
              ) {
                return null;
              }
              return model;
            },
            updateOpenRouterLimit: async (keyHash, monthlyLimitMicros) => {
              await openRouterManagement.updateKey(keyHash, {
                limitUsd: monthlyLimitMicros > 0n ? microsToUsd(monthlyLimitMicros) : null,
                limitReset: monthlyLimitMicros > 0n ? "monthly" : null,
              });
            },
          }
        : {}),
    });
  }
  app.use("/rpc/*", async (c, next) => {
    const session = await auth.api.getSession({ headers: sessionHeaders(c.req.raw) });
    let actor = null;
    if (session?.user) {
      if (brandwellUserAuth) {
        try {
          actor = await requireBrandwellUserAccess(prisma, session.user.id);
        } catch (error) {
          await prisma.session.deleteMany({ where: { userId: session.user.id } });
          return managedAccessError(c, error, true);
        }
      } else {
        actor = await requireMembership(prisma, session.user.id).catch(() => null);
      }
    }
    const { matched, response } = await rpc.handle(c.req.raw, {
      prefix: "/rpc",
      context: { actor, signal: c.req.raw.signal },
    });
    if (matched) return c.newResponse(response.body, response);
    await next();
  });
  mountVoiceHttpRoutes(app, { prisma, secrets }, async (c) => {
    const session = await auth.api.getSession({ headers: sessionHeaders(c.req.raw) });
    if (!session?.user) return null;
    if (brandwellUserAuth) {
      return requireBrandwellUserAccess(prisma, session.user.id).catch(async () => {
        await prisma.session.deleteMany({ where: { userId: session.user.id } });
        return null;
      });
    }
    return requireMembership(prisma, session.user.id).catch(() => null);
  });
  mountProductionReadinessRoute(app, {
    config: env,
    dataSource: createPrismaProductionReadinessDataSource(prisma),
  });
  app.get("/health", (c) =>
    c.json({
      ok: true,
      runtime: env.agentRuntime,
      sandbox: env.sandboxProvider,
      composio: Boolean(stack.composio),
      pipedream: Boolean(pipedream),
      jobs: jobKind,
      realtime: realtime.describe().id,
      revision: env.gitSha ?? null,
    }),
  );

  return {
    app,
    prisma,
    jobs,
    sandbox,
    connector,
    composio: stack.composio,
    connectors: stack.connector,
    executor,
    stop: async () => {
      oauthLogins.abortAll();
      await reconciler?.stop();
      await jobs.close();
      await realtime.close();
      await connector.stop();
      await mcp.close();
      await prisma.$disconnect().catch(() => undefined);
      await created.pool?.end().catch(() => undefined);
    },
  };
}

function usdToMicros(usd: number): bigint {
  return BigInt(Math.round(usd * 1_000_000));
}

function brandwellComputerContext(computer: { id: string; workspaceId: string; userId: string }) {
  return {
    operationId: `brandwell-cancellation:${computer.id}`,
    traceId: `brandwell-cancellation:${computer.id}`,
    workspaceId: computer.workspaceId,
    userId: computer.userId,
    signal: new AbortController().signal,
  };
}

function brandwellSidekickLifecycleContext(input: {
  operationId: string;
  action: "pause" | "cancel";
  botId: string;
  workspaceId: string;
  userId: string;
}) {
  const operationId = `brandwell-sidekick-lifecycle:${input.operationId}:${input.action}`;
  return {
    operationId,
    traceId: operationId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    botId: input.botId,
    signal: new AbortController().signal,
  };
}

function sessionHeaders(request: Request) {
  const headers = new Headers(request.headers);
  const authz = headers.get("authorization");
  if (authz?.toLowerCase().startsWith("bearer ") && !headers.get("cookie")) {
    headers.set("cookie", `better-auth.session_token=${authz.slice(7).trim()}`);
  }
  return headers;
}

function managedAccessError(c: Context, error: unknown, nested = false) {
  const candidate = error as { message?: unknown; code?: unknown; statusCode?: unknown };
  const status = Number(candidate?.statusCode || 403);
  const allowedStatus = [400, 401, 402, 403, 409, 500, 502, 503].includes(status) ? status : 403;
  const details = {
    message:
      typeof candidate?.message === "string" && candidate.message.trim()
        ? candidate.message
        : "AIMEE access is not active for this BrandWell user.",
    code: typeof candidate?.code === "string" ? candidate.code : "aimee_access_inactive",
  };
  return c.json(
    nested ? { error: details } : details,
    allowedStatus as 400 | 401 | 402 | 403 | 409 | 500 | 502 | 503,
  );
}
