import { randomUUID } from "node:crypto";
import { nextCronDateAcrossStrict } from "@rakazo/core";
import {
  createThreadMessageInTransaction,
  ensureComputerRecord,
  type Prisma,
  type PrismaClient,
  withTransactionRetry,
} from "@rakazo/db";
import {
  BRANDWELL_AIMEE_DEFAULT_ROUTINES,
  BRANDWELL_AIMEE_INSTRUCTIONS,
  BRANDWELL_AIMEE_MIN_SKILL_BUNDLE_VERSION,
  BRANDWELL_AIMEE_SKILL_BUNDLE_VERSION,
} from "./aimee-baseline.js";
import { BRANDWELL_BRAND } from "./brand-config.js";
import { brandwellSidekickOpenRouterKeyLabel } from "./openrouter-key-labels.js";
import {
  managedMonthlyOpenRouterKeyPolicy,
  microsToUsd,
  type OpenRouterManagementClient,
} from "./openrouter-management.js";
import { acquireBrandwellModelPolicyLease } from "./prisma-model-policy-lease.js";
import type { BrandwellSecretCipher } from "./prisma-provisioning.js";
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

export function sidekickBudgetFromMaster(policy: {
  monthlyLimitMicros: bigint;
  dailyLimitMicros: bigint | null;
  warningLimitMicros: bigint;
}) {
  if (
    policy.monthlyLimitMicros <= 0n ||
    policy.monthlyLimitMicros > 200_000_000n ||
    policy.warningLimitMicros > policy.monthlyLimitMicros ||
    (policy.dailyLimitMicros !== null && policy.dailyLimitMicros > policy.monthlyLimitMicros)
  ) {
    throw new BrandwellSidekickError(
      "The primary AIMEE model budget must be reconciled before adding Sidekicks",
      "primary_aimee_budget_invalid",
      409,
    );
  }
  return {
    monthlyLimitMicros: policy.monthlyLimitMicros,
    dailyLimitMicros: policy.dailyLimitMicros,
    warningLimitMicros: policy.warningLimitMicros,
  };
}

export type BrandwellWorkspaceDesiredStateInput = {
  revision: bigint;
  agencyId: string;
  clientId: string;
  contractId?: string | null;
  primaryBrandwellUserId: string;
  status: "trialing" | "active" | "past_due" | "paused" | "canceling" | "canceled";
  plan: string;
  masterSeats: 1;
  sidekickSeats: number;
  skillBundleVersion: number;
};

export type BrandwellSidekickProvisioningInput = {
  brandwellSidekickId: string;
  brandwellUserId: string;
  email: string;
  name: string;
  roleTitle: string;
  timezone: string;
};

export type PrismaBrandwellSidekickOptions = {
  prisma: PrismaClient;
  secretCipher: BrandwellSecretCipher;
  openRouter: Pick<OpenRouterManagementClient, "createKey" | "deleteKey">;
  systemUserId?: string;
  sandboxKind: string;
  defaultModel: string;
  monthlyLimitMicros: bigint;
  warningLimitMicros: bigint;
  dailyLimitMicros?: bigint;
  now?: () => Date;
  createId?: () => string;
};

export type PrismaBrandwellSidekickLifecycleOptions = {
  prisma: PrismaClient;
  openRouter: Pick<OpenRouterManagementClient, "updateKey" | "deleteKey">;
  idempotencyKey: string;
  computerLifecycle: {
    fence(
      tx: Prisma.TransactionClient,
      input: {
        operationId: string;
        action: "pause" | "cancel";
        computerId: string;
        botId: string;
        workspaceId: string;
        userId: string;
      },
    ): Promise<void>;
    stop(input: {
      operationId: string;
      action: "pause" | "cancel";
      computerId: string;
      botId: string;
      workspaceId: string;
      userId: string;
      checkpointRequired: boolean;
      markCheckpointed(): Promise<void>;
    }): Promise<void>;
  };
  auditMetadata?: Prisma.InputJsonObject;
  now?: () => Date;
  createId?: () => string;
};

