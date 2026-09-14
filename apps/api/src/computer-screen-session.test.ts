import type { ComputerRef, SandboxProvider, ScreenRequest } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { connectLeasedComputerScreen } from "./computer-screen-session.js";

const computer: ComputerRef = {
  id: "provider-1",
  providerRef: "provider-1",
  botId: "home",
  kind: "daytona",
};
const context = {
  workspaceId: "workspace-1",
  userId: "user-1",
  operationId: "screen",
  traceId: "trace",
  signal: new AbortController().signal,
};
const request: ScreenRequest = { view: "stream", interactive: true, controlToken: "lease-old" };

function fixture() {
  const ready = Promise.withResolvers<void>();
  const close = vi.fn(async () => undefined);
  const connectScreen = vi.fn(async () => {
    await ready.promise;
    return {
      url: "https://provider.example/aimee.html?password=private",
      mimeType: "text/html",
      close,
    };
  });
  const setScreenControl = vi.fn(async () => undefined);
  let lease = {
    providerRef: "provider-1",
    token: "lease-old",
    botId: "bot-1",
    expiresAt: new Date(Date.now() + 60_000),
  };
  const findFirst = vi.fn(async ({ where }) =>
    lease.providerRef === where.providerRef &&
    lease.token === where.controlLeaseId &&
    lease.botId === where.controlBotId &&
    lease.expiresAt > where.controlLeaseExpiresAt.gt
      ? { id: "computer-1" }
      : null,
  );
  return {
    ready,
    close,
    connectScreen,
    setScreenControl,
    findFirst,
    change: (change: Partial<typeof lease>) => {
      lease = { ...lease, ...change };
    },
    deps: {
      prisma: { computer: { findFirst } } as unknown as PrismaClient,
      sandbox: { connectScreen, setScreenControl } as unknown as SandboxProvider,
    },
  };
}

describe("control screen authorization after provider startup", () => {
  it("returns a screen only after rechecking the exact active lease and computer binding", async () => {
    const harness = fixture();
    const pending = connectLeasedComputerScreen(
      harness.deps,
      computer,
      request,
      context,
      "bot-1",
      "computer-1",
    );
    expect(harness.findFirst).not.toHaveBeenCalled();
    harness.ready.resolve();
    expect((await pending).url).toContain("https://provider.example");
    expect(harness.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "computer-1",
          workspaceId: "workspace-1",
          providerRef: "provider-1",
          controlLeaseId: "lease-old",
          controlHolder: "user",
          state: "running",
          bots: { some: { id: "bot-1", workspaceId: "workspace-1" } },
        }),
      }),
    );
    expect(harness.setScreenControl).not.toHaveBeenCalled();
  });

  it.each([
    ["released", { token: "" }],
    ["replaced by a newer lease", { token: "lease-new" }],
    ["replaced by another computer", { providerRef: "provider-2" }],
    ["expired during startup", { expiresAt: new Date(0) }],
    ["assigned to another bot", { botId: "bot-2" }],
  ])("does not return a capability when control was %s", async (_label, change) => {
    const harness = fixture();
    const pending = connectLeasedComputerScreen(
      harness.deps,
      computer,
      request,
      context,
      "bot-1",
      "computer-1",
    );
    harness.change(change);
    harness.ready.resolve();
    expect((await pending).url).toBeNull();
    expect(harness.close).toHaveBeenCalledOnce();
    expect(harness.setScreenControl).toHaveBeenCalledExactlyOnceWith(
      computer,
      false,
      context,
      "lease-old",
    );
  });

  it("rechecks support authorization and fails closed if the database is unavailable", async () => {
    const harness = fixture();
    const pending = connectLeasedComputerScreen(
      harness.deps,
      computer,
      request,
      context,
      "bot-1",
      "computer-1",
      async () => false,
    );
    harness.ready.resolve();
    expect((await pending).url).toBeNull();
    expect(harness.setScreenControl).toHaveBeenCalledWith(computer, false, context, "lease-old");
    const unavailable = fixture();
    unavailable.findFirst.mockRejectedValueOnce(new Error("database unavailable"));
    const failed = connectLeasedComputerScreen(
      unavailable.deps,
      computer,
      request,
      context,
      "bot-1",
      "computer-1",
    );
    unavailable.ready.resolve();
    await expect(failed).rejects.toThrow("database unavailable");
    expect(unavailable.setScreenControl).toHaveBeenCalledWith(
      computer,
      false,
      context,
      "lease-old",
    );
  });
});
