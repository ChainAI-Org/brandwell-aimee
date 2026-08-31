import { describe, expect, it, vi } from "vitest";
import {
  managedMonthlyOpenRouterKeyPolicy,
  microsToUsd,
  OpenRouterManagementClient,
  openRouterProviderPolicyEvidence,
  usdToMicros,
} from "./openrouter-management.js";

const TEST_OPENROUTER_KEY = ["sk", "or", "test-placeholder"].join("-");

describe("OpenRouter management client", () => {
  it("creates an isolated monthly-limited key and returns the plaintext only to the caller", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json(
        {
          data: {
            hash: "hash-acme",
            workspace_id: "openrouter-workspace",
            limit: 200,
            limit_reset: "monthly",
            include_byok_in_limit: true,
          },
          key: TEST_OPENROUTER_KEY,
        },
        { status: 201 },
      ),
    );
    const client = new OpenRouterManagementClient("management-secret", fetchImpl as typeof fetch);

    await expect(client.createKey({ name: "AIMEE-Acme", limitUsd: 200 })).resolves.toEqual({
      key: TEST_OPENROUTER_KEY,
      hash: "hash-acme",
      workspaceId: "openrouter-workspace",
      limitUsd: 200,
      limitReset: "monthly",
      includeByokInLimit: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/keys",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer management-secret" }),
        body: JSON.stringify({
          name: "AIMEE-Acme",
          include_byok_in_limit: true,
          limit: 200,
          limit_reset: "monthly",
        }),
      }),
    );
  });

  it("disables a client key by its non-secret hash", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ data: { disabled: true } }));
    const client = new OpenRouterManagementClient("management-secret", fetchImpl as typeof fetch);

    await client.disableKey("hash-acme");

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/keys/hash-acme",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ disabled: true }) }),
    );
  });

  it("does not echo a management secret when the provider rejects a request", async () => {
    const fetchImpl = vi.fn(async () => new Response("secret provider detail", { status: 403 }));
    const client = new OpenRouterManagementClient(
      "management-secret-never-log",
      fetchImpl as typeof fetch,
    );

    await expect(client.disableKey("hash-acme")).rejects.toThrow(
      "OpenRouter management request failed with status 403",
    );
  });

  it("updates a child key limit through the management API", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        data: {
          hash: "hash-acme",
          disabled: false,
          usage: 24,
          usage_daily: 2,
          usage_monthly: 12,
          limit: 300,
          limit_remaining: 288,
          limit_reset: "monthly",
          include_byok_in_limit: true,
        },
      }),
    );
    const client = new OpenRouterManagementClient("management-secret", fetchImpl as typeof fetch);

    await expect(
      client.updateKey("hash-acme", { limitUsd: 300, limitReset: "monthly" }),
    ).resolves.toMatchObject({
      hash: "hash-acme",
      limitUsd: 300,
      usageMonthlyUsd: 12,
      limitReset: "monthly",
      includeByokInLimit: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/keys/hash-acme",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          limit: 300,
          limit_reset: "monthly",
          include_byok_in_limit: true,
        }),
      }),
    );
  });

  it("treats deletion of an already-removed key as an idempotent success", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const client = new OpenRouterManagementClient("management-secret", fetchImpl as typeof fetch);

    await expect(client.deleteKey("hash-already-removed")).resolves.toBeUndefined();
  });

  it("loads model capabilities for centralized policy validation", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        data: {
          id: "openai/gpt-5.4-mini",
          architecture: {
            input_modalities: ["text", "image"],
            output_modalities: ["text"],
          },
          supported_parameters: ["tools", "reasoning", "max_tokens"],
          context_length: 400_000,
          top_provider: { max_completion_tokens: 128_000 },
          name: "GPT 5.4 Mini",
          pricing: { prompt: "0.000001", completion: "0.000002" },
        },
      }),
    );
    const client = new OpenRouterManagementClient("management-secret", fetchImpl as typeof fetch);

    await expect(client.getModel("openai/gpt-5.4-mini")).resolves.toEqual({
      id: "openai/gpt-5.4-mini",
      name: "GPT 5.4 Mini",
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      supportedParameters: ["tools", "reasoning", "max_tokens"],
      reasoning: true,
      contextLength: 400_000,
      maxCompletionTokens: 128_000,
      pricing: { prompt: "0.000001", completion: "0.000002" },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/model/openai/gpt-5.4-mini",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer management-secret" }),
      }),
    );
  });

  it("rejects catalog metadata for a different model id", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        data: {
          id: "provider/different-model",
          architecture: { input_modalities: ["text"], output_modalities: ["text"] },
          supported_parameters: ["tools"],
        },
      }),
    );
    const client = new OpenRouterManagementClient("management-secret", fetchImpl as typeof fetch);

    await expect(client.getModel("provider/requested-model")).rejects.toThrow(
      /invalid model response/,
    );
  });

  it("converts stored microdollar limits to provider dollar limits", () => {
    expect(microsToUsd(200_000_000n)).toBe(200);
    expect(usdToMicros(12.3456789)).toBe(12_345_679n);
  });

  it("keeps the managed reset monthly while preserving contrary create-key evidence", () => {
    expect(
      managedMonthlyOpenRouterKeyPolicy({
        limitUsd: 200,
        limitReset: "daily",
        includeByokInLimit: false,
      }),
    ).toEqual({
      limitReset: "monthly",
      providerLimitMicros: 200_000_000n,
      providerLimitReset: "daily",
      providerIncludeByokInLimit: false,
    });
  });

  it("keeps omitted provider policy evidence unknown", () => {
    expect(openRouterProviderPolicyEvidence({})).toEqual({
      providerLimitMicros: null,
      providerLimitReset: null,
      providerIncludeByokInLimit: null,
    });
  });
});
