import { describe, expect, it } from "vitest";
import { renderAimeeScreenClient } from "./aimee-screen-client.js";

describe("managed AIMEE screen client", () => {
  it("renders only the fullscreen computer surface without provider controls", () => {
    const html = renderAimeeScreenClient("test-nonce");

    expect(html).toContain('<div id="screen" aria-label="AIMEE computer"></div>');
    expect(html).toContain('nonce="test-nonce"');
    expect(html).toContain('import RFB from "./core/rfb.js"');
    expect(html).toContain('params.get("password")');
    expect(html).not.toContain("noVNC");
    expect(html).not.toContain("control-bar");
    expect(html).not.toContain("toolbar");
  });
});
