import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { BrandwellNativeConnector } from "./brandwell-native-connector.js";
import { createRunExecutor } from "./executor.js";

describe("managed Link Builder worker execution", () => {
  it("coordinates and verifies its assignment through signed native tools without a new chat", async () => {
    const taskId = "b15e3b32-2be5-4d0f-9da7-cf1609b9167b";
    const opportunityId = "115e3b32-2be5-4d0f-9da7-cf1609b9167b";
    const claimToken = "225e3b32-2be5-4d0f-9da7-cf1609b9167b";
    const run = {
      id: "run-placement",
      workspaceId: "workspace-test",
      userId: "user-test",
      botId: "bot-test",
      threadId: "thread-test",
      taskId: "native-task-test",
      status: "queued",
      trigger: "brandwell_link_builder_review",
      workloadType: "general",
      coordinationScope: { kind: "link_builder", taskId, opportunityId },
      checkpoint: null,
      leaseFence: 0,
      serviceIdentityId: "service-test",
      sourceMessageId: null,
      routineId: null,
    };
    const computer = {
      id: "computer-test",
      botId: run.botId,
      homeKey: "home-test",
      kind: "fake",
      scope: "dedicated",
      state: "running",
      providerRef: "computer-test",
      controlLeaseId: null,
      controlLeaseExpiresAt: null,
    };
    const bot = {
      id: run.botId,
      name: "AIMEE",
      title: "",
      description: "",
      instructions: "Coordinate placements.",
      additionalInstructions: "",
      managedByBrandWell: true,
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
      memoryScope: "isolated",
      notifyOnFinish: false,
      computer,
    };
    const effects: Array<Record<string, unknown>> = [];
    const prisma = {
      run: {
        findUnique: vi.fn(async () => run),
        findUniqueOrThrow: vi.fn(async () => ({ ...run, status: "leased", startedAt: null })),
        updateMany: vi.fn(async ({ data }) => {
          Object.assign(run, data);
          return { count: 1 };
        }),
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
        create: vi.fn(async () => ({ id: "attempt-test" })),
        update: vi.fn(async () => ({})),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      thread: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: run.threadId,
          groupId: null,
          nextMessageSeq: 1,
          historyCompactedUpToSeq: null,
          historyCompactionSummary: null,
          historyCompactionGeneration: 0,
        })),
      },
      message: { findMany: vi.fn(async () => []) },
      task: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: run.taskId,
          prompt: "Review the assigned placement.",
        })),
      },
      connection: { findMany: vi.fn(async () => []) },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      taughtSkill: { findMany: vi.fn(async () => []) },
      agentSkill: { findMany: vi.fn(async () => []) },
      scratchpadItem: { findMany: vi.fn(async () => []) },
      externalEffect: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(
          async ({ where }) =>
            effects.find(
              (effect) => effect.idempotencyKey === where.idempotencyKey || effect.id === where.id,
            ) ?? null,
        ),
        create: vi.fn(async ({ data }) => {
          const effect = { ...data, id: `effect-${effects.length + 1}` };
          effects.push(effect);
          return effect;
        }),
        updateMany: vi.fn(async ({ where, data }) => {
          const effect = effects.find(
            (item) => item.id === where.id && item.status === where.status,
          );
          if (!effect) return { count: 0 };
          Object.assign(effect, data);
          return { count: 1 };
        }),
      },
      actionApprovalRule: { findMany: vi.fn(async () => []) },
      secret: {
        findFirst: vi.fn(async () => ({ id: "model-test", ciphertext: "encrypted-test" })),
      },
      usageRecord: { create: vi.fn(async () => ({})) },
      brandwellAiWorkspace: {
        findUnique: vi.fn(async () => ({
          brandwellCustomerId: "customer-test",
          subscriptionStatus: "active",
          serviceIdentityId: run.serviceIdentityId,
        })),
      },
      brandwellServiceIdentity: {
        findUnique: vi.fn(async () => ({ workspaceId: run.workspaceId, status: "active" })),
      },
    } as unknown as PrismaClient;
    const sent: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
    const connector = new BrandwellNativeConnector(prisma, {
      apiBaseUrl: "https://portal.example.test",
      serviceToken: "test-native-service-0123456789abcdef",
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        sent.push(request);
        expect(init?.headers).toMatchObject({
          "x-brandwell-workspace-id": run.workspaceId,
          "x-brandwell-service-identity-id": run.serviceIdentityId,
          "x-brandwell-signature-version": "v1",
        });
        if (request.tool === "link_builder_details")
          return Response.json({ opportunity: { id: opportunityId, version: 1 } });
        if (request.tool === "link_builder_task") {
          if (request.arguments.action === "claim")
            return Response.json({ id: taskId, status: "claimed", claim_token: claimToken });
          expect(request.arguments.claim_token).toBe(claimToken);
          return Response.json({ id: taskId, status: "completed" });
        }
        if (request.tool === "link_builder_verify")
          return Response.json({
            opportunity: { id: opportunityId, health: "healthy", stage: "live_verified" },
          });
        return Response.json({ id: opportunityId, version: 2 });
      },
    });
    const results: unknown[] = [];
    const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
      if (!request.executeTool) throw new Error("Worker tool execution is unavailable");
      const names = request.tools.map((tool) => tool.name);
      expect(names).toContain("brandwell_link_builder_task");
      expect(names).toContain("brandwell_link_builder_verify");
      expect(names).not.toContain("shell");
      expect(names).not.toContain("brandwell_link_builder_add");
      results.push(
        await request.executeTool(
          "brandwell_link_builder_update",
          { id: taskId, version: 1 },
          "wrong-placement",
        ),
      );
      results.push(
        await request.executeTool(
          "brandwell_link_builder_task",
          { id: opportunityId, action: "claim" },
          "wrong-task",
        ),
      );
      results.push(await request.executeTool("shell", { command: "send mail" }, "blocked-shell"));
      results.push(
        await request.executeTool(
          "brandwell_link_builder_details",
          { id: opportunityId },
          "read-placement",
        ),
      );
      const claim = (await request.executeTool(
        "brandwell_link_builder_task",
        { id: taskId, action: "claim" },
        "claim-task",
      )) as { claim_token: string };
      results.push(claim);
      results.push(
        await request.executeTool(
          "brandwell_link_builder_update",
          { id: opportunityId, version: 1, notes: "Publication commitment reviewed." },
          "update-placement",
        ),
      );
      results.push(
        await request.executeTool(
          "brandwell_link_builder_verify",
          { id: opportunityId },
          "verify-placement",
        ),
      );
      results.push(
        await request.executeTool(
          "brandwell_link_builder_task",
          { id: taskId, action: "complete", claim_token: claim.claim_token },
          "complete-task",
        ),
      );
      yield {
        type: "done" as const,
        text: "Verified the assigned placement and recorded the result.",
      };
    });
    const finalizeRun = vi.fn(async () => true);
    const executor = createRunExecutor({
      prisma,
      connector,
      managedModelResolver: vi.fn(async () => ({
        provider: "test",
        id: "test-model",
        secretId: "model-test",
        serviceIdentityId: run.serviceIdentityId,
        fallbackModels: [],
        warningExceeded: false,
      })),
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
      home: { commit: vi.fn(async () => "revision-test") },
      memory: { read: vi.fn(async () => ({ documents: [] })) },
      memoryProviders: { resolve: vi.fn(async () => null) },
      events: { append: vi.fn(async () => undefined), finalizeRun },
      jobs: { enqueue: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) },
      secretStore: { load: vi.fn(() => "test-model-key"), put: vi.fn() },
      secrets: [],
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    await executor.continueRun(run.id, "test-worker");

    expect(runtimeRun).toHaveBeenCalledOnce();
    expect(results.slice(0, 3)).toEqual([
      { error: "This run can only access its assigned placement." },
      { error: "This run can only coordinate its assigned placement task." },
      { error: expect.stringContaining("only prepares a draft") },
    ]);
    expect(sent.map((request) => request.tool)).toEqual([
      "link_builder_details",
      "link_builder_task",
      "link_builder_update",
      "link_builder_verify",
      "link_builder_task",
    ]);
    expect(results.at(-1)).toMatchObject({ id: taskId, status: "completed" });
    expect(effects).toHaveLength(4);
    expect(effects.every((effect) => effect.status === "completed")).toBe(true);
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
  });
});
