import { randomUUID } from "node:crypto";
import {
  createThreadMessageInTransaction,
  ensureComputerRecord,
  type Prisma,
  type PrismaClient,
} from "@rakazo/db";
import {
  BRANDWELL_AIMEE_DEFAULT_ROUTINES,
  BRANDWELL_AIMEE_INSTRUCTIONS,
  BRANDWELL_AIMEE_SKILL_BUNDLE_VERSION,
} from "./aimee-baseline.js";
import { BRANDWELL_BRAND } from "./brand-config.js";
import { installBrandwellSkillBundle } from "./prisma-skills.js";

const ACTIVE_COMMERCIAL_STATES = new Set(["trialing", "active"]);
const COUNTED_SIDEKICK_STATES = ["provisioning", "invited", "active", "paused"];

export class BrandwellSidekickError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "BrandwellSidekickError";
  }
}

export type BrandwellWorkspaceDesiredStateInput = {
  revision: bigint;
  agencyId: string;
  clientId: string;
  contractId?: string | null;
  status: "trialing" | "active" | "past_due" | "paused" | "canceling" | "canceled";
  plan: string;
  masterSeats: 1;
  sidekickSeats: number;
  skillBundleVersion: number;
};

export type BrandwellSidekickProvisioningInput = {
  brandwellSidekickId: string;
  email: string;
  name: string;
  roleTitle: string;
  timezone: string;
};

export type PrismaBrandwellSidekickOptions = {
  prisma: PrismaClient;
  systemUserId?: string;
  sandboxKind: string;
  defaultModel: string;
  now?: () => Date;
  createId?: () => string;
};

export async function syncBrandwellWorkspaceDesiredStateWithPrisma(
  workspaceReference: string,
  input: BrandwellWorkspaceDesiredStateInput,
  prisma: PrismaClient,
) {
  const mapping = await findMapping(prisma, workspaceReference);
  if (!mapping) {
    throw new BrandwellSidekickError("BrandWell workspace not found", "workspace_not_found", 404);
  }
  if (
    input.masterSeats !== 1 ||
    !Number.isSafeInteger(input.sidekickSeats) ||
    input.sidekickSeats < 0
  ) {
    throw new BrandwellSidekickError(
      "The AIMEE entitlement seat counts are invalid",
      "invalid_entitlement",
      400,
    );
  }
  if (input.skillBundleVersion !== BRANDWELL_AIMEE_SKILL_BUNDLE_VERSION) {
    throw new BrandwellSidekickError(
      `AIMEE skill bundle ${input.skillBundleVersion} is not available in this release`,
      "skill_bundle_unavailable",
      409,
    );
  }
  if (input.revision < mapping.commercialRevision) {
    throw new BrandwellSidekickError(
      "The commercial desired state is older than the applied revision",
      "stale_commercial_revision",
      409,
    );
  }
  if (input.revision === mapping.commercialRevision) {
    return { mapping, replayed: true };
  }
  const counted = await prisma.brandwellSidekick.count({
    where: { aiWorkspaceId: mapping.id, status: { in: COUNTED_SIDEKICK_STATES } },
  });
  if (input.sidekickSeats < counted) {
    throw new BrandwellSidekickError(
      "Cancel excess Sidekicks before reducing the licensed seat count",
      "sidekick_seats_in_use",
      409,
    );
  }

  const inferenceEnabled = ACTIVE_COMMERCIAL_STATES.has(input.status);
  const updated = await prisma.$transaction(async (tx) => {
    const changed = await tx.brandwellAiWorkspace.updateMany({
      where: { id: mapping.id, commercialRevision: { lt: input.revision } },
      data: {
        brandwellAgencyId: input.agencyId,
        brandwellClientId: input.clientId,
        brandwellContractId: input.contractId ?? null,
        commercialRevision: input.revision,
        commercialStatus: input.status,
        subscriptionStatus: inferenceEnabled ? "active" : input.status,
        plan: input.plan,
        masterSeats: 1,
        sidekickSeats: input.sidekickSeats,
        skillBundleVersion: input.skillBundleVersion,
      },
    });
    if (!changed.count) {
      throw new BrandwellSidekickError(
        "A newer commercial revision was applied concurrently",
        "stale_commercial_revision",
        409,
      );
    }
    if (!inferenceEnabled) {
      await tx.bot.updateMany({
        where: { workspaceId: mapping.rakazoWorkspaceId, managedByBrandWell: true },
        data: { managedStatus: "paused" },
      });
      await tx.routine.updateMany({
        where: { workspaceId: mapping.rakazoWorkspaceId },
        data: { active: false },
      });
      await tx.brandwellWorkspaceModelCredential.updateMany({
        where: { workspaceId: mapping.rakazoWorkspaceId },
        data: { status: "disabled", disabledAt: new Date() },
      });
    } else if (mapping.commercialStatus === "paused" || mapping.commercialStatus === "past_due") {
      await tx.bot.updateMany({
        where: {
          workspaceId: mapping.rakazoWorkspaceId,
          managedByBrandWell: true,
          archivedAt: null,
        },
        data: { managedStatus: "active" },
      });
      await tx.brandwellWorkspaceModelCredential.updateMany({
        where: { workspaceId: mapping.rakazoWorkspaceId },
        data: { status: "active", disabledAt: null },
      });
    }
    return tx.brandwellAiWorkspace.findUniqueOrThrow({ where: { id: mapping.id } });
  });
  return { mapping: updated, replayed: false };
}

