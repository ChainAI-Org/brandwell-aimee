import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const shell = readFileSync(new URL("./Shell.tsx", import.meta.url), "utf8");
const refreshBody = shell.match(
  /const refreshBots = useCallback\(\s*async \(includeArchived = false\) => \{([\s\S]*?)\n {4}\},\n {4}\[/,
)?.[1];

function harness() {
  if (!refreshBody) throw new Error("Could not find the shell refresh callback");
  const navigate = vi.fn();
  const routeBotId = { current: "bot-1" as string | undefined };
  const routeGroupId = { current: undefined as string | undefined };
  const managedDashboardRef = { current: false };
  let resolveBots!: (bots: { id: string }[]) => void;
  const bots = new Promise<{ id: string }[]>((resolve) => {
    resolveBots = resolve;
  });
  const dependencies = {
    navigate,
    routeBotId,
    routeGroupId,
    managedDashboardRef,
    markOnce: vi.fn(),
    setBots: vi.fn(),
    setBotSections: vi.fn(),
    setGroups: vi.fn(),
    setInitialBotsLoaded: vi.fn(),
    setArchivedBots: vi.fn(),
    firstThreadRoute: () => "/app/bot-1",
    rpc: {
      bots: { list: () => bots, listArchived: async () => [] },
      botSections: { list: async () => [] },
      groups: { list: async () => [] },
    },
  };
  // Exercise the actual asynchronous refresh body with deferred RPC responses.
  const refresh = new Function(
    ...Object.keys(dependencies),
    `return async (includeArchived = false) => { ${refreshBody} };`,
  )(...Object.values(dependencies)) as (includeArchived?: boolean) => Promise<void>;
  return { refresh, resolveBots, navigate, routeBotId, routeGroupId, managedDashboardRef };
}

describe("shell refresh navigation", () => {
  it("keeps the dashboard open when a refresh started in chat finishes later", async () => {
    const test = harness();
    const pending = test.refresh();
    test.routeBotId.current = undefined;
    test.managedDashboardRef.current = true;
    test.resolveBots([{ id: "bot-1" }]);
    await pending;
    expect(test.navigate).not.toHaveBeenCalled();
  });

  it("still chooses a valid conversation when a non-dashboard route has no bot", async () => {
    const test = harness();
    test.routeBotId.current = undefined;
    const pending = test.refresh();
    test.resolveBots([{ id: "bot-1" }]);
    await pending;
    expect(test.navigate).toHaveBeenCalledWith("/app/bot-1", { replace: true });
  });

  it("does not redirect an existing conversation", async () => {
    const test = harness();
    const pending = test.refresh();
    test.resolveBots([{ id: "bot-1" }]);
    await pending;
    expect(test.navigate).not.toHaveBeenCalled();
  });

  it("leaves a group that is no longer available", async () => {
    const test = harness();
    test.routeGroupId.current = "removed-group";
    const pending = test.refresh();
    test.resolveBots([{ id: "bot-1" }]);
    await pending;
    expect(test.navigate).toHaveBeenCalledWith("/app/bot-1", { replace: true });
  });
});
