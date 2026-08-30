import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

describe("account preferences", () => {
  function preferencesDeps(
    avatarStyle: string,
    options: {
      brandwell?: {
        plan: string;
        subscriptionStatus: string;
        provisioningStatus: string;
        primaryBotId: string | null;
      } | null;
      managedCredential?: {
        provider: string;
        preferredModel: string;
        status: string;
        disabledAt: Date | null;
      } | null;
    } = {},
  ) {
    const update = vi.fn().mockResolvedValue({});
    const prisma = {
      user: {
        update,
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          email: "user@rakazo.test",
          name: "Test User",
          avatarStyle,
        }),
      },
      userModelCredential: { findFirst: vi.fn().mockResolvedValue(null) },
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
      member: { findFirst: vi.fn().mockResolvedValue({ role: "owner" }) },
      brandwellAiWorkspace: {
        findUnique: vi.fn().mockResolvedValue(options.brandwell ?? null),
      },
      brandwellWorkspaceModelCredential: {
        findUnique: vi.fn().mockResolvedValue(options.managedCredential ?? null),
      },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      workspaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    return { update, deps, actor, handler: new RPCHandler(createRouter(deps)) };
  }

  it("persists and returns the selected avatar style", async () => {
    const { update, actor, handler } = preferencesDeps("organic");

    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/preferences/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { avatarStyle: "organic" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { avatarStyle: "organic" },
    });
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ avatarStyle: "organic" }),
    });
  });

  it("rejects avatar styles outside robot|organic", async () => {
    const { update, actor, handler } = preferencesDeps("robot");

    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/preferences/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { avatarStyle: "dicebear" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(update).not.toHaveBeenCalled();
  });

  it("coerces unknown stored avatar styles to robot on me", async () => {
    const { actor, handler } = preferencesDeps("custom-cdn");

    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/me", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: null }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ avatarStyle: "robot" }),
    });
  });

  it("returns managed BrandWell workspace metadata without asking the client for a model key", async () => {
    const { actor, handler } = preferencesDeps("robot", {
      brandwell: {
        plan: "aimee",
        subscriptionStatus: "active",
        provisioningStatus: "ready",
        primaryBotId: "bot-aimee",
      },
      managedCredential: {
        provider: "openrouter",
        preferredModel: "anthropic/claude-sonnet-4.5",
        status: "active",
        disabledAt: null,
      },
    });

    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/me", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: null }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({
        needsModel: false,
        defaultProvider: "openrouter",
        defaultModel: "anthropic/claude-sonnet-4.5",
        workspaceRole: "owner",
        brandwell: {
          plan: "aimee",
          subscriptionStatus: "active",
          provisioningStatus: "ready",
          primaryBotId: "bot-aimee",
        },
      }),
    });
  });
});

describe("BrandWell managed workspace self-service governance", () => {
  const actor = {
    workspaceId: "workspace-1",
    userId: "client-user-1",
    email: "client@example.com",
    isDeploymentOwner: false,
  } satisfies Actor;

  function governanceHandler() {
    const findManagedWorkspace = vi.fn(async () => ({ id: "brandwell-workspace-1" }));
    const putSecret = vi.fn();
    const transaction = vi.fn();
    const deps = {
      prisma: {
        brandwellAiWorkspace: { findUnique: findManagedWorkspace },
        $transaction: transaction,
      } as unknown as PrismaClient,
      secrets: { put: putSecret },
      env: {
        defaultProvider: "openrouter",
        defaultModel: "openai/gpt-5.4-mini",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/aimee-router-governance-test",
    } as unknown as RouterDeps;
    return {
      findManagedWorkspace,
      putSecret,
      transaction,
      handler: new RPCHandler(createRouter(deps)),
    };
  }

  async function post(
    handler: ReturnType<typeof governanceHandler>["handler"],
    path: string,
    json: unknown,
  ) {
    return handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
  }

  it("blocks connecting a personal model credential", async () => {
    const { handler, findManagedWorkspace, putSecret } = governanceHandler();
    const { response } = await post(handler, "models/connect", {
      provider: "openrouter",
      apiKey: "sk-or-client-key",
    });

    expect(response.status).toBe(403);
    expect(findManagedWorkspace).toHaveBeenCalledWith({
      where: { rakazoWorkspaceId: "workspace-1" },
      select: { id: true },
    });
    expect(putSecret).not.toHaveBeenCalled();
  });

  it("blocks changing the personal default model", async () => {
    const { handler, transaction } = governanceHandler();
    const { response } = await post(handler, "models/setDefault", {
      provider: "openrouter",
      modelId: "openai/gpt-5.4-mini",
    });

    expect(response.status).toBe(403);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("blocks ordinary AI employee creation", async () => {
    const { handler, transaction } = governanceHandler();
    const { response } = await post(handler, "bots/create", { name: "Bypass bot" });

    expect(response.status).toBe(403);
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("BrandWell client notifications", () => {
  const actor = {
    workspaceId: "workspace-1",
    userId: "client-user-1",
    email: "client@example.com",
    isDeploymentOwner: false,
  } satisfies Actor;
  const row = {
    id: "notice-1",
    workspaceId: "workspace-1",
    botId: "bot-1",
    runId: "run-1",
    dedupeKey: "alert:login",
    type: "LOGIN_REQUIRED",
    title: "AIMEE needs your help",
    body: "Complete the login so AIMEE can continue.",
    severity: "WARNING",
    requiresAction: true,
    actionType: "OPEN_COMPUTER",
    actionTarget: "/computer?botId=bot-1",
    createdAt: new Date("2026-08-27T18:00:00.000Z"),
    readAt: null,
    resolvedAt: null,
    resolvedBy: null,
  };

  function notificationHandler(prisma: object) {
    const deps = {
      prisma,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    return new RPCHandler(createRouter(deps));
  }

  it("lists only the signed-in workspace notifications", async () => {
    const findMany = vi.fn().mockResolvedValue([row]);
    const handler = notificationHandler({ brandwellClientNotification: { findMany } });
    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/notifications/list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { includeResolved: false } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    expect(response.status).toBe(200);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "workspace-1", resolvedAt: null },
      }),
    );
    await expect(response.json()).resolves.toEqual({
      json: [
        expect.objectContaining({
          id: "notice-1",
          actionTarget: "/computer?botId=bot-1",
          createdAt: "2026-08-27T18:00:00.000Z",
        }),
      ],
    });
  });

  it("resolves a notification only after a workspace-scoped lookup", async () => {
    const update = vi.fn().mockResolvedValue({
      ...row,
      readAt: new Date("2026-08-27T18:05:00.000Z"),
      resolvedAt: new Date("2026-08-27T18:05:00.000Z"),
      resolvedBy: "client-user-1",
    });
    const findFirst = vi.fn().mockResolvedValue(row);
    const handler = notificationHandler({
      brandwellClientNotification: { findFirst, update },
    });
    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/notifications/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { notificationId: "notice-1" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    expect(response.status).toBe(200);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "notice-1", workspaceId: "workspace-1" },
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "notice-1" },
        data: expect.objectContaining({ resolvedBy: "client-user-1" }),
      }),
    );
  });
});