export async function provisionBrandwellSidekickWithPrisma(
  workspaceReference: string,
  input: BrandwellSidekickProvisioningInput,
  options: PrismaBrandwellSidekickOptions,
) {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  const email = input.email.trim().toLowerCase();
  const mapping = await findMapping(options.prisma, workspaceReference);
  if (!mapping) {
    throw new BrandwellSidekickError("BrandWell workspace not found", "workspace_not_found", 404);
  }
  const existing = await options.prisma.brandwellSidekick.findUnique({
    where: { brandwellSidekickId: input.brandwellSidekickId },
    include: { bot: true, computer: true },
  });
  if (existing) {
    if (existing.email !== email || existing.aiWorkspaceId !== mapping.id) {
      throw new BrandwellSidekickError(
        "The Sidekick idempotency identity is already assigned",
        "sidekick_identity_conflict",
        409,
      );
    }
    return sidekickResult(existing, true);
  }
  if (!ACTIVE_COMMERCIAL_STATES.has(mapping.commercialStatus)) {
    throw new BrandwellSidekickError(
      "The client does not have an active AIMEE entitlement",
      "entitlement_inactive",
      409,
    );
  }
  if (!mapping.primaryBotId || !mapping.serviceIdentityId) {
    throw new BrandwellSidekickError(
      "Provision the primary AIMEE employee before adding Sidekicks",
      "primary_aimee_unavailable",
      409,
    );
  }
  const systemUserId = await requireSystemUserId(options.prisma, options.systemUserId);
  const existingUser = await options.prisma.user.findUnique({ where: { email } });
  const ownerUserId = existingUser?.id ?? systemUserId;
  const preferredModel =
    (
      await options.prisma.brandwellWorkspaceModelCredential.findUnique({
        where: { workspaceId: mapping.rakazoWorkspaceId },
        select: { preferredModel: true },
      })
    )?.preferredModel ?? options.defaultModel;

  const provisioned = await options.prisma.$transaction(async (tx) => {
    await tx.brandwellAiWorkspace.update({ where: { id: mapping.id }, data: { updatedAt: now() } });
    const lockedMapping = await tx.brandwellAiWorkspace.findUniqueOrThrow({
      where: { id: mapping.id },
    });
    if (!ACTIVE_COMMERCIAL_STATES.has(lockedMapping.commercialStatus)) {
      throw new BrandwellSidekickError(
        "The client does not have an active AIMEE entitlement",
        "entitlement_inactive",
        409,
      );
    }
    const replay = await tx.brandwellSidekick.findUnique({
      where: { brandwellSidekickId: input.brandwellSidekickId },
      include: { bot: true, computer: true },
    });
    if (replay) {
      if (replay.email !== email || replay.aiWorkspaceId !== mapping.id) {
        throw new BrandwellSidekickError(
          "The Sidekick idempotency identity is already assigned",
          "sidekick_identity_conflict",
          409,
        );
      }
      return { sidekick: replay, replayed: true };
    }
    const duplicate = await tx.brandwellSidekick.findFirst({
      where: { aiWorkspaceId: mapping.id, email },
    });
    if (duplicate) {
      throw new BrandwellSidekickError(
        "This teammate already has a Sidekick in the client workspace",
        "sidekick_email_conflict",
        409,
      );
    }
    const allocated = await tx.brandwellSidekick.count({
      where: { aiWorkspaceId: mapping.id, status: { in: COUNTED_SIDEKICK_STATES } },
    });
    if (allocated >= lockedMapping.sidekickSeats) {
      throw new BrandwellSidekickError(
        "All licensed Sidekick seats are allocated",
        "sidekick_seat_limit_reached",
        409,
      );
    }

    let invitationId: string | null = null;
    if (existingUser) {
      await tx.member.upsert({
        where: {
          organizationId_userId: {
            organizationId: mapping.rakazoWorkspaceId,
            userId: existingUser.id,
          },
        },
        create: {
          id: createId(),
          organizationId: mapping.rakazoWorkspaceId,
          userId: existingUser.id,
          role: "member",
          createdAt: now(),
        },
        update: {},
      });
    } else {
      const invitation =
        (await tx.invitation.findFirst({
          where: {
            organizationId: mapping.rakazoWorkspaceId,
            email,
            status: "pending",
          },
          orderBy: { expiresAt: "desc" },
        })) ??
        (await tx.invitation.create({
          data: {
            id: createId(),
            organizationId: mapping.rakazoWorkspaceId,
            email,
            role: "member",
            status: "pending",
            expiresAt: new Date(now().getTime() + 7 * 86_400_000),
            inviterId: systemUserId,
          },
        }));
      invitationId = invitation.id;
    }

    const bot = await tx.bot.create({
      data: {
        workspaceId: mapping.rakazoWorkspaceId,
        userId: ownerUserId,
        createdByUserId: systemUserId,
        ownerType: "user",
        visibility: "private",
        managedByBrandWell: true,
        managedStatus: existingUser ? "active" : "pending_access",
        serviceIdentityId: mapping.serviceIdentityId,
        parentBotId: mapping.primaryBotId,
        spawnKey: `brandwell:sidekick:${input.brandwellSidekickId}`,
        name: `${input.name}'s AIMEE`,
        title: `${input.roleTitle} Sidekick`,
        description: `A private BrandWell AI Sidekick configured for ${input.name}.`,
        instructions: `${BRANDWELL_AIMEE_INSTRUCTIONS}\n\nYou are the private Sidekick for ${input.name}, whose role is ${input.roleTitle}. Keep their work, browser sessions, files, and personal preferences private to their user access. Use shared client workspace signals and BrandWell service connections only for authorized client work.`,
        color: BRANDWELL_BRAND.colors.primary,
        notifyOnFinish: true,
        pinned: true,
        modelProvider: "openrouter",
        modelId: preferredModel,
      },
    });
    const thread = await tx.thread.create({
      data: { workspaceId: mapping.rakazoWorkspaceId, botId: bot.id, userId: ownerUserId },
    });
    await createThreadMessageInTransaction(tx, {
      threadId: thread.id,
      role: "bot",
      botId: bot.id,
      blocks: [
        {
          kind: "text",
          text: `Hi ${input.name}, I'm your private AIMEE Sidekick. I have my own secure computer and can help with your ${input.roleTitle} work using the BrandWell tools available to this client workspace.`,
        },
      ],
    });
    await tx.browserProfile.create({
      data: { workspaceId: mapping.rakazoWorkspaceId, botId: bot.id, userId: ownerUserId },
    });
    await tx.memoryDocument.create({
      data: {
        workspaceId: mapping.rakazoWorkspaceId,
        userId: ownerUserId,
        botId: bot.id,
        scope: "bot",
        path: "MEMORY.md",
        content: `# ${input.name}'s AIMEE Sidekick\n\n`,
      },
    });
    const computer = await ensureComputerRecord(tx, {
      mode: "dedicated",
      workspaceId: mapping.rakazoWorkspaceId,
      userId: ownerUserId,
      botId: bot.id,
      kind: options.sandboxKind,
    });
    await tx.bot.update({ where: { id: bot.id }, data: { computerId: computer.id } });
    for (const template of BRANDWELL_AIMEE_DEFAULT_ROUTINES) {
      await tx.routine.create({
        data: {
          workspaceId: mapping.rakazoWorkspaceId,
          botId: bot.id,
          userId: ownerUserId,
          serviceIdentityId: mapping.serviceIdentityId,
          name: template.name,
          prompt: template.prompt,
          crons: [template.cron],
          timezone: input.timezone,
          active: false,
          notify: true,
        },
      });
    }
    await installBrandwellSkillBundle(tx, {
      workspaceId: mapping.rakazoWorkspaceId,
      userId: ownerUserId,
    });
    if (existingUser) {
      await tx.notificationPreference.upsert({
        where: {
          workspaceId_userId: {
            workspaceId: mapping.rakazoWorkspaceId,
            userId: existingUser.id,
          },
        },
        create: { workspaceId: mapping.rakazoWorkspaceId, userId: existingUser.id },
        update: {},
      });
    }
    const created = await tx.brandwellSidekick.create({
      data: {
        brandwellSidekickId: input.brandwellSidekickId,
        aiWorkspaceId: mapping.id,
        workspaceId: mapping.rakazoWorkspaceId,
        email,
        name: input.name,
        roleTitle: input.roleTitle,
        status: existingUser ? "active" : "invited",
        userId: existingUser?.id ?? null,
        botId: bot.id,
        computerId: computer.id,
        invitationId,
        skillBundleVersion: BRANDWELL_AIMEE_SKILL_BUNDLE_VERSION,
        commercialRevision: mapping.commercialRevision,
        activatedAt: existingUser ? now() : null,
      },
      include: { bot: true, computer: true },
    });
    return { sidekick: created, replayed: false };
  });
  return sidekickResult(provisioned.sidekick, provisioned.replayed);
}

