import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeAgentState = vi.hoisted(() => ({
  thinkingLevels: [] as string[],
  models: [] as Array<{
    id: string;
    provider: string;
    reasoning: boolean;
    contextWindow?: number;
    maxTokens?: number;
    input?: string[];
  }>,
  runtimeWorkloads: [] as string[],
  failPrompt: false,
}));

type FakeAgentTool = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
};

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { errorMessage: undefined, messages: [] };
    private readonly tools: FakeAgentTool[];
    private readonly model: (typeof fakeAgentState.models)[number];
    private readonly listeners: Array<(event: Record<string, unknown>) => void> = [];

    constructor(options: {
      initialState: {
        thinkingLevel: string;
        tools: FakeAgentTool[];
        model: (typeof fakeAgentState.models)[number];
      };
    }) {
      this.tools = options.initialState.tools;
      this.model = options.initialState.model;
      fakeAgentState.thinkingLevels.push(options.initialState.thinkingLevel);
      fakeAgentState.models.push(options.initialState.model);
    }

    subscribe(listener: (event: Record<string, unknown>) => void) {
      this.listeners.push(listener);
    }
    async prompt() {
      if (fakeAgentState.failPrompt) throw new Error("prompt failed");
      const runSubagent = this.tools.find((tool) => tool.name === "run_subagent");
      await runSubagent?.execute("subagent-call", { name: "helper", task: "help" });
      for (const listener of this.listeners) {
        listener({
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            provider: this.model.provider,
            model: this.model.id,
            usage: {
              input: 1,
              output: 1,
              cost: { total: 0 },
            },
          },
        });
      }
    }
    async waitForIdle() {}
    abort() {}
  },
}));

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: (_provider: string, modelId: string) => {
      if (modelId === "reasoning-model") return { provider: "test", id: modelId, reasoning: true };
      if (modelId === "plain-model") return { provider: "test", id: modelId, reasoning: false };
      if (modelId === "openai/known-static") {
        return {
          provider: "openrouter",
          id: modelId,
          reasoning: false,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 64_000,
        };
      }
      if (modelId === "grok-4.6") {
        return {
          provider: "xai",
          id: modelId,
          reasoning: true,
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: "low",
            medium: "medium",
            high: "high",
            xhigh: "xhigh",
            max: null,
          },
        };
      }
      return undefined;
    },
    streamSimple: () => {
      throw new Error("the fake agent must not call a provider");
    },
  }),
}));

vi.mock("./pi-local-provider.js", () => ({
  registerLocalProvider: (models: unknown) => models,
}));

vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { PiAgentRuntime } from "./pi-runtime.js";

async function runWithModel(
  modelId: string,
  provider = "test",
  signal = new AbortController().signal,
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null,
  maxTokens?: number,
  apiKey?: string,
  metadata?: {
    id: string;
    name: string;
    inputModalities: string[];
    outputModalities: string[];
    supportedParameters: string[];
    reasoning: boolean;
    contextLength?: number;
    maxCompletionTokens?: number;
    pricing: Record<string, string | undefined>;
  },
  workloadType?: "general" | "computer" | "lightweight" | "reasoning",
  computerModel?: string,
) {
  const runtime = new PiAgentRuntime();
  for await (const _event of runtime.run(
    {
      botId: "b",
      threadId: "t",
      runId: "r",
      workloadType,
      prompt: "hello",
      instructions: "",
      history: [],
      tools: [],
      model: {
        provider,
        id: modelId,
        thinkingLevel,
        maxTokens,
        apiKey,
        metadata,
        computerModel,
      },
      executeTool: vi.fn(async () => ({ ok: true })),
    },
    {
      operationId: "1",
      traceId: "1",
      workspaceId: "w",
      userId: "u",
      signal,
    },
  )) {
    if (_event.type === "usage" && _event.workloadType) {
      fakeAgentState.runtimeWorkloads.push(_event.workloadType);
    }
  }
  return fakeAgentState.thinkingLevels;
}

