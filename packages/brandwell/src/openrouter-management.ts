const DEFAULT_OPENROUTER_API = "https://openrouter.ai/api/v1";
const REQUEST_TIMEOUT_MS = 20_000;

export type OpenRouterKeyLimitReset = "daily" | "weekly" | "monthly";

export type OpenRouterCreatedKey = {
  key: string;
  hash: string;
  workspaceId?: string;
  limitUsd?: number;
  limitReset?: OpenRouterKeyLimitReset;
  includeByokInLimit?: boolean;
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
  includeByokInLimit?: boolean;
};

export type OpenRouterKeyUpdate = {
  disabled?: boolean;
  limitUsd?: number | null;
  limitReset?: OpenRouterKeyLimitReset | null;
};

export type OpenRouterModelStatus = {
  id: string;
  name: string;
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  reasoning: boolean;
  contextLength?: number;
  maxCompletionTokens?: number;
  pricing: {
    prompt?: string;
    completion?: string;
    inputCacheRead?: string;
    inputCacheWrite?: string;
  };
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
      ...(typeof data.include_byok_in_limit === "boolean"
        ? { includeByokInLimit: data.include_byok_in_limit }
        : {}),
    };
  }

  async getKey(hash: string): Promise<OpenRouterKeyStatus> {
    const body = asRecord(await this.request(`/keys/${encodeURIComponent(requiredHash(hash))}`));
    return keyStatus(body);
  }

  async disableKey(hash: string): Promise<void> {
    await this.request(`/keys/${encodeURIComponent(requiredHash(hash))}`, {
      method: "PATCH",
      body: JSON.stringify({ disabled: true }),
    });
  }

  async updateKey(hash: string, input: OpenRouterKeyUpdate): Promise<OpenRouterKeyStatus> {
    if (
      input.limitUsd !== undefined &&
      input.limitUsd !== null &&
      (!Number.isFinite(input.limitUsd) || input.limitUsd <= 0)
    ) {
      throw new Error("OpenRouter key limit must be a positive amount or null");
    }
    const body = asRecord(
      await this.request(`/keys/${encodeURIComponent(requiredHash(hash))}`, {
        method: "PATCH",
        body: JSON.stringify({
          ...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
          ...(input.limitUsd !== undefined ? { limit: input.limitUsd } : {}),
          ...(input.limitReset !== undefined ? { limit_reset: input.limitReset } : {}),
          include_byok_in_limit: true,
        }),
      }),
    );
    return keyStatus(body);
  }

  async deleteKey(hash: string): Promise<void> {
    try {
      await this.request(`/keys/${encodeURIComponent(requiredHash(hash))}`, {
        method: "DELETE",
        body: "{}",
      });
    } catch (error) {
      if (error instanceof Error && error.message.endsWith("status 404")) return;
      throw error;
    }
  }

  async getModel(modelId: string): Promise<OpenRouterModelStatus | null> {
    const [author, slug, extra] = modelId.trim().split("/");
    if (!author || !slug || extra)
      throw new Error("OpenRouter model id must use vendor/model format");
    let response: unknown;
    try {
      response = await this.request(
        `/model/${encodeURIComponent(author)}/${encodeURIComponent(slug)}`,
      );
    } catch (error) {
      if (error instanceof Error && error.message.endsWith("status 404")) return null;
      throw error;
    }
    const data = asRecord(asRecord(response).data);
    const id = typeof data.id === "string" ? data.id : "";
    if (!id || id !== modelId.trim()) {
      throw new Error("OpenRouter returned an invalid model response");
    }
    const architecture = asRecord(data.architecture);
    const topProvider = asRecord(data.top_provider);
    const supportedParameters = stringList(data.supported_parameters);
    const defaultParameters = asRecord(data.default_parameters);
    const pricing = asRecord(data.pricing);
    return {
      id,
      name: typeof data.name === "string" && data.name.trim() ? data.name.trim() : id,
      inputModalities: stringList(architecture.input_modalities),
      outputModalities: stringList(architecture.output_modalities),
      supportedParameters,
      reasoning:
        supportedParameters.includes("reasoning") ||
        supportedParameters.includes("include_reasoning") ||
        Boolean(defaultParameters.reasoning),
      pricing: {
        ...(typeof pricing.prompt === "string" ? { prompt: pricing.prompt } : {}),
        ...(typeof pricing.completion === "string" ? { completion: pricing.completion } : {}),
        ...(typeof pricing.input_cache_read === "string"
          ? { inputCacheRead: pricing.input_cache_read }
          : {}),
        ...(typeof pricing.input_cache_write === "string"
          ? { inputCacheWrite: pricing.input_cache_write }
          : {}),
      },
      ...(positiveNumber(data.context_length) !== undefined
        ? { contextLength: positiveNumber(data.context_length) }
        : {}),
      ...(positiveNumber(topProvider.max_completion_tokens) !== undefined
        ? { maxCompletionTokens: positiveNumber(topProvider.max_completion_tokens) }
        : {}),
    };
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

export function usdToMicros(usd: number): bigint {
  if (!Number.isFinite(usd) || usd < 0) throw new Error("Usage amount cannot be negative");
  return BigInt(Math.round(usd * 1_000_000));
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

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function keyStatus(body: Record<string, unknown>): OpenRouterKeyStatus {
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
    ...(typeof data.include_byok_in_limit === "boolean"
      ? { includeByokInLimit: data.include_byok_in_limit }
      : {}),
  };
}

function isLimitReset(value: unknown): value is OpenRouterKeyLimitReset {
  return value === "daily" || value === "weekly" || value === "monthly";
}