export async function syncBrandwellWorkspaceDesiredStateWithPrisma(
  workspaceReference: string,
  input: BrandwellWorkspaceDesiredStateInput,
  prisma: PrismaClient,
  openRouter?: Pick<OpenRouterManagementClient, "updateKey">,
) {
  const initialMapping = await findMapping(prisma, workspaceReference);
  if (!initialMapping) {
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
  if (
    input.skillBundleVersion < BRANDWELL_AIMEE_MIN_SKILL_BUNDLE_VERSION ||
    input.skillBundleVersion > BRANDWELL_AIMEE_SKILL_BUNDLE_VERSION
  ) {
    throw new BrandwellSidekickError(
      `AIMEE skill bundle ${input.skillBundleVersion} is not available in this release`,
      "skill_bundle_unavailable",
      409,
    );
  }
  const policyLease = await acquireBrandwellModelPolicyLease(
    prisma,
    initialMapping.id,
    "workspace-desired-state",
  );
  if (!policyLease) {
    throw new BrandwellSidekickError(
      "Another model policy or Sidekick change is already in progress",
      "model_policy_busy",
      409,
    );
  }
  try {
    const mapping = await findMapping(prisma, workspaceReference);
    if (!mapping) {
      throw new BrandwellSidekickError("BrandWell workspace not found", "workspace_not_found", 404);
    }
    if (input.revision < mapping.commercialRevision) {
      throw new BrandwellSidekickError(
        "The commercial desired state is older than the applied revision",
        "stale_commercial_revision",
        409,
      );
    }
    const shouldRolloutSkillBundle =
      input.skillBundleVersion === BRANDWELL_AIMEE_SKILL_BUNDLE_VERSION &&
      Number(mapping.skillBundleVersion ?? 1) < BRANDWELL_AIMEE_SKILL_BUNDLE_VERSION;
    if (shouldRolloutSkillBundle) {
      await policyLease.renew();
      await rolloutBrandwellSkillBundleWithPrisma(workspaceReference, prisma);
      await policyLease.renew();
    }
    if (input.revision === mapping.commercialRevision) {
      const currentMapping = shouldRolloutSkillBundle
        ? await findMapping(prisma, workspaceReference)
        : mapping;
      return { mapping: currentMapping ?? mapping, replayed: !shouldRolloutSkillBundle };
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
    const shouldEnableProviderKeys =
      inferenceEnabled && ["paused", "past_due"].includes(mapping.commercialStatus);
    if (openRouter && (!inferenceEnabled || shouldEnableProviderKeys)) {
      const activeSidekickIds = inferenceEnabled
        ? (
            await prisma.brandwellSidekick.findMany({
              where: { workspaceId: mapping.rakazoWorkspaceId, status: "active" },
              select: { id: true },
            })
          ).map((sidekick) => sidekick.id)
        : [];
      const [masterCredential, sidekickCredentials] = await Promise.all([
        prisma.brandwellWorkspaceModelCredential.findUnique({
          where: { workspaceId: mapping.rakazoWorkspaceId },
          select: { externalKeyHash: true },
        }),
        prisma.brandwellSidekickModelCredential.findMany({
          where: {
            workspaceId: mapping.rakazoWorkspaceId,
            ...(inferenceEnabled ? { sidekickId: { in: activeSidekickIds } } : {}),
          },
          select: { externalKeyHash: true },
        }),
      ]);
      for (const credential of [masterCredential, ...sidekickCredentials]) {
        if (credential?.externalKeyHash) {
          await policyLease.renew();
          await openRouter.updateKey(credential.externalKeyHash, { disabled: !inferenceEnabled });
        }
      }
    }
    await policyLease.renew();
    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.brandwellAiWorkspace.updateMany({
        where: { id: mapping.id, commercialRevision: { lt: input.revision } },
        data: {
          brandwellAgencyId: input.agencyId,
          brandwellClientId: input.clientId,
          brandwellContractId: input.contractId ?? null,
          primaryBrandwellUserId: input.primaryBrandwellUserId,
          commercialRevision: input.revision,
          commercialStatus: input.status,
          subscriptionStatus: inferenceEnabled ? "active" : input.status,
          plan: input.plan,
          masterSeats: 1,
          sidekickSeats: input.sidekickSeats,
          skillBundleVersion: BRANDWELL_AIMEE_SKILL_BUNDLE_VERSION,
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
        await tx.brandwellSidekickModelCredential.updateMany({
          where: { workspaceId: mapping.rakazoWorkspaceId },
          data: { status: "disabled", disabledAt: new Date() },
        });
      } else if (mapping.commercialStatus === "paused" || mapping.commercialStatus === "past_due") {
        const activeSidekicks = await tx.brandwellSidekick.findMany({
          where: { workspaceId: mapping.rakazoWorkspaceId, status: "active" },
          select: { id: true, botId: true },
        });
        const activeBotIds = [
          mapping.primaryBotId,
          ...activeSidekicks.map(({ botId }) => botId),
        ].filter((botId): botId is string => Boolean(botId));
        await tx.bot.updateMany({
          where: {
            id: { in: activeBotIds },
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
        await tx.brandwellSidekickModelCredential.updateMany({
          where: { sidekickId: { in: activeSidekicks.map(({ id }) => id) } },
          data: { status: "active", disabledAt: null },
        });
      }
      return tx.brandwellAiWorkspace.findUniqueOrThrow({ where: { id: mapping.id } });
    });
    return { mapping: updated, replayed: false };
  } finally {
    await policyLease.release().catch(() => undefined);
  }
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
  const policyLease = await acquireBrandwellModelPolicyLease(
    options.prisma,
    mapping.id,
    "sidekick-provision",
    now,
  );
  if (!policyLease) {
    throw new BrandwellSidekickError(
      "Another model policy or Sidekick change is already in progress",
      "model_policy_busy",
      409,
    );
  }
  try {
    const existing = await options.prisma.brandwellSidekick.findUnique({
      where: { brandwellSidekickId: input.brandwellSidekickId },
      include: { bot: true, computer: true, modelCredential: true },
    });
    if (existing) {
      if (
        existing.email !== email ||
        existing.aiWorkspaceId !== mapping.id ||
        (existing.brandwellUserId && existing.brandwellUserId !== input.brandwellUserId)
      ) {
        throw new BrandwellSidekickError(
          "The Sidekick idempotency identity is already assigned",
          "sidekick_identity_conflict",
          409,
        );
      }
      if (existing.status === "canceled") {
        throw new BrandwellSidekickError(
          "A canceled Sidekick cannot be reprovisioned with the same identity",
          "sidekick_canceled",
          409,
        );
      }
      if (existing.modelCredential) return sidekickResult(existing, true);
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
    const [organization, masterCredential] = await Promise.all([
      options.prisma.organization.findUnique({
        where: { id: mapping.rakazoWorkspaceId },
        select: { name: true },
      }),
      options.prisma.brandwellWorkspaceModelCredential.findUnique({
        where: { workspaceId: mapping.rakazoWorkspaceId },
      }),
    ]);
    if (!organization?.name || !masterCredential) {
      throw new BrandwellSidekickError(
        "The primary AIMEE model credential is unavailable",
        "primary_aimee_credential_unavailable",
        409,
      );
    }
    const modelPolicy = masterCredential;
    if (!existing) {
      const [duplicate, allocated] = await Promise.all([
        options.prisma.brandwellSidekick.findFirst({
          where: {
            aiWorkspaceId: mapping.id,
            OR: [{ email }, { brandwellUserId: input.brandwellUserId }],
          },
        }),
        options.prisma.brandwellSidekick.count({
          where: { aiWorkspaceId: mapping.id, status: { in: COUNTED_SIDEKICK_STATES } },
        }),
      ]);
      if (duplicate) {
        throw new BrandwellSidekickError(
          "This teammate already has a Sidekick in the client workspace",
          "sidekick_email_conflict",
          409,
        );
      }
      if (allocated >= mapping.sidekickSeats) {
        throw new BrandwellSidekickError(
          "All licensed Sidekick seats are allocated",
          "sidekick_seat_limit_reached",
          409,
        );
      }
    }
    const preferredModel = modelPolicy.preferredModel || options.defaultModel;
    const modelBudget = sidekickBudgetFromMaster(modelPolicy);
    await policyLease.renew();
    const createdKey = await options.openRouter.createKey({
      name: brandwellSidekickOpenRouterKeyLabel(organization.name, email),
      limitUsd: microsToUsd(modelBudget.monthlyLimitMicros),
      limitReset: "monthly",
    });
    let ciphertext: string;
    try {
      ciphertext = await options.secretCipher.encrypt(createdKey.key, {
        workspaceId: mapping.rakazoWorkspaceId,
        userId: systemUserId,
      });
    } catch (error) {
      await options.openRouter.deleteKey(createdKey.hash).catch(() => undefined);
      throw error;
    }

    async function createModelCredential(tx: Prisma.TransactionClient, sidekickId: string) {
      const secret = await tx.secret.create({
        data: {
          userId: systemUserId,
          workspaceId: mapping!.rakazoWorkspaceId,
          ownerType: "service",
          serviceIdentityId: mapping!.serviceIdentityId!,
          kind: "model:openrouter:sidekick",
          ciphertext,
        },
      });
      return tx.brandwellSidekickModelCredential.create({
        data: {
          sidekickId,
          workspaceId: mapping!.rakazoWorkspaceId,
          serviceIdentityId: mapping!.serviceIdentityId!,
          provider: "openrouter",
          secretId: secret.id,
          externalKeyHash: createdKey.hash,
          externalWorkspaceId: createdKey.workspaceId,
          ...managedMonthlyOpenRouterKeyPolicy(createdKey),
          status: "active",
          monthlyLimitMicros: modelBudget.monthlyLimitMicros,
          dailyLimitMicros: modelBudget.dailyLimitMicros,
          warningLimitMicros: modelBudget.warningLimitMicros,
          preferredModel,
          computerModel: modelPolicy.computerModel,
          lightweightModel: modelPolicy.lightweightModel,
          reasoningModel: modelPolicy.reasoningModel,
          fallbackModels: Array.isArray(modelPolicy.fallbackModels)
            ? modelPolicy.fallbackModels.filter(
                (item): item is string => typeof item === "string" && item.length > 0,
              )
            : [],
          modelCatalog:
            modelPolicy.modelCatalog &&
            typeof modelPolicy.modelCatalog === "object" &&
            !Array.isArray(modelPolicy.modelCatalog)
              ? (modelPolicy.modelCatalog as Prisma.InputJsonObject)
              : {},
          maxTokens: modelPolicy.maxTokens,
          thinkingLevel: modelPolicy.thinkingLevel,
        },
      });
    }

    await policyLease.renew();
    const provisioned = await options.prisma
      .$transaction(async (tx) => {
        await tx.brandwellAiWorkspace.update({
          where: { id: mapping.id },
          data: { updatedAt: now() },
        });
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
          include: { bot: true, computer: true, modelCredential: true },
        });
        if (replay) {
          if (
            replay.email !== email ||
            replay.aiWorkspaceId !== mapping.id ||
            (replay.brandwellUserId && replay.brandwellUserId !== input.brandwellUserId)
          ) {
            throw new BrandwellSidekickError(
              "The Sidekick idempotency identity is already assigned",
              "sidekick_identity_conflict",
              409,
            );
          }
          if (!replay.modelCredential) await createModelCredential(tx, replay.id);
          return { sidekick: replay, replayed: true, credentialCreated: !replay.modelCredential };
        }
        const duplicate = await tx.brandwellSidekick.findFirst({
          where: {
            aiWorkspaceId: mapping.id,
            OR: [{ email }, { brandwellUserId: input.brandwellUserId }],
          },
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
        let workspaceAccessManaged = false;
        if (existingUser) {
          const existingMember = await tx.member.findUnique({
            where: {
              organizationId_userId: {
                organizationId: mapping.rakazoWorkspaceId,
                userId: existingUser.id,
              },
            },
          });
          if (!existingMember) {
            await tx.member.create({
              data: {
                id: createId(),
                organizationId: mapping.rakazoWorkspaceId,
                userId: existingUser.id,
                role: "member",
                createdAt: now(),
              },
            });
            workspaceAccessManaged = true;
          }
        } else {
          const existingInvitation = await tx.invitation.findFirst({
            where: {
              organizationId: mapping.rakazoWorkspaceId,
              email,
              status: "pending",
            },
            orderBy: { expiresAt: "desc" },
          });
          const invitation =
            existingInvitation ??
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
          workspaceAccessManaged = existingInvitation === null;
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
        await tx.bot.update({
          where: { id: bot.id },
          data: { primaryThreadId: thread.id },
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
            brandwellUserId: input.brandwellUserId,
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
            workspaceAccessManaged,
            skillBundleVersion: BRANDWELL_AIMEE_SKILL_BUNDLE_VERSION,
            commercialRevision: mapping.commercialRevision,
            activatedAt: existingUser ? now() : null,
          },
          include: { bot: true, computer: true },
        });
        await createModelCredential(tx, created.id);
        return { sidekick: created, replayed: false, credentialCreated: true };
      })
      .catch(async (error) => {
        await options.openRouter.deleteKey(createdKey.hash).catch(() => undefined);
        throw error;
      });
    if (!provisioned.credentialCreated) {
      await options.openRouter.deleteKey(createdKey.hash).catch(() => undefined);
    }
    return sidekickResult(provisioned.sidekick, provisioned.replayed);
  } finally {
    await policyLease.release().catch(() => undefined);
  }
}

export async function claimBrandwellSidekickInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    userId: string;
    brandwellUserId?: string;
    email: string;
    now: Date;
  },
) {
  const sidekick = await tx.brandwellSidekick.findFirst({
    where: {
      workspaceId: input.workspaceId,
      ...(input.brandwellUserId
        ? { brandwellUserId: input.brandwellUserId }
        : { email: input.email.trim().toLowerCase() }),
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
    data: {
      userId: input.userId,
      ...(input.brandwellUserId ? { brandwellUserId: input.brandwellUserId } : {}),
      status: "active",
      activatedAt: input.now,
    },
  });
}

export async function setBrandwellSidekickLifecycleWithPrisma(
  sidekickReference: string,
  action: "pause" | "resume" | "cancel",
  options: PrismaBrandwellSidekickLifecycleOptions,
) {
  const idempotencyKey = normalizedLifecycleIdempotencyKey(options.idempotencyKey);
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  const initial = await findLifecycleSidekick(options.prisma, sidekickReference);
  if (!initial?.botId) {
    throw new BrandwellSidekickError("Sidekick not found", "sidekick_not_found", 404);
  }
  const replay = await options.prisma.brandwellSidekickLifecycleOperation.findUnique({
    where: { idempotencyKey },
  });
  if (replay && (replay.sidekickId !== initial.id || replay.action !== action)) {
    throw new BrandwellSidekickError(
      "The lifecycle idempotency key is already assigned to another request",
      "sidekick_lifecycle_identity_conflict",
      409,
    );
  }
  if (replay?.status === "completed") return storedLifecycleResult(replay.result, initial);

  const policyLease = await acquireBrandwellModelPolicyLease(
    options.prisma,
    initial.aiWorkspaceId,
    `sidekick-lifecycle:${action}`,
    now,
  );
  if (!policyLease) {
    throw new BrandwellSidekickError(
      "Another model policy or Sidekick change is already in progress",
      "model_policy_busy",
      409,
    );
  }

  let resumeProviderMayBeEnabled = false;
  let operationId: string | null = null;
  try {
    let operation = replay;

    if (!operation) {
      const unfinished = await options.prisma.brandwellSidekickLifecycleOperation.findFirst({
        where: { sidekickId: initial.id, status: { in: ["running", "failed"] } },
      });
      if (unfinished) {
        throw new BrandwellSidekickError(
          "Retry the unfinished Sidekick lifecycle request with its original idempotency key",
          "sidekick_lifecycle_busy",
          409,
        );
      }
      const idempotent = idempotentLifecycleStatus(initial.status, action);
      if (idempotent) return lifecycleResult(initial, true);
      operation = await beginSidekickLifecycleOperation(
        sidekickReference,
        action,
        idempotencyKey,
        options,
        now(),
        createId(),
      );
    } else {
      await options.prisma.brandwellSidekickLifecycleOperation.update({
        where: { id: operation.id },
        data: { status: "running", attempts: { increment: 1 }, lastError: null },
      });
      operation = await options.prisma.brandwellSidekickLifecycleOperation.findUniqueOrThrow({
        where: { id: operation.id },
      });
    }
    operationId = operation.id;

    if (operation.providerStatus === "pending") {
      if (!operation.externalKeyHash) {
        throw new BrandwellSidekickError(
          "The Sidekick OpenRouter key link must be reconciled before this lifecycle action can finish",
          "sidekick_credential_unlinked",
          503,
        );
      }
      await policyLease.renew();
      if (action === "cancel") {
        await options.openRouter.deleteKey(operation.externalKeyHash);
      } else {
        if (action === "resume") resumeProviderMayBeEnabled = true;
        await options.openRouter.updateKey(operation.externalKeyHash, {
          disabled: action === "pause",
        });
      }
      await options.prisma.brandwellSidekickLifecycleOperation.update({
        where: { id: operation.id },
        data: { providerStatus: "completed", lastError: null },
      });
      operation = { ...operation, providerStatus: "completed" };
    } else if (action === "resume" && operation.providerStatus === "completed") {
      resumeProviderMayBeEnabled = true;
    }

    if (["pending", "fenced", "checkpointed"].includes(operation.computerStatus)) {
      await policyLease.renew();
      await stopLifecycleComputer(sidekickReference, operation, options);
    }

    await policyLease.renew();
    return await completeSidekickLifecycleOperation(operation.id, options, now());
  } catch (error) {
    let resetResumeProvider = false;
    if (action === "resume" && resumeProviderMayBeEnabled) {
      const operation = operationId
        ? await options.prisma.brandwellSidekickLifecycleOperation.findUnique({
            where: { id: operationId },
            select: { externalKeyHash: true },
          })
        : null;
      if (operation?.externalKeyHash) {
        resetResumeProvider = await options.openRouter
          .updateKey(operation.externalKeyHash, { disabled: true })
          .then(() => true)
          .catch(() => false);
      }
    }
    if (action !== "resume" && operationId) {
      const unfinished = await options.prisma.brandwellSidekickLifecycleOperation
        .findUnique({ where: { id: operationId } })
        .catch(() => null);
      if (
        unfinished?.providerStatus === "pending" &&
        ["pending", "fenced", "checkpointed"].includes(unfinished.computerStatus)
      ) {
        await stopLifecycleComputer(sidekickReference, unfinished, options).catch(() => undefined);
      }
    }
    if (operationId) {
      await options.prisma.brandwellSidekickLifecycleOperation
        .update({
          where: { id: operationId },
          data: {
            status: "failed",
            lastError: safeLifecycleError(error),
            ...(resetResumeProvider ? { providerStatus: "pending" } : {}),
          },
        })
        .catch(() => undefined);
    }
    if (error instanceof BrandwellSidekickError) throw error;
    throw new BrandwellSidekickError(
      "The Sidekick lifecycle change is safely blocked and will resume on retry",
      "sidekick_lifecycle_pending",
      503,
    );
  } finally {
    await policyLease.release().catch(() => undefined);
  }
}

async function beginSidekickLifecycleOperation(
  sidekickReference: string,
  action: "pause" | "resume" | "cancel",
  idempotencyKey: string,
  options: PrismaBrandwellSidekickLifecycleOptions,
  at: Date,
  operationId: string,
) {
  return withTransactionRetry(() =>
    options.prisma.$transaction(
      async (tx) => {
        const sidekick = await findLifecycleSidekick(tx, sidekickReference);
        if (!sidekick?.botId) {
          throw new BrandwellSidekickError("Sidekick not found", "sidekick_not_found", 404);
        }
        assertLifecycleTransition(sidekick, action);
        if (action === "resume") await assertResumeReady(tx, sidekick);
        const unfinished = await tx.brandwellSidekickLifecycleOperation.findFirst({
          where: { sidekickId: sidekick.id, status: { in: ["running", "failed"] } },
        });
        if (unfinished) {
          throw new BrandwellSidekickError(
            "Another Sidekick lifecycle change is already in progress",
            "sidekick_lifecycle_busy",
            409,
          );
        }

        const nextStatus = action === "cancel" ? "canceling" : action === "pause" ? "paused" : null;
        if (nextStatus) {
          const changed = await tx.brandwellSidekick.updateMany({
            where: { id: sidekick.id, status: sidekick.status },
            data: {
              status: nextStatus,
              ...(action === "pause" ? { pausedAt: at } : { canceledAt: at }),
            },
          });
          if (changed.count !== 1) {
            throw new BrandwellSidekickError(
              "The Sidekick lifecycle state changed concurrently",
              "sidekick_lifecycle_conflict",
              409,
            );
          }
          await tx.bot.update({
            where: { id: sidekick.botId },
            data: {
              managedStatus: action === "cancel" ? "canceled" : "paused",
              ...(action === "cancel" ? { archivedAt: at } : {}),
            },
          });
          await tx.routine.updateMany({
            where: { botId: sidekick.botId },
            data: { active: false, nextRunAt: null },
          });
          if (sidekick.modelCredential) {
            await tx.brandwellSidekickModelCredential.update({
              where: { id: sidekick.modelCredential.id },
              data: { status: "disabled", disabledAt: at },
            });
          }
          if (sidekick.computerId) {
            const computerUserId = sidekick.userId ?? sidekick.bot?.userId;
            if (!computerUserId) {
              throw new BrandwellSidekickError(
                "The Sidekick computer owner must be reconciled before this lifecycle action can finish",
                "sidekick_computer_unavailable",
                503,
              );
            }
            const stoppedAction = action === "cancel" ? "cancel" : "pause";
            await options.computerLifecycle.fence(tx, {
              operationId,
              action: stoppedAction,
              computerId: sidekick.computerId,
              botId: sidekick.botId,
              workspaceId: sidekick.workspaceId,
              userId: computerUserId,
            });
          }
        }

        if (action === "cancel") {
          if (sidekick.workspaceAccessManaged && sidekick.invitationId) {
            await tx.invitation.deleteMany({
              where: { id: sidekick.invitationId, status: "pending" },
            });
          }
          if (sidekick.userId) {
            const [remaining, managedAccess] = await Promise.all([
              tx.brandwellSidekick.count({
                where: {
                  workspaceId: sidekick.workspaceId,
                  userId: sidekick.userId,
                  id: { not: sidekick.id },
                  status: { in: COUNTED_SIDEKICK_STATES },
                },
              }),
              tx.brandwellSidekick.count({
                where: {
                  workspaceId: sidekick.workspaceId,
                  userId: sidekick.userId,
                  workspaceAccessManaged: true,
                },
              }),
            ]);
            if (remaining === 0 && managedAccess > 0) {
              await tx.member.deleteMany({
                where: {
                  organizationId: sidekick.workspaceId,
                  userId: sidekick.userId,
                  role: "member",
                },
              });
            }
          }
        }

        return tx.brandwellSidekickLifecycleOperation.create({
          data: {
            id: operationId,
            sidekickId: sidekick.id,
            workspaceId: sidekick.workspaceId,
            idempotencyKey,
            action,
            fromStatus: sidekick.status,
            providerStatus: sidekick.modelCredential ? "pending" : "not_required",
            computerStatus: action === "resume" || !sidekick.computerId ? "not_required" : "fenced",
            externalKeyHash: sidekick.modelCredential?.externalKeyHash,
            computerProviderRef: sidekick.computer?.providerRef,
            auditMetadata: options.auditMetadata ?? {},
          },
        });
      },
      { isolationLevel: "Serializable" },
    ),
  );
}

async function stopLifecycleComputer(
  sidekickReference: string,
  operation: { id: string; action: string; computerStatus: string },
  options: PrismaBrandwellSidekickLifecycleOptions,
) {
  if (operation.action !== "pause" && operation.action !== "cancel") return;
  const sidekick = await findLifecycleSidekick(options.prisma, sidekickReference);
  if (!sidekick?.botId || !sidekick.computerId) {
    throw new BrandwellSidekickError(
      "The Sidekick computer must be reconciled before this lifecycle action can finish",
      "sidekick_computer_unavailable",
      503,
    );
  }
  const computerUserId = sidekick.userId ?? sidekick.bot?.userId;
  if (!computerUserId) {
    throw new BrandwellSidekickError(
      "The Sidekick computer owner must be reconciled before this lifecycle action can finish",
      "sidekick_computer_unavailable",
      503,
    );
  }
  await options.computerLifecycle.stop({
    operationId: operation.id,
    action: operation.action,
    computerId: sidekick.computerId,
    botId: sidekick.botId,
    workspaceId: sidekick.workspaceId,
    userId: computerUserId,
    checkpointRequired:
      operation.computerStatus === "pending" || operation.computerStatus === "fenced",
    markCheckpointed: async () => {
      await options.prisma.brandwellSidekickLifecycleOperation.updateMany({
        where: {
          id: operation.id,
          computerStatus: { in: ["pending", "fenced"] },
        },
        data: { computerStatus: "checkpointed", lastError: null },
      });
    },
  });
  await options.prisma.brandwellSidekickLifecycleOperation.update({
    where: { id: operation.id },
    data: { computerStatus: "completed", lastError: null },
  });
}

async function completeSidekickLifecycleOperation(
  operationId: string,
  options: PrismaBrandwellSidekickLifecycleOptions,
  at: Date,
) {
  return withTransactionRetry(() =>
    options.prisma.$transaction(
      async (tx) => {
        const operation = await tx.brandwellSidekickLifecycleOperation.findUniqueOrThrow({
          where: { id: operationId },
        });
        const sidekick = await findLifecycleSidekick(tx, operation.sidekickId);
        if (!sidekick?.botId) {
          throw new BrandwellSidekickError("Sidekick not found", "sidekick_not_found", 404);
        }
        if (operation.status === "completed") {
          return storedLifecycleResult(operation.result, sidekick);
        }
        if (
          !["completed", "not_required"].includes(operation.providerStatus) ||
          !["completed", "not_required"].includes(operation.computerStatus)
        ) {
          throw new Error("Sidekick lifecycle provider work is incomplete");
        }

        let status: "paused" | "active" | "canceled";
        if (operation.action === "resume") {
          await assertResumeReady(tx, sidekick);
          const changed = await tx.brandwellSidekick.updateMany({
            where: { id: sidekick.id, status: "paused" },
            data: { status: "active", pausedAt: null, canceledAt: null },
          });
          if (changed.count !== 1) throw new Error("Sidekick resume state changed concurrently");
          await tx.bot.update({
            where: { id: sidekick.botId },
            data: { managedStatus: "active", archivedAt: null },
          });
          await tx.brandwellSidekickModelCredential.update({
            where: { id: sidekick.modelCredential!.id },
            data: { status: "active", disabledAt: null },
          });
          status = "active";
        } else if (operation.action === "cancel") {
          const changed = await tx.brandwellSidekick.updateMany({
            where: { id: sidekick.id, status: "canceling" },
            data: { status: "canceled", canceledAt: sidekick.canceledAt ?? at },
          });
          if (changed.count !== 1)
            throw new Error("Sidekick cancellation state changed concurrently");
          await tx.bot.update({
            where: { id: sidekick.botId },
            data: { managedStatus: "canceled", archivedAt: sidekick.bot?.archivedAt ?? at },
          });
          if (sidekick.modelCredential) {
            await tx.brandwellSidekickModelCredential.delete({
              where: { id: sidekick.modelCredential.id },
            });
            await tx.secret.delete({ where: { id: sidekick.modelCredential.secretId } });
          }
          status = "canceled";
        } else {
          if (sidekick.status !== "paused")
            throw new Error("Sidekick pause state changed concurrently");
          status = "paused";
        }

        const result = lifecycleResult({ ...sidekick, status }, false);
        await tx.brandwellAuditLog.create({
          data: {
            workspaceId: sidekick.workspaceId,
            actorType: "brandwell_operator",
            action: `sidekick.${operation.action}`,
            resourceType: "brandwell_sidekick",
            resourceId: sidekick.id,
            metadata: {
              ...jsonObject(operation.auditMetadata),
              operationId: operation.id,
              idempotencyKey: operation.idempotencyKey,
              fromStatus: operation.fromStatus,
              status,
            },
          },
        });
        await tx.brandwellSidekickLifecycleOperation.update({
          where: { id: operation.id },
          data: {
            status: "completed",
            completedAt: at,
            lastError: null,
            result,
          },
        });
        return result;
      },
      { isolationLevel: "Serializable" },
    ),
  );
}

function findLifecycleSidekick(prisma: PrismaClient | Prisma.TransactionClient, reference: string) {
  return prisma.brandwellSidekick.findFirst({
    where: { OR: [{ id: reference }, { brandwellSidekickId: reference }] },
    include: {
      bot: true,
      computer: true,
      modelCredential: true,
      aiWorkspace: { select: { commercialStatus: true, subscriptionStatus: true } },
    },
  });
}

function assertLifecycleTransition(
  sidekick: NonNullable<Awaited<ReturnType<typeof findLifecycleSidekick>>>,
  action: "pause" | "resume" | "cancel",
) {
  if (sidekick.status === "canceled") {
    throw new BrandwellSidekickError(
      "A canceled Sidekick cannot change lifecycle state",
      "sidekick_canceled",
      409,
    );
  }
  if (action === "pause" && sidekick.status !== "active") {
    throw new BrandwellSidekickError(
      "Only an active Sidekick can be paused",
      "sidekick_transition_invalid",
      409,
    );
  }
  if (action === "resume" && sidekick.status !== "paused") {
    throw new BrandwellSidekickError(
      "Only a paused Sidekick can be resumed",
      "sidekick_transition_invalid",
      409,
    );
  }
  if (
    action === "cancel" &&
    !["invited", "active", "paused", "canceling"].includes(sidekick.status)
  ) {
    throw new BrandwellSidekickError(
      "This Sidekick cannot be canceled from its current state",
      "sidekick_transition_invalid",
      409,
    );
  }
}

async function assertResumeReady(
  prisma: Prisma.TransactionClient,
  sidekick: NonNullable<Awaited<ReturnType<typeof findLifecycleSidekick>>>,
) {
  if (!sidekick.userId) {
    throw new BrandwellSidekickError(
      "The teammate must accept access before this Sidekick can resume",
      "sidekick_access_pending",
      409,
    );
  }
  if (
    !ACTIVE_COMMERCIAL_STATES.has(sidekick.aiWorkspace.commercialStatus) ||
    !ACTIVE_COMMERCIAL_STATES.has(sidekick.aiWorkspace.subscriptionStatus)
  ) {
    throw new BrandwellSidekickError(
      "The client AIMEE entitlement must be active before this Sidekick can resume",
      "workspace_inactive",
      409,
    );
  }
  const [member, secret] = await Promise.all([
    prisma.member.findUnique({
      where: {
        organizationId_userId: {
          organizationId: sidekick.workspaceId,
          userId: sidekick.userId,
        },
      },
      select: { id: true },
    }),
    sidekick.modelCredential
      ? prisma.secret.findUnique({
          where: { id: sidekick.modelCredential.secretId },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);
  if (!member) {
    throw new BrandwellSidekickError(
      "Restore the teammate workspace membership before this Sidekick can resume",
      "sidekick_access_missing",
      409,
    );
  }
  if (!sidekick.modelCredential?.externalKeyHash || !secret) {
    throw new BrandwellSidekickError(
      "Reconcile the Sidekick model credential before this Sidekick can resume",
      "sidekick_credential_unavailable",
      409,
    );
  }
}

function idempotentLifecycleStatus(status: string, action: "pause" | "resume" | "cancel") {
  if (status === "canceled") {
    if (action === "cancel") return true;
    throw new BrandwellSidekickError(
      "A canceled Sidekick cannot change lifecycle state",
      "sidekick_canceled",
      409,
    );
  }
  return (
    (action === "pause" && status === "paused") || (action === "resume" && status === "active")
  );
}

function lifecycleResult(
  sidekick: { id: string; status: string; botId: string | null; computerId: string | null },
  replayed: boolean,
) {
  return {
    sidekickId: sidekick.id,
    status: sidekick.status,
    botId: sidekick.botId,
    computerId: sidekick.computerId,
    replayed,
  };
}

function storedLifecycleResult(
  value: Prisma.JsonValue,
  sidekick: { id: string; status: string; botId: string | null; computerId: string | null },
) {
  const stored = jsonObject(value);
  return {
    sidekickId: typeof stored.sidekickId === "string" ? stored.sidekickId : sidekick.id,
    status: typeof stored.status === "string" ? stored.status : sidekick.status,
    botId:
      typeof stored.botId === "string" || stored.botId === null ? stored.botId : sidekick.botId,
    computerId:
      typeof stored.computerId === "string" || stored.computerId === null
        ? stored.computerId
        : sidekick.computerId,
    replayed: true,
  };
}

function normalizedLifecycleIdempotencyKey(value: string) {
  const key = value.trim();
  if (!/^[A-Za-z0-9._:-]{8,240}$/.test(key)) {
    throw new BrandwellSidekickError(
      "A valid lifecycle idempotency key is required",
      "sidekick_idempotency_key_invalid",
      400,
    );
  }
  return key;
}

function safeLifecycleError(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message.trim().slice(0, 500)
    : "Sidekick lifecycle operation failed";
}

function jsonObject(value: Prisma.JsonValue): Prisma.InputJsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Prisma.InputJsonObject)
    : {};
}

export async function rolloutBrandwellSkillBundleWithPrisma(
  workspaceReference: string,
  prisma: PrismaClient,
) {
  const mapping = await findMapping(prisma, workspaceReference);
  if (!mapping) {
    throw new BrandwellSidekickError("BrandWell workspace not found", "workspace_not_found", 404);
  }
  const bots = await prisma.bot.findMany({
    where: { workspaceId: mapping.rakazoWorkspaceId, managedByBrandWell: true, archivedAt: null },
    select: { id: true, userId: true, serviceIdentityId: true },
  });
  const users = [...new Set(bots.map((bot) => bot.userId))];
  const installed = [];
  for (const userId of users) {
    installed.push(
      await installBrandwellSkillBundle(prisma, {
        workspaceId: mapping.rakazoWorkspaceId,
        userId,
      }),
    );
  }
  let routinesReconciled = 0;
  for (const bot of bots) {
    const existingDefaults = await prisma.routine.findMany({
      where: {
        workspaceId: mapping.rakazoWorkspaceId,
        botId: bot.id,
        name: { in: BRANDWELL_AIMEE_DEFAULT_ROUTINES.map((routine) => routine.name) },
      },
    });
    const defaultsAreActive = existingDefaults.some((routine) => routine.active);
    for (const template of BRANDWELL_AIMEE_DEFAULT_ROUTINES) {
      const existing = existingDefaults.find((routine) => routine.name === template.name);
      const active = existing?.active ?? defaultsAreActive;
      const nextRunAt = active
        ? nextCronDateAcrossStrict([template.cron], new Date(), mapping.timezone)
        : null;
      if (existing) {
        await prisma.routine.update({
          where: { id: existing.id },
          data: {
            prompt: template.prompt,
            crons: [template.cron],
            timezone: mapping.timezone,
            nextRunAt,
          },
        });
      } else {
        await prisma.routine.create({
          data: {
            workspaceId: mapping.rakazoWorkspaceId,
            botId: bot.id,
            userId: bot.userId,
            serviceIdentityId: bot.serviceIdentityId ?? mapping.serviceIdentityId,
            name: template.name,
            prompt: template.prompt,
            crons: [template.cron],
            timezone: mapping.timezone,
            active,
            notify: true,
            nextRunAt,
          },
        });
      }
      routinesReconciled += 1;
    }
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
    routines: routinesReconciled,
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
