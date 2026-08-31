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
  modelCatalog: {
    "anthropic/claude-sonnet-4.6": {
      id: "anthropic/claude-sonnet-4.6",
      name: "Claude Sonnet 4.6",
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      supportedParameters: ["tools", "reasoning"],
      reasoning: true,
      contextLength: 200_000,
      maxCompletionTokens: 64_000,
      pricing: {},
    },
  },
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
      modelMetadata: expect.objectContaining({
        id: "anthropic/claude-sonnet-4.6",
        inputModalities: ["text", "image"],
      }),
      costPolicy: {
        monthlyLimitMicros: 250_000_000n,
        dailyLimitMicros: 25_000_000n,
        currentUsageMicros: 180_000_000n,
        warningExceeded: true,
        hardLimitExceeded: false,
      },
    });
  });

  it("returns persisted metadata for each centrally validated fallback", () => {
    const resolved = resolveModelConfig(credential, "general");

    expect(resolved.fallbackModels).toEqual(["anthropic/claude-sonnet-4.6"]);
    expect(resolved.fallbackMetadata).toEqual({
      "anthropic/claude-sonnet-4.6": expect.objectContaining({
        id: "anthropic/claude-sonnet-4.6",
        inputModalities: ["text", "image"],
      }),
    });
  });

  it.each([
    ["general", "openai/gpt-5.4-mini"],
    ["lightweight", "google/gemini-3.1-flash-lite-preview"],
    ["reasoning", "openai/gpt-5.4"],
  ] as const)("selects the %s workload's central model", (workloadType, expectedModel) => {
    expect(resolveModelConfig(credential, workloadType).model).toBe(expectedModel);
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
