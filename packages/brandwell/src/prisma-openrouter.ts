import type { PrismaClient } from "@rakazo/db";
import {
  type OpenRouterKeyStatus,
  type OpenRouterManagementClient,
  usdToMicros,
} from "./openrouter-management.js";

export type BrandwellOpenRouterUsageReconciliation = {
  checked: number;
  updated: number;
  failed: number;
};

export async function reconcileBrandwellOpenRouterUsage(
  prisma: PrismaClient,
  openRouter: Pick<OpenRouterManagementClient, "getKey">,
  workspaceId?: string,
): Promise<BrandwellOpenRouterUsageReconciliation> {
  const credentials = await prisma.brandwellWorkspaceModelCredential.findMany({
    where: {
      externalKeyHash: { not: null },
      ...(workspaceId ? { workspaceId } : {}),
    },
    select: {
      id: true,
      externalKeyHash: true,
      limitReset: true,
      status: true,
    },
  });
  let updated = 0;
  let failed = 0;

  for (const credential of credentials) {
    const hash = credential.externalKeyHash;
    if (!hash) continue;
    try {
      const status = await openRouter.getKey(hash);
      const now = new Date();
      await prisma.brandwellWorkspaceModelCredential.update({
        where: { id: credential.id },
        data: {
          currentUsageMicros: reconciledUsageMicros(credential.limitReset, status),
          providerLimitMicros: status.limitUsd === undefined ? null : usdToMicros(status.limitUsd),
          providerUsageSyncedAt: now,
          providerUsageSyncError: null,
          ...(status.disabled && credential.status === "active"
            ? { status: "disabled", disabledAt: now }
            : {}),
        },
      });
      updated += 1;
    } catch (error) {
      failed += 1;
      await prisma.brandwellWorkspaceModelCredential.update({
        where: { id: credential.id },
        data: { providerUsageSyncError: safeErrorMessage(error) },
      });
    }
  }

  return { checked: credentials.length, updated, failed };
}

function reconciledUsageMicros(limitReset: string, status: OpenRouterKeyStatus): bigint {
  if (limitReset === "daily") return usdToMicros(status.usageDailyUsd);
  if (limitReset === "monthly") return usdToMicros(status.usageMonthlyUsd);
  return usdToMicros(status.usageUsd);
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "OpenRouter usage reconciliation failed";
  return message.replace(/[\r\n]+/g, " ").slice(0, 500);
}
