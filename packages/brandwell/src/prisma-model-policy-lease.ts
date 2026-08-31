import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";

const MODEL_POLICY_LEASE_MS = 10 * 60_000;

export type BrandwellModelPolicyLease = {
  owner: string;
  renew(): Promise<void>;
  release(): Promise<void>;
};

/**
 * Serialize model-policy changes and Sidekick provisioning across API replicas.
 * A database-backed expiring lease avoids holding a transaction open across
 * OpenRouter network calls and self-recovers if a process exits unexpectedly.
 */
export async function acquireBrandwellModelPolicyLease(
  prisma: PrismaClient,
  mappingId: string,
  operation: string,
  now: () => Date = () => new Date(),
): Promise<BrandwellModelPolicyLease | null> {
  const owner = `${operation}:${randomUUID()}`;
  const acquiredAt = now();
  const acquired = await prisma.brandwellAiWorkspace.updateMany({
    where: {
      id: mappingId,
      OR: [{ modelPolicyLeaseExpiresAt: null }, { modelPolicyLeaseExpiresAt: { lte: acquiredAt } }],
    },
    data: {
      modelPolicyLeaseOwner: owner,
      modelPolicyLeaseExpiresAt: new Date(acquiredAt.getTime() + MODEL_POLICY_LEASE_MS),
    },
  });
  if (acquired.count !== 1) return null;

  return {
    owner,
    async renew() {
      const renewedAt = now();
      const renewed = await prisma.brandwellAiWorkspace.updateMany({
        where: { id: mappingId, modelPolicyLeaseOwner: owner },
        data: {
          modelPolicyLeaseExpiresAt: new Date(renewedAt.getTime() + MODEL_POLICY_LEASE_MS),
        },
      });
      if (renewed.count !== 1) throw new Error("The AIMEE model-policy lease was lost");
    },
    async release() {
      await prisma.brandwellAiWorkspace.updateMany({
        where: { id: mappingId, modelPolicyLeaseOwner: owner },
        data: { modelPolicyLeaseOwner: null, modelPolicyLeaseExpiresAt: null },
      });
    },
  };
}
