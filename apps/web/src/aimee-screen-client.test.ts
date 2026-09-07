import { describe, expect, it } from "vitest";
import { renderAimeeScreenClient } from "./aimee-screen-client.js";

describe("managed AIMEE screen client", () => {
  it("renders only the fullscreen computer surface without provider controls", () => {
    const html = renderAimeeScreenClient("test-nonce");

    expect(html).toContain('<div id="screen-viewport" aria-label="AIMEE computer screen"></div>');
    expect(html).not.toContain("<iframe");
    expect(html).toContain('nonce="test-nonce"');
    expect(html).toContain('new URL("./core/rfb.js", window.location.href)');
    expect(html).toContain('new URL("./websockify", window.location.href)');
    expect(html).toContain("import(moduleUrl.toString())");
    expect(html).toContain('client.viewOnly = params.get("view_only") !== "false"');
    expect(html).toContain("client.scaleViewport = true");
    expect(html).toContain('window.parent.postMessage({ type: "aimee-screen-state", state }, "*")');
    expect(html).toContain('setStatus("", "connected")');
    expect(html).toContain('client.addEventListener("disconnect"');
    expect(html).toContain("The computer connection was lost");
    expect(html).not.toContain(">noVNC<");
  });
});
