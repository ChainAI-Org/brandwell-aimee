import type { PrismaClient } from "@rakazo/db";
import {
  type BrandwellWorkloadType,
  resolveModelConfig,
  type WorkspaceModelCredential,
} from "./model-routing.js";

export type BrandwellManagedModelScope = {
  workspaceId: string;
  userId: string;
  botId?: string;
  workloadType?: BrandwellWorkloadType;
};

export type BrandwellManagedModelResolution = {
  provider: string;
  id: string;
  secretId: string;
  serviceIdentityId: string;
  thinkingLevel?: string;
  maxTokens?: number;
  fallbackModels: string[];
  warningExceeded: boolean;
};

export type BrandwellManagedRunBlockReason =
  | "unmanaged_bot"
  | "bot_paused"
  | "workspace_inactive"
  | "service_identity_missing"
  | "service_identity_inactive"
  | "credential_missing"
  | "credential_scope_mismatch";

export class BrandwellManagedRunBlockedError extends Error {
  readonly managedRunBlocked = true;

  constructor(public readonly reason: BrandwellManagedRunBlockReason) {
    super(`BrandWell managed run is unavailable: ${reason}`);
    this.name = "BrandwellManagedRunBlockedError";
  }
}

const ACTIVE_SUBSCRIPTIONS = new Set(["active", "trialing"]);

function currentUtcDayStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

export function createBrandwellManagedModelResolver(prisma: PrismaClient) {
  return async function resolveBrandwellManagedModel(
    scope: BrandwellManagedModelScope,
  ): Promise<BrandwellManagedModelResolution | null> {
    if (!scope.botId) return null;

    const bot = await prisma.bot.findFirst({
      where: {
        id: scope.botId,
        workspaceId: scope.workspaceId,
      },
      select: {
        managedByBrandWell: true,
        managedStatus: true,
        serviceIdentityId: true,
      },
    });
    if (!bot) return null;
    if (!bot.managedByBrandWell) {
      const managedWorkspace = await prisma.brandwellAiWorkspace.findUnique({
        where: { rakazoWorkspaceId: scope.workspaceId },
        select: { id: true },
      });
      if (managedWorkspace) {
        throw new BrandwellManagedRunBlockedError("unmanaged_bot");
      }
      return null;
    }
    if (bot.managedStatus !== "active") {
      throw new BrandwellManagedRunBlockedError("bot_paused");
    }
    if (!bot.serviceIdentityId) {
      throw new BrandwellManagedRunBlockedError("service_identity_missing");
    }

    const [mapping, serviceIdentity, workspaceCredential, sidekick] = await Promise.all([
      prisma.brandwellAiWorkspace.findUnique({
        where: { rakazoWorkspaceId: scope.workspaceId },
        select: {
          subscriptionStatus: true,
          serviceIdentityId: true,
          openRouterCredentialId: true,
        },
      }),
      prisma.brandwellServiceIdentity.findUnique({
        where: { id: bot.serviceIdentityId },
        select: { workspaceId: true, status: true },
      }),
      prisma.brandwellWorkspaceModelCredential.findUnique({
        where: { workspaceId: scope.workspaceId },
      }),
      prisma.brandwellSidekick.findUnique({
        where: { botId: scope.botId },
        include: { modelCredential: true },
      }),
    ]);
    const credential = sidekick ? sidekick.modelCredential : workspaceCredential;

    if (!mapping || !ACTIVE_SUBSCRIPTIONS.has(mapping.subscriptionStatus)) {
      throw new BrandwellManagedRunBlockedError("workspace_inactive");
    }
    if (
      !serviceIdentity ||
      serviceIdentity.workspaceId !== scope.workspaceId ||
      serviceIdentity.status !== "active"
    ) {
      throw new BrandwellManagedRunBlockedError("service_identity_inactive");
    }
    if (!credential) {
      throw new BrandwellManagedRunBlockedError("credential_missing");
    }

    const sharedOwnershipMatches =
      credential.workspaceId === scope.workspaceId &&
      credential.serviceIdentityId === bot.serviceIdentityId &&
      (!mapping.serviceIdentityId || mapping.serviceIdentityId === bot.serviceIdentityId);
    const ownershipMatches = sidekick
      ? sharedOwnershipMatches &&
        sidekick.workspaceId === scope.workspaceId &&
        sidekick.status === "active" &&
        sidekick.modelCredential?.sidekickId === sidekick.id
      : sharedOwnershipMatches &&
        (!mapping.openRouterCredentialId || mapping.openRouterCredentialId === credential.id);
    if (!ownershipMatches) {
      throw new BrandwellManagedRunBlockedError("credential_scope_mismatch");
    }

    const secret = await prisma.secret.findFirst({
      where: {
        id: credential.secretId,
        workspaceId: scope.workspaceId,
        ownerType: "service",
        serviceIdentityId: bot.serviceIdentityId,
      },
      select: { id: true },
    });
    if (!secret) {
      throw new BrandwellManagedRunBlockedError("credential_scope_mismatch");
    }

    const currentDailyUsageMicros =
      credential.dailyLimitMicros && credential.dailyLimitMicros > 0n
        ? ((
            await prisma.usageRecord.aggregate({
              where: {
                workspaceId: scope.workspaceId,
                serviceIdentityId: bot.serviceIdentityId,
                ...(sidekick ? { botId: scope.botId } : {}),
                createdAt: { gte: currentUtcDayStart() },
              },
              _sum: { costMicros: true },
            })
          )._sum.costMicros ?? 0n)
        : 0n;

    const modelCredential: WorkspaceModelCredential = {
      workspaceId: credential.workspaceId,
      serviceIdentityId: credential.serviceIdentityId,
      secretId: credential.secretId,
      provider: credential.provider,
      status: credential.status as WorkspaceModelCredential["status"],
      disabledAt: credential.disabledAt,
      monthlyLimitMicros: credential.monthlyLimitMicros,
      dailyLimitMicros: credential.dailyLimitMicros,
      warningLimitMicros: credential.warningLimitMicros,
      currentUsageMicros: credential.currentUsageMicros,
      currentDailyUsageMicros,
      preferredModel: credential.preferredModel,
      computerModel: credential.computerModel,
      lightweightModel: credential.lightweightModel,
      reasoningModel: credential.reasoningModel,
      fallbackModels: stringArray(credential.fallbackModels),
      maxTokens: credential.maxTokens,
      thinkingLevel: credential.thinkingLevel,
    };
    const resolved = resolveModelConfig(modelCredential, scope.workloadType ?? "general");

    return {
      provider: resolved.provider,
      id: resolved.model,
      secretId: resolved.credentialRef,
      serviceIdentityId: bot.serviceIdentityId,
      ...(resolved.thinkingLevel ? { thinkingLevel: resolved.thinkingLevel } : {}),
      ...(resolved.maxTokens ? { maxTokens: resolved.maxTokens } : {}),
      fallbackModels: resolved.fallbackModels,
      warningExceeded: resolved.costPolicy.warningExceeded,
    };
  };
}