describe("Pi agent thinking level", () => {
  beforeEach(() => {
    fakeAgentState.thinkingLevels = [];
    fakeAgentState.models = [];
    fakeAgentState.runtimeWorkloads = [];
    fakeAgentState.failPrompt = false;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses medium reasoning for the main agent and subagent", async () => {
    // Regression for OpenRouter mandatory-reasoning models (#114): forcing
    // thinkingLevel "off" becomes effort "none" and the provider returns 400.
    const levels = await runWithModel("reasoning-model");
    expect(levels).toEqual(["medium", "medium"]);
    expect(levels.every((level) => level !== "off")).toBe(true);
  });

  it("honors a per-bot thinking level on reasoning models", async () => {
    const levels = await runWithModel("grok-4.6", "xai", new AbortController().signal, "high");
    expect(levels).toEqual(["high", "high"]);
  });

  it("keeps reasoning off for the main agent and subagent", async () => {
    expect(await runWithModel("plain-model")).toEqual(["off", "off"]);
  });

  it("normalizes and runs a configured OpenRouter model absent from the static catalog", async () => {
    vi.stubEnv("PI_DEFAULT_PROVIDER", " openrouter ");
    vi.stubEnv("PI_DEFAULT_MODEL", "  stealth/ox-alpha  ");

    const levels = await runWithModel("  stealth/ox-alpha  ", "openrouter");

    expect(fakeAgentState.models).toHaveLength(2);
    expect(fakeAgentState.models[0]).toMatchObject({
      id: "stealth/ox-alpha",
      provider: "openrouter",
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 4_096,
    });
    // Unknown OpenRouter PI_DEFAULT_MODEL must not force thinking off (#114).
    expect(levels).toEqual(["medium", "medium"]);
    expect(levels.every((level) => level !== "off")).toBe(true);
  });

  it("runs an arbitrary centrally selected OpenRouter model with the managed token cap", async () => {
    await runWithModel(
      "future-vendor/new-agent-model",
      "openrouter",
      new AbortController().signal,
      "high",
      2_048,
    );

    expect(fakeAgentState.models).toHaveLength(2);
    expect(fakeAgentState.models[0]).toMatchObject({
      id: "future-vendor/new-agent-model",
      provider: "openrouter",
      maxTokens: 2_048,
    });
  });

  it("hydrates a new OpenRouter model from live catalog metadata", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: {
          id: "future-vendor/catalog-model",
          name: "Catalog Model",
          architecture: { input_modalities: ["text", "image"] },
          supported_parameters: ["tools", "reasoning"],
          context_length: 256_000,
          top_provider: { max_completion_tokens: 8_192 },
          pricing: { prompt: "0.000001", completion: "0.000002" },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await runWithModel(
      "future-vendor/catalog-model",
      "openrouter",
      new AbortController().signal,
      "high",
      16_384,
      "test-openrouter-key",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/model/future-vendor/catalog-model",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer test-openrouter-key" }),
      }),
    );
    expect(fakeAgentState.models[0]).toMatchObject({
      id: "future-vendor/catalog-model",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 256_000,
      maxTokens: 8_192,
    });
  });

  it("uses catalog metadata saved with the centralized policy without another lookup", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await runWithModel(
      "future-vendor/persisted-model",
      "openrouter",
      new AbortController().signal,
      "high",
      16_384,
      "test-openrouter-key",
      {
        id: "future-vendor/persisted-model",
        name: "Persisted Model",
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        supportedParameters: ["tools", "reasoning"],
        reasoning: true,
        contextLength: 512_000,
        maxCompletionTokens: 32_768,
        pricing: {},
      },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(fakeAgentState.models[0]).toMatchObject({
      id: "future-vendor/persisted-model",
      input: ["text", "image"],
      contextWindow: 512_000,
      maxTokens: 16_384,
    });
  });

  it("lets persisted OpenRouter metadata override a known static catalog entry", async () => {
    await runWithModel(
      "openai/known-static",
      "openrouter",
      new AbortController().signal,
      "high",
      16_384,
      "test-openrouter-key",
      {
        id: "openai/known-static",
        name: "Current managed metadata",
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        supportedParameters: ["tools", "reasoning"],
        reasoning: true,
        contextLength: 512_000,
        maxCompletionTokens: 4_096,
        pricing: {},
      },
    );

    expect(fakeAgentState.models[0]).toMatchObject({
      id: "openai/known-static",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 512_000,
      maxTokens: 4_096,
    });
    expect(fakeAgentState.thinkingLevels).toEqual(["high", "high"]);
  });

  it("records the selected workload instead of inferring it from a shared model id", async () => {
    await runWithModel(
      "plain-model",
      "test",
      new AbortController().signal,
      null,
      undefined,
      undefined,
      undefined,
      "reasoning",
      "plain-model",
    );

    expect(fakeAgentState.runtimeWorkloads).toEqual(["reasoning", "reasoning"]);
  });

  it("uses the trimmed configured default for scripted requests", async () => {
    vi.stubEnv("PI_DEFAULT_MODEL", "  stealth/ox-alpha  ");

    await runWithModel("scripted", "scripted");

    expect(fakeAgentState.models[0]?.id).toBe("stealth/ox-alpha");
  });

  it("removes the abort listener when prompting fails", async () => {
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
    fakeAgentState.failPrompt = true;

    await expect(runWithModel("plain-model", "test", controller.signal)).rejects.toThrow(
      "prompt failed",
    );

    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
