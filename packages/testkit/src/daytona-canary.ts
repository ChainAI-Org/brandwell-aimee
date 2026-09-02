import assert from "node:assert/strict";
import type { AdapterContext, ComputerRef, ScreenSession } from "@rakazo/adapter-kit";
import { DaytonaSandboxProvider } from "@rakazo/adapters";

const CANARY_TIMEOUT_MS = 8 * 60_000;

export async function verifyLiveDaytonaProvider(
  source: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const apiKey = required(source, "DAYTONA_API_KEY");
  const snapshot = required(source, "DAYTONA_SNAPSHOT");
  const stamp = Date.now().toString(36);
  const homeBotId = `aimee-ci-${stamp}`;
  const controller = new AbortController();
  const primary = canaryContext(homeBotId, "primary", controller);
  const secondary = canaryContext(`aimee-ci-secondary-${stamp}`, "secondary", controller);
  const sandbox = new DaytonaSandboxProvider({
    apiKey,
    apiUrl: optional(source.DAYTONA_API_URL),
    target: optional(source.DAYTONA_TARGET),
    snapshot,
    autoStopInterval: 0,
    autoArchiveInterval: -1,
    autoDeleteInterval: -1,
    vncResolution: optional(source.DAYTONA_VNC_RESOLUTION) ?? "1440x900",
    locale: optional(source.DAYTONA_LOCALE) ?? "en_US.UTF-8",
    timezone: optional(source.DAYTONA_TIMEZONE) ?? "UTC",
  });
  const timeout = setTimeout(
    () => controller.abort(new Error("Daytona canary timed out")),
    CANARY_TIMEOUT_MS,
  );
  timeout.unref();

  let computer: ComputerRef | undefined;
  const screens: Array<{ screen: ScreenSession; context: AdapterContext }> = [];
  try {
    computer = await sandbox.provision(
      { botId: homeBotId, homePath: "/home/daytona/aimee-home" },
      primary.context,
    );
    assert.equal(computer.kind, "daytona");
    assert.equal(computer.fresh, true);
    console.log("Daytona canary: provisioned a fresh AIMEE computer");

    await sandbox.prepare(computer, primary.context);
    let stdout = "";
    let exitCode: number | undefined;
    for await (const event of sandbox.execute(
      computer,
      { argv: ["printf", "daytona-ci-ok"] },
      primary.context,
    )) {
      if (event.type === "stdout") stdout += event.data;
      if (event.type === "exit") exitCode = event.code;
    }
    assert.equal(exitCode, 0);
    assert.equal(stdout, "daytona-ci-ok");

    await sandbox.writeFile(
      computer,
      { path: "ci/daytona.txt", content: new TextEncoder().encode("preserved") },
      primary.context,
    );

    const primaryObservation = await sandbox.observe(computer, primary.context);
    const secondaryObservation = await sandbox.observe(computer, secondary.context);
    assert.ok(primaryObservation.image.byteLength > 0, "primary desktop screenshot was empty");
    assert.ok(secondaryObservation.image.byteLength > 0, "secondary desktop screenshot was empty");

    const primaryScreen = await sandbox.connectScreen(
      computer,
      { view: "stream", interactive: false },
      primary.context,
    );
    screens.push({ screen: primaryScreen, context: primary.context });
    const secondaryScreen = await sandbox.connectScreen(
      computer,
      { view: "stream", interactive: false },
      secondary.context,
    );
    screens.push({ screen: secondaryScreen, context: secondary.context });
    assert.notEqual(primaryScreen.url, secondaryScreen.url);
    for (const screen of [primaryScreen, secondaryScreen]) {
      assert.ok(screen.url, "Daytona did not return a desktop preview URL");
      const url = new URL(screen.url);
      assert.equal(url.pathname, "/aimee.html");
      assert.equal(url.searchParams.get("autoconnect"), "true");
      assert.equal(url.searchParams.get("view_only"), "true");
    }
    console.log("Daytona canary: verified two independent AIMEE desktops on one computer");

    while (screens.length) {
      const current = screens.pop()!;
      await current.screen.close();
      await sandbox.releaseScreen(computer, current.context);
    }

    const providerRef = computer.providerRef;
    assert.ok(providerRef, "Daytona did not return a provider reference");
    await sandbox.stop(computer, primary.context);
    computer = await sandbox.provision(
      {
        botId: homeBotId,
        homePath: "/home/daytona/aimee-home",
        providerRef,
        providerKind: "daytona",
      },
      primary.context,
    );
    assert.equal(computer.fresh, false);
    await sandbox.prepare(computer, primary.context);
    const preserved = new TextDecoder().decode(
      await sandbox.readFile(computer, "ci/daytona.txt", primary.context),
    );
    assert.equal(preserved, "preserved");
    console.log("Daytona canary: verified stop, resume, and persistent state");
  } finally {
    clearTimeout(timeout);
    if (computer) {
      while (screens.length) {
        const current = screens.pop()!;
        await current.screen.close().catch(() => undefined);
        await sandbox.releaseScreen(computer, current.context).catch(() => undefined);
      }
      await sandbox.destroy(computer, primary.context);
      console.log("Daytona canary: destroyed the test computer");
    }
  }
}

function canaryContext(botId: string, suffix: string, controller: AbortController) {
  return {
    context: {
      operationId: `daytona-canary-${suffix}`,
      traceId: `daytona-canary-${suffix}`,
      workspaceId: "brandwell-ci",
      userId: "brandwell-ci",
      botId,
      screenLeaseId: `daytona-canary-${suffix}:1`,
      signal: controller.signal,
    } satisfies AdapterContext,
  };
}

function required(source: NodeJS.ProcessEnv, key: string): string {
  const value = optional(source[key]);
  if (!value) throw new Error(`${key} is required for the live Daytona canary`);
  return value;
}

function optional(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}