export async function claimBrandwellSidekickInTransaction(
  tx: Prisma.TransactionClient,
  input: { workspaceId: string; userId: string; email: string; now: Date },
) {
  const sidekick = await tx.brandwellSidekick.findFirst({
    where: {
      workspaceId: input.workspaceId,
      email: input.email.trim().toLowerCase(),
      userId: null,
      status: "invited",
    },
    orderBy: { createdAt: "asc" },
  });
  if (!sidekick?.botId || !sidekick.computerId) return null;
  await Promise.all([
    tx.bot.update({
      where: { id: sidekick.botId },
      data: { userId: input.userId, managedStatus: "active" },
    }),
    tx.thread.updateMany({ where: { botId: sidekick.botId }, data: { userId: input.userId } }),
    tx.computer.update({ where: { id: sidekick.computerId }, data: { userId: input.userId } }),
    tx.browserProfile.updateMany({
      where: { botId: sidekick.botId },
      data: { userId: input.userId },
    }),
    tx.memoryDocument.updateMany({
      where: { botId: sidekick.botId },
      data: { userId: input.userId },
    }),
    tx.routine.updateMany({ where: { botId: sidekick.botId }, data: { userId: input.userId } }),
    tx.scratchpadItem.updateMany({
      where: { botId: sidekick.botId },
      data: { userId: input.userId },
    }),
    tx.taughtSkill.updateMany({ where: { botId: sidekick.botId }, data: { userId: input.userId } }),
    tx.agentHome.updateMany({ where: { botId: sidekick.botId }, data: { userId: input.userId } }),
  ]);
  await installBrandwellSkillBundle(tx, { workspaceId: input.workspaceId, userId: input.userId });
  return tx.brandwellSidekick.update({
    where: { id: sidekick.id },
    data: { userId: input.userId, status: "active", activatedAt: input.now },
  });
}

