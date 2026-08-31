import { ONCE_ROUTINE_CRON } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";

describe("createRunExecutor", () => {
  it("deactivates one-shot routines after wake without scheduling another wakeup", async () => {
    const scheduledAt = new Date(Date.now() - 1_000);
    const enqueue = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const append = vi.fn(async () => undefined);
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      routine: {
        findUnique: vi.fn(async () => ({
          id: "routine-1",
          workspaceId: "ws-1",
          botId: "bot-1",
          userId: "user-1",
          prompt: "say hi",
          crons: [ONCE_ROUTINE_CRON],
          timezone: "UTC",
          active: true,
          nextRunAt: scheduledAt,
        })),
      },
      bot: {
        findUnique: vi.fn(async () => ({
          id: "bot-1",
          thread: { id: "thread-1" },
        })),
      },
      agentSkill: {
        findMany: vi.fn(async () => []),
      },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          routine: { updateMany },
          task: { create: vi.fn(async () => ({ id: "task-1" })) },
          run: { create: vi.fn(async () => ({ id: "run-1" })) },
        }),
      ),
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      jobs: { enqueue, cancel, close: vi.fn(async () => undefined) },
      events: { append },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    await executor.wakeRoutine("routine-1", scheduledAt.toISOString());

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ active: false, nextRunAt: null }),
      }),
    );
    expect(cancel).toHaveBeenCalledWith("routine:routine-1");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "routine.fired", runId: "run-1" }),
    );
  });

  it("expands @skill mentions in the routine prompt at fire time", async () => {
    const scheduledAt = new Date(Date.now() - 1_000);
    const enqueue = vi.fn(async () => undefined);
    let createdPrompt = "";
    const taskCreate = vi.fn(async (args: { data: { prompt: string } }) => {
      createdPrompt = args.data.prompt;
      return { id: "task-1" };
    });
    const skillContent = `---
name: Daily standup
description: Prepare standup notes
---

1. Summarize wins.
`;
    const prisma = {
      routine: {
        findUnique: vi.fn(async () => ({
          id: "routine-1",
          workspaceId: "ws-1",
          botId: "bot-1",
          userId: "user-1",
          prompt: "Run @Daily standup, then email me",
          crons: [ONCE_ROUTINE_CRON],
          timezone: "UTC",
          active: true,
          nextRunAt: scheduledAt,
        })),
      },
      bot: {
        findUnique: vi.fn(async () => ({
          id: "bot-1",
          thread: { id: "thread-1" },
        })),
      },
      agentSkill: {
        findMany: vi.fn(async () => [
          {
            id: "skill-1",
            name: "Daily standup",
            description: "Prepare standup notes",
            content: skillContent,
            source: "user",
          },
        ]),
      },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          routine: { updateMany: vi.fn(async () => ({ count: 1 })) },
          task: { create: taskCreate },
          run: { create: vi.fn(async () => ({ id: "run-1" })) },
        }),
      ),
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      jobs: { enqueue, cancel: vi.fn(async () => undefined), close: vi.fn(async () => undefined) },
      events: { append: vi.fn(async () => undefined) },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    await executor.wakeRoutine("routine-1", scheduledAt.toISOString());

    expect(createdPrompt).toContain("Use skill: Daily standup");
    expect(createdPrompt).toContain("Summarize wins");
    expect(createdPrompt).not.toMatch(/@Daily standup/);
  });

  it("still continues the run when routine.fired append fails", async () => {
    const scheduledAt = new Date(Date.now() - 1_000);
    const enqueue = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const append = vi.fn(async () => {
      throw new Error("append failed");
    });
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      routine: {
        findUnique: vi.fn(async () => ({
          id: "routine-1",
          workspaceId: "ws-1",
          botId: "bot-1",
          userId: "user-1",
          prompt: "say hi",
          crons: [ONCE_ROUTINE_CRON],
          timezone: "UTC",
          active: true,
          nextRunAt: scheduledAt,
          lastRunAt: null,
        })),
      },
      bot: {
        findUnique: vi.fn(async () => ({
          id: "bot-1",
          thread: { id: "thread-1" },
        })),
      },
      agentSkill: {
        findMany: vi.fn(async () => []),
      },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          routine: { updateMany },
          task: { create: vi.fn(async () => ({ id: "task-1" })) },
          run: { create: vi.fn(async () => ({ id: "run-1", taskId: "task-1" })) },
        }),
      ),
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      jobs: { enqueue, cancel, close: vi.fn(async () => undefined) },
      events: { append },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    await expect(
      executor.wakeRoutine("routine-1", scheduledAt.toISOString()),
    ).resolves.toBeUndefined();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
    expect(cancel).toHaveBeenCalledWith("routine:routine-1");
  });

  it("restores the routine claim when run.continue enqueue fails", async () => {
    const scheduledAt = new Date(Date.now() - 1_000);
    const previousLastRunAt = new Date(Date.now() - 60_000);
    const enqueue = vi.fn(async () => {
      throw new Error("enqueue failed");
    });
    const claimUpdateMany = vi.fn(async () => ({ count: 1 }));
    const restoreUpdateMany = vi.fn(async () => ({ count: 1 }));
    const deleteRunMany = vi.fn(async () => ({ count: 1 }));
    const deleteTaskMany = vi.fn(async () => ({ count: 1 }));
    let transactionCalls = 0;
    const prisma = {
      routine: {
        findUnique: vi.fn(async () => ({
          id: "routine-1",
          workspaceId: "ws-1",
          botId: "bot-1",
          userId: "user-1",
          prompt: "say hi",
          crons: [ONCE_ROUTINE_CRON],
          timezone: "UTC",
          active: true,
          nextRunAt: scheduledAt,
          lastRunAt: previousLastRunAt,
        })),
      },
      bot: {
        findUnique: vi.fn(async () => ({
          id: "bot-1",
          thread: { id: "thread-1" },
        })),
      },
      agentSkill: {
        findMany: vi.fn(async () => []),
      },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
        transactionCalls += 1;
        if (transactionCalls === 1) {
          return callback({
            routine: { updateMany: claimUpdateMany },
            task: { create: vi.fn(async () => ({ id: "task-1" })) },
            run: { create: vi.fn(async () => ({ id: "run-1", taskId: "task-1" })) },
          });
        }
        return callback({
          routine: { updateMany: restoreUpdateMany },
          task: { deleteMany: deleteTaskMany },
          run: { deleteMany: deleteRunMany },
        });
      }),
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      jobs: { enqueue, cancel: vi.fn(async () => undefined), close: vi.fn(async () => undefined) },
      events: { append: vi.fn(async () => undefined) },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    await expect(executor.wakeRoutine("routine-1", scheduledAt.toISOString())).rejects.toThrow(
      "enqueue failed",
    );
    expect(deleteRunMany).toHaveBeenCalledWith({ where: { id: "run-1", status: "queued" } });
    expect(deleteTaskMany).toHaveBeenCalledWith({ where: { id: "task-1", status: "queued" } });
    expect(restoreUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "routine-1", active: false, nextRunAt: null }),
        data: expect.objectContaining({
          nextRunAt: scheduledAt,
          active: true,
          lastRunAt: previousLastRunAt,
        }),
      }),
    );
  });

  it("consumes a persisted takeover checkpoint when claiming the run", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const prisma = {
      run: {
        findUnique: vi.fn(async () => ({
          id: "run-1",
          botId: "bot-1",
          status: "queued",
          checkpoint: "takeover-skipped",
          leaseFence: 0,
        })),
        updateMany,
      },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({ prisma } as Parameters<typeof createRunExecutor>[0]);

    await executor.continueRun("run-1", "worker-1");

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ checkpoint: null }),
      }),
    );
  });

  it("restores a takeover checkpoint when a switching computer requeues the run", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const enqueue = vi.fn(async () => undefined);
    const prisma = {
      run: {
        findUnique: vi.fn(async () => ({
          id: "run-1",
          botId: "bot-1",
          status: "queued",
          checkpoint: "takeover-skipped",
          leaseFence: 0,
        })),
        findUniqueOrThrow: vi.fn(async () => ({ status: "leased", startedAt: null })),
        updateMany,
      },
      bot: {
        findUniqueOrThrow: vi.fn(async () => ({
          computerId: "computer-1",
          computerSwitching: true,
        })),
      },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({ prisma, jobs: { enqueue } } as unknown as Parameters<
      typeof createRunExecutor
    >[0]);

    await executor.continueRun("run-1", "worker-1");

    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "queued",
          checkpoint: "takeover-skipped",
        }),
      }),
    );
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("resolves a per-bot model override with that provider’s credential", async () => {
    const findFirst = vi.fn(async (args: { where: { provider?: string; isDefault?: boolean } }) => {
      if (args.where.provider === "xai") {
        return {
          id: "cred-xai",
          provider: "xai",
          secretId: "secret-xai",
          defaultModel: "grok-4.6",
          isDefault: false,
        };
      }
      if (args.where.isDefault) {
        return {
          id: "cred-default",
          provider: "openrouter",
          secretId: "secret-or",
          defaultModel: "deepseek/deepseek-v4-flash-0731",
          isDefault: true,
        };
      }
      return null;
    });
    const prisma = {
      bot: {
        findFirst: vi.fn(async () => ({
          modelProvider: "xai",
          modelId: "grok-4.6",
          thinkingLevel: "high",
        })),
      },
      userModelCredential: { findFirst },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      secret: { findFirst: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      secretStore: { load: vi.fn(), put: vi.fn() },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    const model = await executor.resolveModel({
      userId: "user-1",
      workspaceId: "ws-1",
      botId: "bot-1",
    });

    expect(model).toMatchObject({
      provider: "xai",
      id: "grok-4.6",
      thinkingLevel: "high",
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ provider: "xai" }),
      }),
    );
  });

  it("falls back to the workspace default when the override provider has no credential", async () => {
    const findFirst = vi.fn(async (args: { where: { provider?: string; isDefault?: boolean } }) => {
      if (args.where.provider === "xai") return null;
      if (args.where.isDefault) {
        return {
          id: "cred-default",
          provider: "openrouter",
          secretId: "secret-or",
          defaultModel: "deepseek/deepseek-v4-flash-0731",
          isDefault: true,
        };
      }
      return null;
    });
    const prisma = {
      bot: {
        findFirst: vi.fn(async () => ({
          modelProvider: "xai",
          modelId: "grok-4.6",
          thinkingLevel: "high",
        })),
      },
      userModelCredential: { findFirst },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      secret: { findFirst: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      secretStore: { load: vi.fn(), put: vi.fn() },
      deploymentModelKey: "deployment-openrouter-key",
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    const model = await executor.resolveModel({
      userId: "user-1",
      workspaceId: "ws-1",
      botId: "bot-1",
    });

    expect(model).toMatchObject({
      provider: "openrouter",
      id: "deepseek/deepseek-v4-flash-0731",
      // Override thinking must drop with the override provider/credential unit.
      thinkingLevel: null,
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ provider: "xai" }),
      }),
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isDefault: true }),
      }),
    );
  });

  it("withholds the deployment key when settings name a different provider", async () => {
    const prisma = {
      bot: { findFirst: vi.fn(async () => null) },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      deploymentSettings: {
        findUnique: vi.fn(async () => ({
          defaultModelProvider: "anthropic",
          defaultModelId: "claude-sonnet-5",
        })),
      },
      secret: { findFirst: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      secretStore: { load: vi.fn(), put: vi.fn() },
      // PI_DEFAULT_PROVIDER is unset here, so this key belongs to OpenRouter.
      deploymentModelKey: "deployment-openrouter-key",
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    const model = await executor.resolveModel({ userId: "user-1", workspaceId: "ws-1" });

    expect(model.provider).toBe("anthropic");
    expect(model.apiKey).toBeUndefined();
  });

  it("keeps per-bot thinking when using the workspace default model", async () => {
    const findFirst = vi.fn(async (args: { where: { provider?: string; isDefault?: boolean } }) => {
      if (args.where.isDefault) {
        return {
          id: "cred-default",
          provider: "openrouter",
          secretId: "secret-or",
          defaultModel: "deepseek/deepseek-v4-flash-0731",
          isDefault: true,
        };
      }
      return null;
    });
    const prisma = {
      bot: {
        findFirst: vi.fn(async () => ({
          modelProvider: null,
          modelId: null,
          thinkingLevel: "high",
        })),
      },
      userModelCredential: { findFirst },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      secret: { findFirst: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      secretStore: { load: vi.fn(), put: vi.fn() },
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    const model = await executor.resolveModel({
      userId: "user-1",
      workspaceId: "ws-1",
      botId: "bot-1",
    });

    expect(model).toMatchObject({
      provider: "openrouter",
      id: "deepseek/deepseek-v4-flash-0731",
      thinkingLevel: "high",
    });
  });

  it("uses a workspace service credential for a managed BrandWell bot", async () => {
    const findFirst = vi.fn(async () => ({ id: "secret-acme", ciphertext: "encrypted" }));
    const managedModelResolver = vi.fn(async () => ({
      provider: "openrouter",
      id: "openai/gpt-5.4-mini",
      secretId: "secret-acme",
      serviceIdentityId: "svc-acme",
      thinkingLevel: "medium",
      maxTokens: 12_345,
      fallbackModels: ["anthropic/claude-sonnet-4.5"],
      fallbackModelMetadata: {
        "anthropic/claude-sonnet-4.5": {
          id: "anthropic/claude-sonnet-4.5",
          name: "Claude Sonnet 4.5",
          inputModalities: ["text", "image"],
          outputModalities: ["text"],
          supportedParameters: ["tools", "reasoning"],
          reasoning: true,
          contextLength: 200_000,
          maxCompletionTokens: 64_000,
          pricing: {},
        },
      },
      modelMetadata: {
        id: "openai/gpt-5.4-mini",
        name: "GPT 5.4 Mini",
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        supportedParameters: ["tools"],
        reasoning: false,
        contextLength: 400_000,
        maxCompletionTokens: 128_000,
        pricing: {},
      },
      warningExceeded: false,
    }));
    const prisma = { secret: { findFirst } } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      managedModelResolver,
      secretStore: { load: vi.fn(() => "sk-managed-acme"), put: vi.fn() },
      deploymentModelKey: "deployment-key-must-not-win",
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    const model = await executor.resolveModel({
      userId: "client-admin",
      workspaceId: "workspace-acme",
      botId: "bot-acme",
    });

    expect(model).toMatchObject({
      provider: "openrouter",
      id: "openai/gpt-5.4-mini",
      apiKey: "sk-managed-acme",
      thinkingLevel: "medium",
      maxTokens: 12_345,
      fallbackModels: ["anthropic/claude-sonnet-4.5"],
      fallbackMetadata: {
        "anthropic/claude-sonnet-4.5": expect.objectContaining({
          id: "anthropic/claude-sonnet-4.5",
          reasoning: true,
        }),
      },
      metadata: expect.objectContaining({
        id: "openai/gpt-5.4-mini",
        inputModalities: ["text", "image"],
      }),
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: "secret-acme",
        workspaceId: "workspace-acme",
        ownerType: "service",
        serviceIdentityId: "svc-acme",
      },
    });
  });

  it("sends a persisted reasoning workload's centrally resolved model to the runtime", async () => {
    const run = {
      id: "run-reasoning",
      workspaceId: "workspace-acme",
      userId: "client-admin",
      botId: "bot-acme",
      threadId: "thread-acme",
      taskId: "task-acme",
      status: "queued",
      trigger: "skill",
      workloadType: "reasoning",
      checkpoint: null,
      leaseFence: 0,
      serviceIdentityId: null,
      sourceMessageId: null,
      routineId: null,
    };
    const computer = {
      id: "computer-acme",
      botId: "bot-acme",
      homeKey: "home-acme",
      kind: "fake",
      scope: "dedicated",
      state: "running",
      providerRef: "provider-computer-acme",
      controlLeaseId: null,
      controlLeaseExpiresAt: null,
    };
    const bot = {
      id: "bot-acme",
      name: "AIMEE",
      title: "",
      description: "",
      instructions: "",
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
      memoryScope: "isolated",
      notifyOnFinish: false,
      computer,
    };
    const thread = {
      id: "thread-acme",
      groupId: null,
      historyCompactionSummary: null,
      historyCompactedUpToSeq: null,
      historyCompactionGeneration: 0,
    };
    const runtimeRun = vi.fn(async function* (_request: {
      model: { id: string };
      workloadType?: string;
    }) {
      yield { type: "done" as const, text: "completed" };
    });
    const managedModelResolver = vi.fn(async () => ({
      provider: "openrouter",
      id: "provider/reasoning-model",
      secretId: "secret-acme",
      serviceIdentityId: "svc-acme",
      fallbackModels: [],
      modelMetadata: {
        id: "provider/reasoning-model",
        name: "Reasoning model",
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportedParameters: ["tools", "reasoning"],
        reasoning: true,
        pricing: {},
      },
      warningExceeded: false,
    }));
    const prisma = {
      run: {
        findUnique: vi.fn(async () => run),
        findUniqueOrThrow: vi.fn(async () => ({ ...run, status: "leased", startedAt: null })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      bot: {
        findUniqueOrThrow: vi.fn(async (args: { select?: unknown }) =>
          args.select ? { computerId: computer.id, computerSwitching: false } : bot,
        ),
        findMany: vi.fn(async () => []),
      },
      computer: {
        findUniqueOrThrow: vi.fn(async () => computer),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      attempt: {
        create: vi.fn(async () => ({ id: "attempt-1" })),
        update: vi.fn(async () => ({})),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      thread: {
        findUniqueOrThrow: vi.fn(async (args: { select?: unknown }) =>
          args.select ? { nextMessageSeq: 1, historyCompactedUpToSeq: null } : thread,
        ),
      },
      message: { findMany: vi.fn(async () => []) },
      task: { findUniqueOrThrow: vi.fn(async () => ({ id: "task-acme", prompt: "test" })) },
      connection: { findMany: vi.fn(async () => []) },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      taughtSkill: { findMany: vi.fn(async () => []) },
      agentSkill: { findMany: vi.fn(async () => []) },
      scratchpadItem: { findMany: vi.fn(async () => []) },
      externalEffect: { findMany: vi.fn(async () => []) },
      actionApprovalRule: { findMany: vi.fn(async () => []) },
      secret: {
        findFirst: vi.fn(async () => ({ id: "secret-acme", ciphertext: "encrypted" })),
      },
      usageRecord: { create: vi.fn(async () => ({})) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      managedModelResolver,
      runtime: {
        describe: () => ({
          id: "test",
          contractVersion: "1",
          adapterVersion: "1",
          capabilities: { streaming: true, compaction: true, tools: true, scripted: false },
        }),
        run: runtimeRun,
        abort: vi.fn(async () => undefined),
      },
      sandbox: {
        describe: () => ({
          id: "fake",
          contractVersion: "1",
          adapterVersion: "1",
          capabilities: {
            graphical: false,
            pty: false,
            snapshots: false,
            takeover: false,
            persistentHome: true,
          },
        }),
        provision: vi.fn(async () => ({
          id: computer.id,
          botId: bot.id,
          kind: "fake",
          providerRef: computer.providerRef,
        })),
        prepare: vi.fn(async () => undefined),
        exportWorkspace: async function* () {},
        releaseScreen: vi.fn(async () => undefined),
      },
      home: {
        commit: vi.fn(async () => "revision-1"),
      },
      memory: {
        read: vi.fn(async () => ({ documents: [] })),
      },
      memoryProviders: { resolve: vi.fn(async () => null) },
      events: {
        append: vi.fn(async () => undefined),
        finalizeRun: vi.fn(async () => true),
      },
      jobs: {
        enqueue: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
      },
      secretStore: { load: vi.fn(() => "sk-managed-acme"), put: vi.fn() },
      secrets: [],
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    await executor.continueRun(run.id, "worker-1");

    expect(managedModelResolver).toHaveBeenCalledWith(
      expect.objectContaining({ workloadType: "reasoning" }),
    );
    expect(runtimeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workloadType: "reasoning",
        model: expect.objectContaining({ id: "provider/reasoning-model" }),
      }),
      expect.anything(),
    );
  });

  it("does not fall back to a deployment key when a managed secret is missing", async () => {
    const prisma = {
      secret: { findFirst: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      managedModelResolver: vi.fn(async () => ({
        provider: "openrouter",
        id: "openai/gpt-5.4-mini",
        secretId: "secret-other-workspace",
        serviceIdentityId: "svc-acme",
        fallbackModels: [],
        warningExceeded: false,
      })),
      secretStore: { load: vi.fn(), put: vi.fn() },
      deploymentModelKey: "deployment-key-must-not-win",
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    await expect(
      executor.resolveModel({
        userId: "client-admin",
        workspaceId: "workspace-acme",
        botId: "bot-acme",
      }),
    ).rejects.toThrow("Managed model credential is unavailable");
  });
});
