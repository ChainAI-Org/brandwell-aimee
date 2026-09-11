import { describe, expect, it } from "vitest";
import { addScreenProxyCapability } from "../../../apps/api/src/screen-proxy.js";
import { resolveNovncTarget } from "../../../apps/web/src/screen-proxy.js";

describe("API and web screen capability contract", () => {
  it.each([
    ["http://127.0.0.1:6081/aimee.html?view_only=true", false],
    ["https://provider.example/aimee.html?view_only=true", false],
    ["http://127.0.0.1:6096/aimee.html?view_only=false", true],
    ["https://provider.example/aimee.html?view_only=false", true],
  ])("resolves the API capability for %s", (url, interactive) => {
    const capability = addScreenProxyCapability(url, "secret", "https://app.example", 1_000, {
      proxyExternal: true,
    });
    const target = new URL(capability);
    expect(resolveNovncTarget(target.pathname + target.search, "secret", 1_000)).toMatchObject({
      interactive,
    });
  });
});
