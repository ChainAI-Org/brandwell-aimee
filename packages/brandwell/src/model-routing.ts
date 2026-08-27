export type BrandwellWorkloadType = "general" | "computer" | "lightweight" | "reasoning";

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

  return {
    provider: credential.provider,
    model,
    credentialRef: credential.secretId,
    ...(credential.maxTokens ? { maxTokens: credential.maxTokens } : {}),
    ...(credential.thinkingLevel ? { thinkingLevel: credential.thinkingLevel } : {}),
    fallbackModels,
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
