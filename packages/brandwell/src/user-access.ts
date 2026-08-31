import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { claimBrandwellSidekickInTransaction } from "./prisma-sidekicks.js";

const ACTIVE_BILLING_STATES = new Set(["active", "trialing"]);

export type BrandwellPlatformIdentity = {
  user: {
    id: string;
    agencyId: string;
    clientId: string;
    name: string;
    email: string;
  };
  access: {
    kind: "master" | "sidekick";
    brandwellCustomerId: string;
    workspaceId: string;
    sidekickId: string | null;
  };
};

export class BrandwellUserAccessError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "BrandwellUserAccessError";
  }
}

export async function bindBrandwellUserAccess(
  prisma: PrismaClient,
  identity: BrandwellPlatformIdentity,
  now = new Date(),
) {
  const brandwellUserId = requiredIdentity(identity.user.id, "BrandWell user id");
  const customerId = requiredIdentity(identity.access.brandwellCustomerId, "BrandWell customer id");
  const workspaceId = requiredIdentity(identity.access.workspaceId, "AIMEE workspace id");
  const email = normalizedEmail(identity.user.email);
  const name = identity.user.name.trim() || email.split("@")[0] || "BrandWell user";

  return prisma.$transaction(async (tx) => {
    const mapping = await tx.brandwellAiWorkspace.findFirst({
      where: {
        OR: [{ brandwellCustomerId: customerId }, { rakazoWorkspaceId: workspaceId }],
      },
    });
    if (
      !mapping ||
      mapping.brandwellCustomerId !== customerId ||
      mapping.rakazoWorkspaceId !== workspaceId
    ) {
      throw new BrandwellUserAccessError(
        "This BrandWell AIMEE workspace is not provisioned.",
        "aimee_workspace_not_provisioned",
        403,
      );
    }
    assertActiveBilling(mapping.commercialStatus, mapping.subscriptionStatus);

    const [byBrandwellId, byEmail] = await Promise.all([
      tx.user.findUnique({ where: { brandwellUserId } }),
      tx.user.findUnique({ where: { email } }),
    ]);
    if (byBrandwellId && byEmail && byBrandwellId.id !== byEmail.id) {
      throw new BrandwellUserAccessError(
        "This BrandWell identity conflicts with an existing AIMEE user.",
        "aimee_identity_conflict",
        409,
      );
    }
    const existing = byBrandwellId ?? byEmail;
    if (existing?.brandwellUserId && existing.brandwellUserId !== brandwellUserId) {
      throw new BrandwellUserAccessError(
        "This AIMEE user is already connected to another BrandWell identity.",
        "aimee_identity_conflict",
        409,
      );
    }
    const user = existing
      ? await tx.user.update({
          where: { id: existing.id },
          data: { brandwellUserId, email, name, emailVerified: true },
        })
      : await tx.user.create({
          data: {
            id: randomUUID(),
            brandwellUserId,
            email,
            name,
            emailVerified: true,
          },
        });

    if (identity.access.kind === "master") {
      if (mapping.primaryBrandwellUserId && mapping.primaryBrandwellUserId !== brandwellUserId) {
        throw new BrandwellUserAccessError(
          "AIMEE master access is assigned to another BrandWell user.",
          "aimee_master_user_mismatch",
          403,
        );
      }
      if (!mapping.primaryBrandwellUserId) {
        await tx.brandwellAiWorkspace.update({
          where: { id: mapping.id },
          data: { primaryBrandwellUserId: brandwellUserId },
        });
      }
      await ensureWorkspaceUser(tx, mapping.rakazoWorkspaceId, user.id, "owner", now);
    } else {
      if (!identity.access.sidekickId) {
        throw new BrandwellUserAccessError(
          "A paid AIMEE Sidekick seat is not assigned to this BrandWell user.",
          "aimee_sidekick_required",
          403,
        );
      }
      const sidekick = await tx.brandwellSidekick.findUnique({
        where: { brandwellSidekickId: identity.access.sidekickId },
      });
      if (
        !sidekick ||
        sidekick.aiWorkspaceId !== mapping.id ||
        !["invited", "active"].includes(sidekick.status) ||
        (sidekick.brandwellUserId && sidekick.brandwellUserId !== brandwellUserId) ||
        (sidekick.userId && sidekick.userId !== user.id)
      ) {
        throw new BrandwellUserAccessError(
          "A paid AIMEE Sidekick seat is not assigned to this BrandWell user.",
          "aimee_sidekick_required",
          403,
        );
      }
      await tx.brandwellSidekick.update({
        where: { id: sidekick.id },
        data: { brandwellUserId, email, name },
      });
      await ensureWorkspaceUser(tx, mapping.rakazoWorkspaceId, user.id, "member", now);
      if (!sidekick.userId) {
        const claimed = await claimBrandwellSidekickInTransaction(tx, {
          workspaceId: mapping.rakazoWorkspaceId,
          userId: user.id,
          brandwellUserId,
          email,
          now,
        });
        if (!claimed) {
          throw new BrandwellUserAccessError(
            "AIMEE could not activate this Sidekick seat.",
            "aimee_sidekick_activation_failed",
            409,
          );
        }
      }
    }

    await tx.invitation.updateMany({
      where: {
        organizationId: mapping.rakazoWorkspaceId,
        email,
        status: "pending",
      },
      data: { status: "accepted" },
    });
    await ensureUserWorkspaceRecords(tx, mapping.rakazoWorkspaceId, user.id);
    return user;
  });
}