export async function setBrandwellSidekickLifecycleWithPrisma(
  sidekickReference: string,
  action: "pause" | "resume" | "cancel",
  prisma: PrismaClient,
) {
  const sidekick = await prisma.brandwellSidekick.findFirst({
    where: { OR: [{ id: sidekickReference }, { brandwellSidekickId: sidekickReference }] },
  });
  if (!sidekick?.botId) {
    throw new BrandwellSidekickError("Sidekick not found", "sidekick_not_found", 404);
  }
  if (action === "resume" && !sidekick.userId) {
    throw new BrandwellSidekickError(
      "The teammate must accept access before this Sidekick can resume",
      "sidekick_access_pending",
      409,
    );
  }
  const at = new Date();
  const status = action === "cancel" ? "canceled" : action === "pause" ? "paused" : "active";
  await prisma.$transaction([
    prisma.brandwellSidekick.update({
      where: { id: sidekick.id },
      data: {
        status,
        pausedAt: action === "pause" ? at : action === "resume" ? null : sidekick.pausedAt,
        canceledAt: action === "cancel" ? at : null,
      },
    }),
    prisma.bot.update({
      where: { id: sidekick.botId },
      data: {
        managedStatus: action === "resume" ? "active" : action === "cancel" ? "canceled" : "paused",
        archivedAt: action === "cancel" ? at : null,
      },
    }),
    prisma.routine.updateMany({ where: { botId: sidekick.botId }, data: { active: false } }),
    ...(sidekick.computerId
      ? [
          prisma.computer.update({
            where: { id: sidekick.computerId },
            data: action === "resume" ? {} : { state: "stopped" },
          }),
        ]
      : []),
  ]);
  return {
    sidekickId: sidekick.id,
    status,
    botId: sidekick.botId,
    computerId: sidekick.computerId,
  };
}

