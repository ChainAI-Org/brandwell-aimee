import { describe, expect, it } from "vitest";
import { renderAimeeScreenClient } from "./aimee-screen-client.js";

describe("managed AIMEE screen client", () => {
  it("renders only the fullscreen computer surface without provider controls", () => {
    const html = renderAimeeScreenClient("test-nonce");

    expect(html).toContain('<iframe id="screen-frame" title="AIMEE computer"></iframe>');
    expect(html).toContain('nonce="test-nonce"');
    expect(html).toContain('new URL("./vnc.html", window.location.href)');
    expect(html).toContain("providerView.search = window.location.search");
    expect(html).toContain("#noVNC_control_bar_anchor");
    expect(html).toContain("display: none !important");
    expect(html).toContain("AIMEE is reconnecting to the computer");
    expect(html).not.toContain(">noVNC<");
  });
});
