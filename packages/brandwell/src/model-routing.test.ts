import { describe, expect, it } from "vitest";
import {
  BrandwellInferenceDisabledError,
  resolveModelConfig,
  type WorkspaceModelCredential,
} from "./model-routing.js";

const credential: WorkspaceModelCredential = {
  workspaceId: "workspace-acme",
  serviceIdentityId: "svc-acme",
  secretId: "secret-openrouter-acme",
  provider: "openrouter",
  status: "active",
  monthlyLimitMicros: 250_000_000n,
  dailyLimitMicros: 25_000_000n,
  warningLimitMicros: 175_000_000n,
  currentUsageMicros: 180_000_000n,
  currentDailyUsageMicros: 5_000_000n,
  preferredModel: "openai/gpt-5.4-mini",
  computerModel: "anthropic/claude-sonnet-4.6",
  lightweightModel: "google/gemini-3.1-flash-lite-preview",
  reasoningModel: "openai/gpt-5.4",
  fallbackModels: ["openai/gpt-5.4-mini", "anthropic/claude-sonnet-4.6"],
  maxTokens: 8_192,
  thinkingLevel: "medium",
};

describe("BrandWell model routing", () => {
  it("resolves a computer workload with only a secret reference", () => {
    expect(resolveModelConfig(credential, "computer")).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.6",
      credentialRef: "secret-openrouter-acme",
      maxTokens: 8_192,
      thinkingLevel: "medium",
      fallbackModels: ["openai/gpt-5.4-mini"],
      costPolicy: {
        monthlyLimitMicros: 250_000_000n,
        dailyLimitMicros: 25_000_000n,
        currentUsageMicros: 180_000_000n,
        warningExceeded: true,
        hardLimitExceeded: false,
      },
    });
  });

  it("fails closed when cancellation disables the workspace credential", () => {
    expect(() =>
      resolveModelConfig({ ...credential, status: "disabled", disabledAt: new Date() }, "general"),
    ).toThrowError(new BrandwellInferenceDisabledError("credential_disabled"));
  });

  it("fails closed at the monthly hard limit", () => {
    expect(() =>
      resolveModelConfig(
        { ...credential, currentUsageMicros: credential.monthlyLimitMicros },
        "reasoning",
      ),
    ).toThrowError(new BrandwellInferenceDisabledError("monthly_limit"));
  });
});
