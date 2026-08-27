import type { AgentHomeStore, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  type BrandwellSupportComputerDeps,
  type BrandwellSupportComputerError,
  getBrandwellSupportScreen,
  releaseBrandwellSupportControl,
  takeBrandwellSupportControl,
} from "./brandwell-support.js";

const future = new Date(Date.now() + 15 * 60_000);

function resource(overrides: Record<string, unknown> = {}) {
  return {
    id: "bot-1",
    workspaceId: "workspace-1",
    pinned: true,
    createdAt: new Date("2026-08-27T18:00:00.000Z"),
    thread: { id: "thread-1" },
    computer: {
      id: "computer-1",
      workspaceId: "workspace-1",
      userId: "system-user",
      homeKey: "workspace-1",
      providerRef: "provider-1",
      kind: "docker",
      scope: "team",
      state: "running",
      controlHolder: "none",
      controlLeaseId: null,
      controlLeaseExpiresAt: null,
      controlBotId: null,
      controlRunId: null,
      controlActorType: null,
      controlActorName: null,
      controlStartedAt: null,
      updatedAt: new Date("2026-08-27T18:00:00.000Z"),
      ...overrides,
    },
  };
}

function deps(prisma: Record<string, unknown>, input?: { screenUrl?: string }) {
  const enqueue = vi.fn(async () => undefined);
  const connectScreen = vi.fn(async () => ({
    url: input?.screenUrl ?? "http://127.0.0.1:6080/vnc.html",
  }));
  const setScreenControl = vi.fn(async () => undefined);
  const finalizeComputerControlRelease = vi.fn(async () => ({ runId: null }));
  const value: BrandwellSupportComputerDeps = {
    prisma: prisma as unknown as PrismaClient,
    sandbox: { connectScreen, setScreenControl } as unknown as SandboxProvider,
    home: {} as AgentHomeStore,
    jobs: { enqueue, cancel: vi.fn(async () => undefined) } as unknown as JobPublisher,
    events: {
      append: vi.fn(async () => undefined),
      finalizeComputerControlRelease,
    } as unknown as ThreadEvents,
    dataDir: "./data",
    systemUserId: "system-user",
    screenProxySecret: "support-screen-secret",
    webOrigin: "https://aimee.example.com",
  };
  return { value, enqueue, connectScreen, setScreenControl, finalizeComputerControlRelease };
}

const actor = {
  reference: "user:42",
  name: "Test Operator",
  email: "operator@example.test",
};

describe("BrandWell operator computer support", () => {
  it("creates one auditable operator lease without displacing active AIMEE work", async () => {
    const computerUpdateMany = vi.fn(async () => ({ count: 1 }));
    const sessionCreate = vi.fn(async ({ data }) => ({
      id: "support-1",
      startedAt: new Date("2026-08-27T18:00:00.000Z"),
      ...data,
    }));
    const auditCreate = vi.fn(async () => ({ id: "audit-1" }));
    const prisma = {
      bot: { findFirst: vi.fn(async () => resource()) },
      computerExecutionLease: {
        findFirst: vi.fn(async () => null),
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
      brandwellSupportSession: { findFirst: vi.fn(async () => null) },
      $transaction: vi.fn(async (callback) =>
        callback({
          computer: { updateMany: computerUpdateMany },
          brandwellSupportSession: { create: sessionCreate },
          brandwellAuditLog: { create: auditCreate },
        }),
      ),
    };
    const harness = deps(prisma);

    const result = await takeBrandwellSupportControl(harness.value, {
      workspaceId: "workspace-1",
      botId: "bot-1",
      actor,
      reason: "Resolve the client login alert",
    });

    expect(result).toMatchObject({ sessionId: "support-1", replayed: false });
    expect(computerUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          controlActorType: "brandwell_operator",
          controlActorName: "Test Operator",
          controlUserId: "system-user",
        }),
      }),
    );
    expect(sessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          operatorReference: "user:42",
          operatorEmail: "operator@example.test",
        }),
      }),
    );
    expect(auditCreate).toHaveBeenCalled();
    expect(harness.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "computer.control-expire" }),
    );
  });

  it("does not steal a computer controlled by another person", async () => {
    const prisma = {
      bot: {
        findFirst: vi.fn(async () =>
          resource({
            controlHolder: "user",
            controlLeaseId: "lease-other",
            controlLeaseExpiresAt: future,
            controlBotId: "bot-1",
            controlActorType: "client",
            controlActorName: "Alex Client",
          }),
        ),
      },
      brandwellSupportSession: { findFirst: vi.fn(async () => null) },
    };
    const harness = deps(prisma);

    await expect(
      takeBrandwellSupportControl(harness.value, {
        workspaceId: "workspace-1",
        botId: "bot-1",
        actor,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<BrandwellSupportComputerError>>({
        message: "The client computer is already controlled by Alex Client.",
      }),
    );
  });

  it("issues a signed view-only screen capability until the operator owns control", async () => {
    const auditCreate = vi.fn(async () => ({ id: "audit-1" }));
    const prisma = {
      bot: { findFirst: vi.fn(async () => resource()) },
      computerExecutionLease: { findUnique: vi.fn(async () => null) },
      brandwellAuditLog: { create: auditCreate },
    };
    const harness = deps(prisma);

    const screen = await getBrandwellSupportScreen(harness.value, {
      workspaceId: "workspace-1",
      botId: "bot-1",
      actor,
    });

    expect(screen.interactive).toBe(false);
    expect(screen.url).toMatch(/^https:\/\/aimee\.example\.com\/novnc\//);
    expect(screen.url).not.toContain("127.0.0.1");
    expect(harness.connectScreen).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ interactive: false }),
      expect.anything(),
    );
    expect(auditCreate).toHaveBeenCalled();
  });

  it("releases only the current operator lease and closes its support session", async () => {
    const sessionUpdateMany = vi.fn(async () => ({ count: 1 }));
    const auditCreate = vi.fn(async () => ({ id: "audit-1" }));
    const prisma = {
      bot: {
        findFirst: vi.fn(async () =>
          resource({
            controlHolder: "user",
            controlLeaseId: "lease-1",
            controlLeaseExpiresAt: future,
            controlBotId: "bot-1",
            controlActorType: "brandwell_operator",
            controlActorName: "Test Operator",
          }),
        ),
      },
      brandwellSupportSession: {
        findFirst: vi.fn(async () => ({
          id: "support-1",
          startedAt: new Date("2026-08-27T18:00:00.000Z"),
          controlLeaseId: "lease-1",
          status: "active",
        })),
        updateMany: sessionUpdateMany,
      },
      brandwellAuditLog: { create: auditCreate },
      $transaction: vi.fn(async (operations) => Promise.all(operations)),
    };
    const harness = deps(prisma);

    await expect(
      releaseBrandwellSupportControl(harness.value, {
        workspaceId: "workspace-1",
        botId: "bot-1",
        actor,
        reason: "Support complete",
      }),
    ).resolves.toEqual({ ok: true, replayed: false });

    expect(harness.setScreenControl).toHaveBeenCalledWith(
      expect.anything(),
      false,
      expect.anything(),
      "lease-1",
    );
    expect(harness.finalizeComputerControlRelease).toHaveBeenCalledWith(
      expect.objectContaining({ leaseId: "lease-1", reason: "released" }),
    );
    expect(sessionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "released" }) }),
    );
    expect(auditCreate).toHaveBeenCalled();
  });
});
