import { describe, expect, it } from "vitest";
import { BRANDWELL_MANAGED_ORIGINS, isTrustedOrigin } from "./origin-policy.js";

const env = {
  webOrigin: "https://temporary-web.example.test",
  apiUrl: "https://temporary-api.example.test",
  authUrl: "https://temporary-auth.example.test",
};

describe("AIMEE trusted origins", () => {
  it.each(BRANDWELL_MANAGED_ORIGINS)("trusts the exact managed origin %s", (origin) => {
    expect(isTrustedOrigin(origin, env)).toBe(true);
  });

  it("rejects lookalike BrandWell domains", () => {
    expect(isTrustedOrigin("https://ai.brandwell.ai.evil.test", env)).toBe(false);
    expect(isTrustedOrigin("https://staging-ai.brandwell.ai.evil.test", env)).toBe(false);
  });

  it("preserves configured, desktop, mobile, and local development origins", () => {
    expect(isTrustedOrigin(env.webOrigin, env)).toBe(true);
    expect(isTrustedOrigin("aimee://desktop", env)).toBe(true);
    expect(isTrustedOrigin("exp://127.0.0.1:8081", env)).toBe(true);
    expect(isTrustedOrigin("http://localhost:5173", env)).toBe(true);
  });
});
