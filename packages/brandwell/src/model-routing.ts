export type BrandwellWorkloadType = "general" | "computer" | "lightweight" | "reasoning";

export type ManagedModelCatalogEntry = {
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

export type WorkspaceModelCredential = {
  workspaceId: string;
  serviceIdentityId: string;
  secretId: string;
  provider: "openrouter" | string;
  status: "active" | "paused" | "disabled";
  disabledAt?: Date | null;
  monthlyLimitMicros: bigint;
  dailyLimitMicros?: bigint | null;
  warningLimitMicros: bigint;
  currentUsageMicros: bigint;
  currentDailyUsageMicros?: bigint;
  preferredModel: string;
  computerModel?: string | null;
  lightweightModel?: string | null;
  reasoningModel?: string | null;
  fallbackModels: readonly string[];
  modelCatalog?: unknown;
  maxTokens?: number | null;
  thinkingLevel?: string | null;
};

export type ResolvedModelConfig = {
  provider: string;
  model: string;
  credentialRef: string;
  maxTokens?: number;
  thinkingLevel?: string;
  fallbackModels: string[];
  fallbackMetadata?: Record<string, ManagedModelCatalogEntry>;
  modelMetadata?: ManagedModelCatalogEntry;
  costPolicy: {
    monthlyLimitMicros: bigint;
    dailyLimitMicros?: bigint;
    currentUsageMicros: bigint;
    warningExceeded: boolean;
    hardLimitExceeded: false;
  };
};

export class BrandwellInferenceDisabledError extends Error {
  readonly managedRunBlocked = true;

  constructor(public readonly reason: "credential_disabled" | "monthly_limit" | "daily_limit") {
    super(`BrandWell managed inference is unavailable: ${reason}`);
    this.name = "BrandwellInferenceDisabledError";
  }
}

export function resolveModelConfig(
  credential: WorkspaceModelCredential,
  workloadType: BrandwellWorkloadType,
): ResolvedModelConfig {
  if (credential.status !== "active" || credential.disabledAt) {
    throw new BrandwellInferenceDisabledError("credential_disabled");
  }
  if (
    credential.monthlyLimitMicros > 0n &&
    credential.currentUsageMicros >= credential.monthlyLimitMicros
  ) {
    throw new BrandwellInferenceDisabledError("monthly_limit");
  }
  if (
    credential.dailyLimitMicros &&
    credential.dailyLimitMicros > 0n &&
    (credential.currentDailyUsageMicros ?? 0n) >= credential.dailyLimitMicros
  ) {
    throw new BrandwellInferenceDisabledError("daily_limit");
  }

  const override =
    workloadType === "computer"
      ? credential.computerModel
      : workloadType === "lightweight"
        ? credential.lightweightModel
        : workloadType === "reasoning"
          ? credential.reasoningModel
          : null;
  const model = override?.trim() || credential.preferredModel;
  const fallbackModels = [...new Set(credential.fallbackModels.filter((item) => item !== model))];
  const modelMetadata = modelCatalogEntry(credential.modelCatalog, model);
  const fallbackMetadata = Object.fromEntries(
    fallbackModels.flatMap((fallbackModel) => {
      const metadata = modelCatalogEntry(credential.modelCatalog, fallbackModel);
      return metadata ? [[fallbackModel, metadata] as const] : [];
    }),
  );

  return {
    provider: credential.provider,
    model,
    credentialRef: credential.secretId,
    ...(credential.maxTokens ? { maxTokens: credential.maxTokens } : {}),
    ...(credential.thinkingLevel ? { thinkingLevel: credential.thinkingLevel } : {}),
    fallbackModels,
    ...(Object.keys(fallbackMetadata).length > 0 ? { fallbackMetadata } : {}),
    ...(modelMetadata ? { modelMetadata } : {}),
    costPolicy: {
      monthlyLimitMicros: credential.monthlyLimitMicros,
      ...(credential.dailyLimitMicros ? { dailyLimitMicros: credential.dailyLimitMicros } : {}),
      currentUsageMicros: credential.currentUsageMicros,
      warningExceeded:
        credential.warningLimitMicros > 0n &&
        credential.currentUsageMicros >= credential.warningLimitMicros,
      hardLimitExceeded: false,
    },
  };
}

function modelCatalogEntry(value: unknown, modelId: string): ManagedModelCatalogEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = (value as Record<string, unknown>)[modelId];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const candidate = entry as Partial<ManagedModelCatalogEntry>;
  if (candidate.id !== modelId || typeof candidate.name !== "string") return undefined;
  return candidate as ManagedModelCatalogEntry;
}
