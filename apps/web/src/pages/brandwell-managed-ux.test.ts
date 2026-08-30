import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const home = readFileSync(new URL("./BrandwellHome.tsx", import.meta.url), "utf8");
const shell = readFileSync(new URL("./Shell.tsx", import.meta.url), "utf8");
const connections = readFileSync(new URL("./PluginsOverlay.tsx", import.meta.url), "utf8");

describe("managed AIMEE workspace navigation", () => {
  it("opens the primary AIMEE chat by default and keeps the dashboard in the chat sidebar", () => {
    expect(app).toContain('path="/app/dashboard"');
    expect(app).toContain("user ? <ShellPage />");
    expect(home).toContain("<Navigate to={`/app/${me.brandwell.primaryBotId}`} replace />");
    expect(shell).toContain("<BrandwellHome me={bootstrapMe} embedded />");
    expect(shell).toContain('navigate("/app/dashboard")');
    expect(shell).toContain(">Dashboard</span>");
    expect(shell).toContain(">Chats</span>");
  });

  it("provides an explicit new-chat control for a managed AI employee", () => {
    expect(shell).toContain("aria-label={t`Start a new chat`}");
    expect(shell).toContain("setClearTarget(active)");
    expect(shell).toContain("This permanently removes every message and stops current work");
  });
});

describe("managed AIMEE connections", () => {
  it("shows included managed capabilities before optional OAuth apps", () => {
    expect(connections).toContain("MANAGED_AIMEE_CAPABILITIES");
    expect(connections).toContain("Included with AIMEE");
    expect(connections).toContain("BrandWell workspace");
    expect(connections).toContain("Computer and browser");
    expect(connections).toContain("Managed AI models");
    expect(connections).toContain("Optional app connections are not enabled");
  });
});
