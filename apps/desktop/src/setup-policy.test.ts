import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MANAGED_WEB_URL } from "./setup-config.js";
import {
  isServerChooserEnabled,
  parseSetupIpcPayload,
  parseSetupProbeUrl,
} from "./setup-policy.js";

const managedPolicy = {
  serverChooserEnabled: false,
  managedServerUrl: MANAGED_WEB_URL,
};
const developmentPolicy = {
  serverChooserEnabled: true,
  managedServerUrl: MANAGED_WEB_URL,
};
const setupHtml = readFileSync(new URL("./setup.html", import.meta.url), "utf8");
const setupScript = readFileSync(new URL("./setup.js", import.meta.url), "utf8");
const setupStyles = readFileSync(new URL("./setup.css", import.meta.url), "utf8");
const desktopMain = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

describe("desktop setup server policy", () => {
  it("enables the chooser only for an unpackaged process", () => {
    expect(isServerChooserEnabled(false)).toBe(true);
    expect(isServerChooserEnabled(true)).toBe(false);
  });

  it("accepts the fixed managed origin in an installed build", () => {
    expect(
      parseSetupIpcPayload(
        { mode: "existing", serverUrl: `${MANAGED_WEB_URL}/ignored-path` },
        managedPolicy,
      ),
    ).toEqual({ mode: "existing", serverUrl: MANAGED_WEB_URL });
    expect(parseSetupProbeUrl(MANAGED_WEB_URL, managedPolicy)).toBe(MANAGED_WEB_URL);
  });

  it.each([
    "https://support.example.com",
    "https://staging-ai.brandwell.ai",
    "http://127.0.0.1:5173",
  ])("rejects a client-selected server in an installed build (%s)", (serverUrl) => {
    expect(parseSetupIpcPayload({ mode: "existing", serverUrl }, managedPolicy)).toBeNull();
    expect(parseSetupProbeUrl(serverUrl, managedPolicy)).toBeNull();
  });

  it("retains local and custom server setup for unpackaged development", () => {
    expect(
      parseSetupIpcPayload(
        { mode: "existing", serverUrl: "https://aimee.example.com" },
        developmentPolicy,
      ),
    ).toEqual({ mode: "existing", serverUrl: "https://aimee.example.com" });
    expect(parseSetupProbeUrl("http://127.0.0.1:5173", developmentPolicy)).toBe(
      "http://127.0.0.1:5173",
    );
  });

  it("does not flash the server chooser in a managed build", () => {
    expect(setupHtml).toMatch(/id="server-choices"[^>]*hidden/);
    expect(setupHtml).toMatch(/id="panel-new"[^>]*hidden/);
    expect(setupHtml).toMatch(/id="check"[^>]*hidden/);
    expect(setupHtml).toMatch(/id="support-footnote"[^>]*hidden/);
    expect(setupScript).toContain("choices.hidden = false");
    expect(setupScript).toContain("checkButton.hidden = false");
    expect(setupScript).toContain("supportFootnote.hidden = false");
  });

  it("uses BrandWell purple for setup focus states", () => {
    expect(setupStyles).toContain("--accent: #8b5cf6;");
  });

  it("keeps one desktop process and focuses its existing window", () => {
    expect(desktopMain).toContain("app.requestSingleInstanceLock()");
    expect(desktopMain).toContain('app.on("second-instance", focusOpenAimeeWindow)');
  });
});