export async function rolloutBrandwellSkillBundleWithPrisma(
  workspaceReference: string,
  prisma: PrismaClient,
) {
  const mapping = await findMapping(prisma, workspaceReference);
  if (!mapping) {
    throw new BrandwellSidekickError("BrandWell workspace not found", "workspace_not_found", 404);
  }
  const users = await prisma.bot.findMany({
    where: { workspaceId: mapping.rakazoWorkspaceId, managedByBrandWell: true, archivedAt: null },
    select: { userId: true },
    distinct: ["userId"],
  });
  const installed = [];
  for (const { userId } of users) {
    installed.push(
      await installBrandwellSkillBundle(prisma, {
        workspaceId: mapping.rakazoWorkspaceId,
        userId,
      }),
    );
  }
  await prisma.$transaction([
    prisma.brandwellAiWorkspace.update({
      where: { id: mapping.id },
      data: { skillBundleVersion: BRANDWELL_AIMEE_SKILL_BUNDLE_VERSION },
    }),
    prisma.brandwellSidekick.updateMany({
      where: { aiWorkspaceId: mapping.id, status: { not: "canceled" } },
      data: { skillBundleVersion: BRANDWELL_AIMEE_SKILL_BUNDLE_VERSION },
    }),
  ]);
  return {
    version: BRANDWELL_AIMEE_SKILL_BUNDLE_VERSION,
    users: users.length,
    skills: installed.reduce((sum, item) => sum + item.skillIds.length, 0),
  };
}

async function findMapping(prisma: PrismaClient, reference: string) {
  return prisma.brandwellAiWorkspace.findFirst({
    where: {
      OR: [{ id: reference }, { brandwellCustomerId: reference }, { rakazoWorkspaceId: reference }],
    },
  });
}

async function requireSystemUserId(prisma: PrismaClient, configured?: string) {
  if (configured?.trim()) {
    const user = await prisma.user.findUnique({ where: { id: configured.trim() } });
    if (user) return user.id;
  }
  const settings = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
  if (!settings?.ownerUserId) {
    throw new BrandwellSidekickError(
      "BrandWell Sidekick provisioning requires a system user",
      "system_user_unavailable",
      503,
    );
  }
  return settings.ownerUserId;
}

function sidekickResult(
  sidekick: {
    id: string;
    brandwellSidekickId: string;
    workspaceId: string;
    email: string;
    name: string;
    roleTitle: string;
    status: string;
    userId: string | null;
    botId: string | null;
    computerId: string | null;
    invitationId: string | null;
    skillBundleVersion: number;
  },
  replayed: boolean,
) {
  return {
    id: sidekick.id,
    brandwellSidekickId: sidekick.brandwellSidekickId,
    workspaceId: sidekick.workspaceId,
    email: sidekick.email,
    name: sidekick.name,
    roleTitle: sidekick.roleTitle,
    status: sidekick.status,
    userId: sidekick.userId,
    botId: sidekick.botId,
    computerId: sidekick.computerId,
    skillBundleVersion: sidekick.skillBundleVersion,
    clientAccess: sidekick.userId
      ? { kind: "member", resourceId: sidekick.userId }
      : { kind: "invitation", resourceId: sidekick.invitationId },
    replayed,
  };
}