describe("thread answer delivery", () => {
  it("accepts a durable answer when the immediate worker wake fails", async () => {
    const answerRunInput = vi.fn().mockResolvedValue(true);
    const enqueue = vi.fn().mockRejectedValue(new Error("job broker unavailable"));
    const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const prisma = {
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          id: "bot-1",
          thread: { id: "thread-1" },
          computer: null,
        }),
      },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      events: { answerRunInput },
      jobs: { enqueue },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      workspaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const handler = new RPCHandler(createRouter(deps));

    const { matched, response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/threads/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: {
            botId: "bot-1",
            runId: "run-1",
            messageId: "message-1",
            answer: "Paris",
          },
        }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(matched).toBe(true);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
    expect(answerRunInput).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
      }),
    );
    expect(enqueue).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalledWith("thread answer enqueue", expect.any(Error));
    logError.mockRestore();
  });
});

describe("MCP server deletion", () => {
  it("does not fail when a concurrent credential rotation already removed the old secret", async () => {
    const deleteServer = vi.fn().mockResolvedValue({ id: "server-1" });
    const deleteSecrets = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      mcpServer: {
        findFirst: vi.fn().mockResolvedValue({ id: "server-1", secretId: "old-secret" }),
        delete: deleteServer,
      },
      secret: { deleteMany: deleteSecrets },
      $transaction: vi.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      workspaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const handler = new RPCHandler(createRouter(deps));

    const { matched, response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/mcp/servers/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { id: "server-1" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(matched).toBe(true);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
    expect(deleteServer).toHaveBeenCalledWith({ where: { id: "server-1" } });
    expect(deleteSecrets).toHaveBeenCalledWith({
      where: {
        id: "old-secret",
        workspaceId: "workspace-1",
        userId: "user-1",
      },
    });
  });
});

describe("connections.complete", () => {
  it("forwards an optional code to the managed connector", async () => {
    const complete = vi.fn().mockResolvedValue({ connectionRef: "gmail" });
    const connectionReady = vi.fn().mockResolvedValue(true);
    const update = vi.fn().mockResolvedValue({
      id: "conn-1",
      connectorId: "composio",
      provider: "gmail",
      displayName: "Gmail",
      status: "connected",
      createdAt: new Date("2026-08-26T00:00:00.000Z"),
    });
    const prisma = {
      brandwellAiWorkspace: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      connection: {
        findFirst: vi.fn().mockResolvedValue({
          id: "conn-1",
          connectorId: "composio",
          provider: "gmail",
          displayName: "Gmail",
          providerRef: "gmail-state",
          status: "pending",
          createdAt: new Date("2026-08-26T00:00:00.000Z"),
        }),
        update,
      },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      connectors: {
        managed: vi.fn(() => ({ complete, connectionReady })),
      },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      workspaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const handler = new RPCHandler(createRouter(deps));

    const { matched, response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/connections/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: {
            connectionId: "conn-1",
            code: "123456",
          },
        }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(matched).toBe(true);
    expect(response.status).toBe(200);
    expect(complete).toHaveBeenCalledWith(
      { state: "gmail-state", code: "123456" },
      expect.objectContaining({ workspaceId: "workspace-1", userId: "user-1" }),
    );
    expect(connectionReady).toHaveBeenCalled();
  });
});