export async function requireBrandwellUserAccess(prisma: PrismaClient, userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, brandwellUserId: true },
  });
  if (!user?.brandwellUserId) {
    throw new BrandwellUserAccessError(
      "Sign in with your BrandWell account to use AIMEE.",
      "aimee_brandwell_login_required",
      401,
    );
  }
  const [master, sidekick] = await Promise.all([
    prisma.brandwellAiWorkspace.findFirst({
      where: { primaryBrandwellUserId: user.brandwellUserId },
    }),
    prisma.brandwellSidekick.findFirst({
      where: {
        brandwellUserId: user.brandwellUserId,
        userId: user.id,
        status: "active",
      },
      include: { aiWorkspace: true },
    }),
  ]);
  const mapping = master ?? sidekick?.aiWorkspace;
  if (!mapping) {
    throw new BrandwellUserAccessError(
      "A paid AIMEE Sidekick seat is not assigned to this BrandWell user.",
      "aimee_sidekick_required",
      403,
    );
  }
  assertActiveBilling(mapping.commercialStatus, mapping.subscriptionStatus);
  const membership = await prisma.member.findUnique({
    where: {
      organizationId_userId: {
        organizationId: mapping.rakazoWorkspaceId,
        userId: user.id,
      },
    },
    select: { id: true },
  });
  if (!membership) {
    throw new BrandwellUserAccessError(
      "AIMEE access is not active for this BrandWell user.",
      "aimee_access_inactive",
      403,
    );
  }
  const settings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { ownerUserId: true },
  });
  return {
    userId: user.id,
    workspaceId: mapping.rakazoWorkspaceId,
    email: user.email,
    isDeploymentOwner: settings?.ownerUserId === user.id,
  };
}

function assertActiveBilling(commercialStatus: string, subscriptionStatus: string) {
  if (commercialStatus === "past_due" || subscriptionStatus === "past_due") {
    throw new BrandwellUserAccessError(
      "The last BrandWell invoice failed. Ask your BrandWell account administrator to pay the past-due invoice to restore access.",
      "aimee_billing_past_due",
      402,
    );
  }
  if (
    !ACTIVE_BILLING_STATES.has(commercialStatus) ||
    !ACTIVE_BILLING_STATES.has(subscriptionStatus)
  ) {
    throw new BrandwellUserAccessError(
      "This BrandWell account does not have an active AIMEE billing plan.",
      "aimee_service_inactive",
      403,
    );
  }
}

async function ensureWorkspaceUser(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  userId: string,
  role: "owner" | "member",
  now: Date,
) {
  await tx.member.upsert({
    where: { organizationId_userId: { organizationId: workspaceId, userId } },
    create: { id: randomUUID(), organizationId: workspaceId, userId, role, createdAt: now },
    update: { role },
  });
}

async function ensureUserWorkspaceRecords(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  userId: string,
) {
  const memory = await tx.memoryDocument.findFirst({
    where: { workspaceId, userId, scope: "user", botId: null, path: "MEMORY.md" },
    select: { id: true },
  });
  if (!memory) {
    await tx.memoryDocument.create({
      data: {
        workspaceId,
        userId,
        scope: "user",
        path: "MEMORY.md",
        content: "# User memory\n\nAccount-wide preferences live here.\n",
      },
    });
  }
  await tx.notificationPreference.upsert({
    where: { workspaceId_userId: { workspaceId, userId } },
    create: { workspaceId, userId },
    update: {},
  });
}

function requiredIdentity(value: string, label: string) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 200) {
    throw new BrandwellUserAccessError(`${label} is invalid.`, "aimee_identity_invalid", 400);
  }
  return normalized;
}

function normalizedEmail(value: string) {
  const email = String(value || "")
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new BrandwellUserAccessError(
      "The BrandWell account email is invalid.",
      "aimee_identity_invalid",
      400,
    );
  }
  return email;
}
