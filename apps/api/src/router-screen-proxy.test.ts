import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const router = readFileSync(new URL("./router.ts", import.meta.url), "utf8");

describe("customer computer screen routing", () => {
  it("keeps every external computer URL behind the AIMEE screen proxy", () => {
    const screenHandler = router.slice(
      router.indexOf("screenUrl: authed.computer.screenUrl.handler"),
      router.indexOf("heartbeat: authed.computer.heartbeat.handler"),
    );
    expect(screenHandler).toContain("{ proxyExternal: true }");
    expect(screenHandler).not.toContain('bot.computer.kind === "box"');
  });
});
