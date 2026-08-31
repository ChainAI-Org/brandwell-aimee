import type { AgentHomeStore, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { stopManagedComputerForLifecycle } from "./managed-computer-lifecycle.js";

function context() {
  return {
    operationId: "brandwell-sidekick-lifecycle:operation-1:pause",
    traceId: "brandwell-sidekick-lifecycle:operation-1:pause",
    workspaceId: "workspace-1",
    userId: "user-1",
    botId: "bot-1",
    signal: new AbortController().signal,
  };
}

function harness(state: "running" | "booting" = "running") {
  const events: string[] = [];
  const computer = {
    id: "computer-1",
    workspaceId: "workspace-1",
    userId: "user-1",
    homeKey: "bot-home-1",
    kind: "daytona",
    providerRef: "sandbox-1",
    state,
    controlFence: 2,
    executionFence: 4,
  };
  const computerUpdateMany = vi.fn(async (input) => {
    events.push(`db.computer:${input.data.state ?? "checkpoint"}`);
    return { count: 1 };
  });
  const tx = {
    computer: {
      findFirst: vi.fn(async () => computer),
      updateMany: computerUpdateMany,
    },
    run: {
      findMany: vi.fn(async () => [{ id: "run-1", taskId: "task-1" }]),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    task: { updateMany: vi.fn(async () => ({ count: 1 })) },
    computerExecutionLease: { deleteMany: vi.fn(async () => ({ count: 1 })) },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (callback) => callback(tx)),
  } as unknown as PrismaClient;
  const home = {
    commit: vi.fn(async () => {
      events.push("workspace.checkpoint");
      return "revision-1";
    }),
  } as unknown as AgentHomeStore;
  const sandbox = {
    exportWorkspace: async function* () {
      yield { path: "notes.txt", content: new Uint8Array([111, 107]) };
    },
    releaseScreen: vi.fn(async () => {
      events.push("sandbox.release-screen");
    }),
    stop: vi.fn(async () => {
      events.push("sandbox.stop");
    }),
  } as unknown as SandboxProvider;
  const jobs = {
    cancel: vi.fn(async () => {
      events.push("job.cancel");
    }),
  } as unknown as JobPublisher;
  const markCheckpointed = vi.fn(async () => {
    events.push("operation.checkpointed");
  });
  return {
    computer,
    computerUpdateMany,
    events,
    home,
    jobs,
    markCheckpointed,
    prisma,
    sandbox,
    tx,
  };
}

describe("managed lifecycle computer stop", () => {
  it("cancels execution, fences control, checkpoints, and then performs the provider stop", async () => {
    const test = harness();

    await stopManagedComputerForLifecycle(
      { prisma: test.prisma, sandbox: test.sandbox, home: test.home, jobs: test.jobs },
      {
        computerId: "computer-1",
        botId: "bot-1",
        reason: "BrandWell Sidekick pause requested",
        checkpointRequired: true,
        markCheckpointed: test.markCheckpointed,
      },
      context(),
    );

    expect(test.tx.run.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["run-1"] }, status: { in: expect.any(Array) } },
      data: expect.objectContaining({
        status: "cancelled",
        leaseOwner: null,
        leaseExpiresAt: null,
      }),
    });
    expect(test.computerUpdateMany.mock.calls[0]?.[0]).toMatchObject({
      data: {
        state: "suspending",
        controlHolder: "none",
        controlFence: { increment: 1 },
        executionRunId: null,
        executionFence: { increment: 1 },
      },
    });
    expect(test.events.indexOf("operation.checkpointed")).toBeLessThan(
      test.events.indexOf("sandbox.stop"),
    );
    expect(test.sandbox.stop).toHaveBeenCalledOnce();
    expect(test.jobs.cancel).toHaveBeenCalledOnce();
  });

  it("skips a repeated checkpoint after the durable checkpoint phase", async () => {
    const test = harness();

    await stopManagedComputerForLifecycle(
      { prisma: test.prisma, sandbox: test.sandbox, home: test.home },
      {
        computerId: "computer-1",
        botId: "bot-1",
        reason: "BrandWell Sidekick pause retry",
        checkpointRequired: false,
        markCheckpointed: test.markCheckpointed,
      },
      context(),
    );

    expect(test.home.commit).not.toHaveBeenCalled();
    expect(test.markCheckpointed).not.toHaveBeenCalled();
    expect(test.sandbox.stop).toHaveBeenCalledOnce();
  });

  it("fences an in-flight boot so activation fails before the provider stop", async () => {
    const test = harness("booting");

    await stopManagedComputerForLifecycle(
      { prisma: test.prisma, sandbox: test.sandbox, home: test.home },
      {
        computerId: "computer-1",
        botId: "bot-1",
        reason: "BrandWell Sidekick cancellation requested",
        checkpointRequired: true,
        markCheckpointed: test.markCheckpointed,
      },
      context(),
    );

    expect(test.computerUpdateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { state: "booting" },
      data: { state: "suspending", executionFence: { increment: 1 } },
    });
    expect(test.home.commit).not.toHaveBeenCalled();
    expect(test.sandbox.stop).toHaveBeenCalledOnce();
  });
});
