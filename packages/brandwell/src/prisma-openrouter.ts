import type { PrismaClient } from "@rakazo/db";
import {
  type OpenRouterKeyStatus,
  type OpenRouterManagementClient,
  usdToMicros,
} from "./openrouter-management.js";
import { acquireBrandwellModelPolicyLease } from "./prisma-model-policy-lease.js";

export const OPENROUTER_RECONCILIATION_WORKSPACE_CONCURRENCY = 2;
export const OPENROUTER_RECONCILIATION_KEY_BATCH_SIZE = 2;

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
  const where = {
    externalKeyHash: { not: null },
    ...(workspaceId ? { workspaceId } : {}),
  };
  const select = {
    id: true,
    workspaceId: true,
    externalKeyHash: true,
    limitReset: true,
    status: true,
  } as const;
  const [workspaceCredentials, sidekickCredentials] = await Promise.all([
    prisma.brandwellWorkspaceModelCredential.findMany({ where, select }),
    prisma.brandwellSidekickModelCredential.findMany({ where, select }),
  ]);
  const credentials = [
    ...workspaceCredentials.map((credential) => ({ ...credential, kind: "workspace" as const })),
    ...sidekickCredentials.map((credential) => ({ ...credential, kind: "sidekick" as const })),
  ];
  if (credentials.length === 0) return { checked: 0, updated: 0, failed: 0 };

  const workspaceIds = [...new Set(credentials.map((credential) => credential.workspaceId))];
  const mappings = await prisma.brandwellAiWorkspace.findMany({
    where: { rakazoWorkspaceId: { in: workspaceIds } },
    select: { id: true, rakazoWorkspaceId: true },
  });
  const mappingIdByWorkspace = new Map(
    mappings.map((mapping) => [mapping.rakazoWorkspaceId, mapping.id]),
  );
  const byWorkspace = new Map<string, typeof credentials>();
  for (const credential of credentials) {
    const list = byWorkspace.get(credential.workspaceId) ?? [];
    list.push(credential);
    byWorkspace.set(credential.workspaceId, list);
  }

  const outcomes = await mapWithConcurrency(
    [...byWorkspace],
    OPENROUTER_RECONCILIATION_WORKSPACE_CONCURRENCY,
    async ([credentialWorkspaceId, workspaceCredentials]) => {
      const mappingId = mappingIdByWorkspace.get(credentialWorkspaceId);
      if (!mappingId) {
        await writeSyncErrors(
          prisma,
          workspaceCredentials,
          "BrandWell workspace mapping is unavailable",
        );
        return { updated: 0, failed: workspaceCredentials.length };
      }
      const lease = await acquireBrandwellModelPolicyLease(
        prisma,
        mappingId,
        "openrouter-reconciliation",
      );
      // Another API or worker replica owns this tenant. Its sweep will update
      // the same rows, so this replica must not duplicate provider requests.
      if (!lease) return { updated: 0, failed: 0 };

      let updated = 0;
      let failed = 0;
      try {
        for (const batch of chunks(
          workspaceCredentials,
          OPENROUTER_RECONCILIATION_KEY_BATCH_SIZE,
        )) {
          const batchOutcomes = await Promise.all(
            batch.map((credential) => reconcileCredential(prisma, openRouter, credential)),
          );
          updated += batchOutcomes.filter(Boolean).length;
          failed += batchOutcomes.filter((outcome) => !outcome).length;
          await lease.renew();
        }
      } finally {
        await lease.release();
      }
      return { updated, failed };
    },
  );

  return {
    checked: credentials.length,
    updated: outcomes.reduce((total, outcome) => total + outcome.updated, 0),
    failed: outcomes.reduce((total, outcome) => total + outcome.failed, 0),
  };
}

type ReconciliationCredential = {
  id: string;
  workspaceId: string;
  externalKeyHash: string | null;
  limitReset: string;
  status: string;
  kind: "workspace" | "sidekick";
};

async function reconcileCredential(
  prisma: PrismaClient,
  openRouter: Pick<OpenRouterManagementClient, "getKey">,
  credential: ReconciliationCredential,
): Promise<boolean> {
  const hash = credential.externalKeyHash;
  if (!hash) return true;
  try {
    const status = await openRouter.getKey(hash);
    const now = new Date();
    const data = {
      // Local enforcement deliberately follows the managed reset. A provider
      // reset mismatch is persisted separately and raised as critical drift.
      currentUsageMicros: reconciledUsageMicros(credential.limitReset, status),
      providerLimitMicros: status.limitUsd === undefined ? null : usdToMicros(status.limitUsd),
      providerLimitReset: status.limitReset ?? null,
      providerIncludeByokInLimit: status.includeByokInLimit ?? null,
      providerUsageSyncedAt: now,
      providerUsageSyncError: null,
      ...(status.disabled && credential.status === "active"
        ? { status: "disabled", disabledAt: now }
        : {}),
    };
    if (credential.kind === "workspace") {
      await prisma.brandwellWorkspaceModelCredential.update({
        where: { id: credential.id },
        data,
      });
    } else {
      await prisma.brandwellSidekickModelCredential.update({
        where: { id: credential.id },
        data,
      });
    }
    return true;
  } catch (error) {
    await writeSyncError(prisma, credential, safeErrorMessage(error));
    return false;
  }
}

async function writeSyncErrors(
  prisma: PrismaClient,
  credentials: readonly ReconciliationCredential[],
  message: string,
): Promise<void> {
  for (const batch of chunks(credentials, OPENROUTER_RECONCILIATION_KEY_BATCH_SIZE)) {
    await Promise.all(batch.map((credential) => writeSyncError(prisma, credential, message)));
  }
}

async function writeSyncError(
  prisma: PrismaClient,
  credential: ReconciliationCredential,
  message: string,
): Promise<void> {
  const data = { providerUsageSyncError: message };
  if (credential.kind === "workspace") {
    await prisma.brandwellWorkspaceModelCredential.update({
      where: { id: credential.id },
      data,
    });
  } else {
    await prisma.brandwellSidekickModelCredential.update({
      where: { id: credential.id },
      data,
    });
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await work(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
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
