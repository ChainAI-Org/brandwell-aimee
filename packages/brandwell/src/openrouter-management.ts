const DEFAULT_OPENROUTER_API = "https://openrouter.ai/api/v1";
const REQUEST_TIMEOUT_MS = 20_000;

export type OpenRouterKeyLimitReset = "daily" | "weekly" | "monthly";

export type OpenRouterCreatedKey = {
  key: string;
  hash: string;
  workspaceId?: string;
  limitUsd?: number;
  limitReset?: OpenRouterKeyLimitReset;
};

export type OpenRouterKeyStatus = {
  hash: string;
  disabled: boolean;
  usageUsd: number;
  usageDailyUsd: number;
  usageMonthlyUsd: number;
  limitUsd?: number;
  limitRemainingUsd?: number;
  limitReset?: OpenRouterKeyLimitReset;
};

type FetchLike = typeof fetch;

export class OpenRouterManagementClient {
  constructor(
    private readonly managementKey: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly apiBase = DEFAULT_OPENROUTER_API,
  ) {
    if (!managementKey.trim()) throw new Error("OpenRouter management key is required");
  }

  async createKey(input: {
    name: string;
    limitUsd?: number;
    limitReset?: OpenRouterKeyLimitReset;
    workspaceId?: string;
    expiresAt?: Date;
  }): Promise<OpenRouterCreatedKey> {
    const name = input.name.trim();
    if (!name) throw new Error("OpenRouter key name is required");
    if (input.limitUsd !== undefined && (!Number.isFinite(input.limitUsd) || input.limitUsd <= 0)) {
      throw new Error("OpenRouter key limit must be a positive amount");
    }
    const response = await this.request("/keys", {
      method: "POST",
      body: JSON.stringify({
        name,
        include_byok_in_limit: true,
        ...(input.limitUsd !== undefined ? { limit: input.limitUsd } : {}),
        limit_reset: input.limitReset ?? "monthly",
        ...(input.workspaceId ? { workspace_id: input.workspaceId } : {}),
        ...(input.expiresAt ? { expires_at: input.expiresAt.toISOString() } : {}),
      }),
    });
    const body = asRecord(response);
    const data = asRecord(body.data);
    const key = typeof body.key === "string" ? body.key : "";
    const hash = typeof data.hash === "string" ? data.hash : "";
    if (!key.startsWith("sk-or-") || !hash) {
      throw new Error("OpenRouter returned an invalid key response");
    }
    return {
      key,
      hash,
      ...(typeof data.workspace_id === "string" ? { workspaceId: data.workspace_id } : {}),
      ...(typeof data.limit === "number" ? { limitUsd: data.limit } : {}),
      ...(isLimitReset(data.limit_reset) ? { limitReset: data.limit_reset } : {}),
    };
  }

  async getKey(hash: string): Promise<OpenRouterKeyStatus> {
    const body = asRecord(await this.request(`/keys/${encodeURIComponent(requiredHash(hash))}`));
    const data = asRecord(body.data);
    const returnedHash = typeof data.hash === "string" ? data.hash : "";
    if (!returnedHash) throw new Error("OpenRouter returned an invalid key status");
    return {
      hash: returnedHash,
      disabled: data.disabled === true,
      usageUsd: numberOrZero(data.usage),
      usageDailyUsd: numberOrZero(data.usage_daily),
      usageMonthlyUsd: numberOrZero(data.usage_monthly),
      ...(typeof data.limit === "number" ? { limitUsd: data.limit } : {}),
      ...(typeof data.limit_remaining === "number"
        ? { limitRemainingUsd: data.limit_remaining }
        : {}),
      ...(isLimitReset(data.limit_reset) ? { limitReset: data.limit_reset } : {}),
    };
  }

  async disableKey(hash: string): Promise<void> {
    await this.request(`/keys/${encodeURIComponent(requiredHash(hash))}`, {
      method: "PATCH",
      body: JSON.stringify({ disabled: true }),
    });
  }

  async deleteKey(hash: string): Promise<void> {
    await this.request(`/keys/${encodeURIComponent(requiredHash(hash))}`, {
      method: "DELETE",
      body: "{}",
    });
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.managementKey}`,
        "content-type": "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`OpenRouter management request failed with status ${response.status}`);
    }
    return response.json();
  }
}

export function microsToUsd(micros: bigint): number {
  if (micros < 0n) throw new Error("Usage limit cannot be negative");
  return Number(micros) / 1_000_000;
}

function requiredHash(hash: string): string {
  const value = hash.trim();
  if (!value) throw new Error("OpenRouter key hash is required");
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isLimitReset(value: unknown): value is OpenRouterKeyLimitReset {
  return value === "daily" || value === "weekly" || value === "monthly";
}
