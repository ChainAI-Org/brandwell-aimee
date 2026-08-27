import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const base = {
  DATABASE_URL: "postgres://rakazo:rakazo@127.0.0.1:5433/rakazo",
  NODE_ENV: "test",
};

describe("loadEnv", () => {
  it("defaults the product path to Pi, Docker, and Graphile Worker", () => {
    const env = loadEnv(base);
    expect(env.agentRuntime).toBe("pi");
    expect(env.sandboxProvider).toBe("docker");
    expect(env.wakeupDriver).toBe("graphile");
  });

  it("keeps explicit emulator settings for pnpm test", () => {
    const env = loadEnv({
      ...base,
      AGENT_RUNTIME: "scripted",
      SANDBOX_PROVIDER: "fake",
      WAKEUP_DRIVER: "memory",
    });
    expect(env.agentRuntime).toBe("scripted");
    expect(env.sandboxProvider).toBe("fake");
    expect(env.wakeupDriver).toBe("memory");
  });

  it("loads provider-specific Daytona configuration", () => {
    const env = loadEnv({
      ...base,
      SANDBOX_PROVIDER: "daytona",
      DAYTONA_API_KEY: "test-daytona-key",
      DAYTONA_API_URL: "https://daytona.test/api",
      DAYTONA_TARGET: "test-target",
    });
    expect(env).toMatchObject({
      sandboxProvider: "daytona",
      daytonaApiKey: "test-daytona-key",
      daytonaApiUrl: "https://daytona.test/api",
      daytonaTarget: "test-target",
    });
  });

  it("loads provider-specific Box configuration", () => {
    const env = loadEnv({
      ...base,
      SANDBOX_PROVIDER: "box",
      BOX_API_KEY: "test-box-key",
      BOX_API_URL: "https://box.test/api/v1",
    });
    expect(env).toMatchObject({
      sandboxProvider: "box",
      boxApiKey: "test-box-key",
      boxApiUrl: "https://box.test/api/v1",
    });
  });

  it("throws when production omits secrets", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: base.DATABASE_URL,
        NODE_ENV: "production",
      }),
    ).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("throws when production uses placeholder secrets", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: base.DATABASE_URL,
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "dev-secret-change-me-please-32chars",
        ENCRYPTION_KEY: "real-encryption-key-value",
      }),
    ).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("loads real secrets in production", () => {
    const env = loadEnv({
      DATABASE_URL: base.DATABASE_URL,
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
      ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
    });
    expect(env.authSecret).toBe("prod-auth-secret-with-enough-length");
    expect(env.encryptionKey).toBe("prod-encryption-key-with-enough-length");
  });

  it("exposes a deployed git revision when GIT_SHA is set", () => {
    expect(loadEnv(base).gitSha).toBeUndefined();
    expect(loadEnv({ ...base, GIT_SHA: "  3c6e209  " }).gitSha).toBe("3c6e209");
    expect(loadEnv({ ...base, RAKAZO_GIT_SHA: "abc1234" }).gitSha).toBe("abc1234");
  });

  it("requires both BrandWell platform connector settings", () => {
    expect(() =>
      loadEnv({
        ...base,
        BRANDWELL_PLATFORM_API_URL: "https://portal.example.test",
      }),
    ).toThrow(/configured together/);
  });

  it("loads the paired BrandWell platform connector settings", () => {
    expect(
      loadEnv({
        ...base,
        BRANDWELL_PLATFORM_API_URL: "https://portal.example.test",
        BRANDWELL_PLATFORM_SERVICE_TOKEN: "test-service-token-0123456789abcdef",
      }),
    ).toMatchObject({
      brandwellPlatformApiUrl: "https://portal.example.test",
      brandwellPlatformServiceToken: "test-service-token-0123456789abcdef",
    });
  });

  it("rejects weak BrandWell platform service tokens in every environment", () => {
    expect(() =>
      loadEnv({
        ...base,
        BRANDWELL_PLATFORM_API_URL: "https://portal.example.test",
        BRANDWELL_PLATFORM_SERVICE_TOKEN: "too-short",
      }),
    ).toThrow(/at least 32 characters/);
  });

  it("rejects weak BrandWell management API tokens in every environment", () => {
    expect(() =>
      loadEnv({
        ...base,
        BRANDWELL_MANAGEMENT_API_TOKEN: "too-short",
      }),
    ).toThrow(/BRANDWELL_MANAGEMENT_API_TOKEN must be at least 32 characters/);
  });
});
