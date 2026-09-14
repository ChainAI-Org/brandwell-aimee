import { createDecipheriv, createHash, createHmac } from "node:crypto";
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
    const signature = result.pathname.split("/")[5]!.split(".")[1];
    expect(signature).toBe(
      createHmac("sha256", "secret")
        .update("aimee-screen-proxy-v2:127.0.0.1:49152:view:3600100")
        .digest("base64url"),
    );
    expect(signature).not.toBe(
      createHmac("sha256", "secret").update("127.0.0.1:49152:view:3600100").digest("base64url"),
    );
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
    const payload = Buffer.from(result.pathname.split("/")[4]!.split(".")[1]!, "base64url");
    const open = (domain: string) => {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        createHash("sha256").update("secret").digest(),
        payload.subarray(0, 12),
      );
      decipher.setAuthTag(payload.subarray(12, 28));
      decipher.setAAD(Buffer.from(`${domain}view:3600100`));
      return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString(
        "utf8",
      );
    };
    expect(open("aimee-screen-proxy-v2:")).toContain("token=provider-token");
    expect(() => open("")).toThrow();
  });
});
