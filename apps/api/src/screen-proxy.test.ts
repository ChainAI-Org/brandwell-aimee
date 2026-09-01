import { describe, expect, it } from "vitest";
import { addScreenProxyCapability } from "./screen-proxy.js";

describe("screen proxy capability", () => {
  it("signs loopback Docker screen URLs without changing their destination", () => {
    const result = new URL(
      addScreenProxyCapability(
        "http://127.0.0.1:49152/embed.html?view_only=true",
        "secret",
        "https://app.example",
        100,
      ),
    );
    expect(result.origin).toBe("https://app.example");
    expect(result.pathname).toMatch(
      /^\/novnc\/[\w-]+\/49152\/view\/3600100\.[\w-]{43}\/embed\.html$/,
    );
    expect(result.searchParams.get("view_only")).toBe("true");
  });

  it("does not modify managed-provider URLs", () => {
    const url = "https://sandbox.example/embed.html?token=provider-token";
    expect(addScreenProxyCapability(url, "secret", "https://app.example", 100)).toBe(url);
  });

  it("keeps external desktop secrets behind an encrypted, policy-bound capability", () => {
    const result = new URL(
      addScreenProxyCapability(
        "https://box.example/vnc.html?token=provider-token&autoconnect=true&resize=scale&password=desktop-password&view_only=true",
        "secret",
        "https://app.example",
        100,
        { proxyExternal: true },
      ),
    );
    expect(result.origin).toBe("https://app.example");
    expect(result.pathname).toMatch(/^\/novnc\/remote\/view\/3600100\.[\w-]+\/vnc\.html$/);
    expect(result.searchParams.get("autoconnect")).toBe("true");
    expect(result.searchParams.get("resize")).toBe("scale");
    expect(result.searchParams.get("password")).toBe("desktop-password");
    expect(result.searchParams.get("view_only")).toBe("true");
    expect(result.toString()).not.toContain("provider-token");
    expect(result.searchParams.has("token")).toBe(false);
  });
});
