import { describe, expect, it, vi } from "vitest";
import { microsToUsd, OpenRouterManagementClient, usdToMicros } from "./openrouter-management.js";

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
        },
      }),
    );
    const client = new OpenRouterManagementClient("management-secret", fetchImpl as typeof fetch);

    await expect(
      client.updateKey("hash-acme", { limitUsd: 300, limitReset: "monthly" }),
    ).resolves.toMatchObject({ hash: "hash-acme", limitUsd: 300, usageMonthlyUsd: 12 });
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

  it("converts stored microdollar limits to provider dollar limits", () => {
    expect(microsToUsd(200_000_000n)).toBe(200);
    expect(usdToMicros(12.3456789)).toBe(12_345_679n);
  });
});
