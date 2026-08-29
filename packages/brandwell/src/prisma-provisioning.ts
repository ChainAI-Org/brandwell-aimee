import { createHash, randomUUID } from "node:crypto";
import {
  createThreadMessageInTransaction,
  ensureComputerRecord,
  type Prisma,
  type PrismaClient,
} from "@rakazo/db";
import {
  BRANDWELL_AIMEE_DEFAULT_ROUTINES,
  BRANDWELL_AIMEE_INSTRUCTIONS,
  BRANDWELL_AIMEE_SKILLS,
  BRANDWELL_AIMEE_WELCOME,
} from "./aimee-baseline.js";
import { BRANDWELL_BRAND } from "./brand-config.js";
import { microsToUsd, type OpenRouterManagementClient } from "./openrouter-management.js";
import {
  type BrandwellProvisioningCheckpoint,
  type BrandwellProvisioningInput,
  type BrandwellProvisioningRunner,
  provisionBrandwellWorkspace,
} from "./provisioning.js";

const PRIMARY_AIMEE_SPAWN_KEY = "brandwell:aimee:primary";
const SERVICE_IDENTITY_NAME = "BrandWell Client Service Identity";

const NATIVE_CONNECTIONS = [
  { provider: "brandwell-intent", displayName: "BrandWell Intent" },
  { provider: "brandwell-trafficid", displayName: "TrafficID" },
  { provider: "brandwell-postcards", displayName: "BrandWell Postcards" },
] as const;

export type BrandwellSecretCipher = {
  encrypt(plaintext: string, context: { workspaceId: string; userId: string }): Promise<string>;
};

export type PrismaBrandwellProvisioningOptions = {
  prisma: PrismaClient;
  secretCipher: BrandwellSecretCipher;
  openRouter: Pick<OpenRouterManagementClient, "createKey" | "deleteKey">;
  systemUserId?: string;
  sandboxKind: string;
  defaultModel: string;
  computerModel?: string;
  lightweightModel?: string;
  reasoningModel?: string;
  fallbackModels?: string[];
  monthlyLimitMicros: bigint;
  warningLimitMicros: bigint;
  dailyLimitMicros?: bigint;
  now?: () => Date;
  createId?: () => string;
};

export function createPrismaBrandwellProvisioningRunner(
  options: PrismaBrandwellProvisioningOptions,
): BrandwellProvisioningRunner {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;

  async function mappingFor(idempotencyKey: string) {
    return options.prisma.brandwellAiWorkspace.findUnique({
      where: { brandwellCustomerId: customerIdFromKey(idempotencyKey) },
    });
  }

  async function requireMapping(checkpoint: BrandwellProvisioningCheckpoint) {
    const mapping = await mappingFor(checkpoint.idempotencyKey);
    if (!mapping) throw new Error("BrandWell workspace mapping is unavailable");
    return mapping;
  }

  async function requireSystemUserId(): Promise<string> {
    const configured = options.systemUserId?.trim();
    if (configured) {
      const user = await options.prisma.user.findUnique({
        where: { id: configured },
        select: { id: true },
      });
      if (!user) throw new Error("Configured BrandWell system user does not exist");
      return user.id;
    }
    const settings = await options.prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { ownerUserId: true },
    });
    if (!settings?.ownerUserId) {
      throw new Error("BrandWell provisioning requires a system user or deployment owner");
    }
    return settings.ownerUserId;
  }

  return {
    now,
    createRunId: createId,
    async load(idempotencyKey) {
      const mapping = await mappingFor(idempotencyKey);
      return checkpointFromJson(mapping?.provisioningMetadata);
    },
    async save(checkpoint) {
      let mapping = await mappingFor(checkpoint.idempotencyKey);
      if (!mapping) {
        const mayBootstrap =
          checkpoint.status === "running" &&
          checkpoint.steps.every((step) => step.status === "pending");
        if (!mayBootstrap) return;
        mapping = await createWorkspaceMapping(options.prisma, checkpoint, createId, now);
      }
      const metadata = {
        ...checkpointJson(checkpoint),
      } as Record<string, Prisma.InputJsonValue>;
      const bootstrap = bootstrapRunId(mapping.provisioningMetadata);
      if (bootstrap) metadata.bootstrapRunId = bootstrap;
      await options.prisma.brandwellAiWorkspace.update({
        where: { id: mapping.id },
        data: {
          provisioningStatus: checkpoint.status,
          provisioningError: checkpoint.error ?? null,
          provisioningMetadata: metadata as Prisma.InputJsonObject,
          ...(checkpoint.status === "complete"
            ? { subscriptionStatus: "active" }
            : checkpoint.status === "failed" || checkpoint.status === "rollback_failed"
              ? { subscriptionStatus: "provisioning_failed" }
              : {}),
        },
      });
    },
    async execute(step, checkpoint) {
      const mapping = await requireMapping(checkpoint);
      const workspaceId = mapping.rakazoWorkspaceId;
      const systemUserId = step === "workspace" ? undefined : await requireSystemUserId();

      switch (step) {
        case "workspace":
          return {
            resourceId: workspaceId,
            metadata: {
              mappingId: mapping.id,
              created: bootstrapRunId(mapping.provisioningMetadata) === checkpoint.runId,
            },
          };
        case "service_identity": {
          const existing = await options.prisma.brandwellServiceIdentity.findUnique({
            where: { workspaceId_name: { workspaceId, name: SERVICE_IDENTITY_NAME } },
          });
          const identity =
            existing ??
            (await options.prisma.brandwellServiceIdentity.create({
              data: {
                workspaceId,
                name: SERVICE_IDENTITY_NAME,
                status: "active",
                createdByUserId: systemUserId,
              },
            }));
          await options.prisma.brandwellAiWorkspace.update({
            where: { id: mapping.id },
            data: { serviceIdentityId: identity.id },
          });
          return { resourceId: identity.id, metadata: { created: !existing } };
        }
        case "client_admin_membership": {
          const user = await options.prisma.user.findUnique({
            where: { email: checkpoint.input.primaryContactEmail },
            select: { id: true },
          });
          if (user) {
            const existing = await options.prisma.member.findUnique({
              where: { organizationId_userId: { organizationId: workspaceId, userId: user.id } },
            });
            const member =
              existing ??
              (await options.prisma.member.create({
                data: {
                  id: createId(),
                  organizationId: workspaceId,
                  userId: user.id,
                  role: "owner",
                  createdAt: now(),
                },
              }));
            return {
              resourceId: member.id,
              metadata: { kind: "member", created: !existing, userId: user.id },
            };
          }
          const existingInvitation = await options.prisma.invitation.findFirst({
            where: {
              organizationId: workspaceId,
              email: checkpoint.input.primaryContactEmail,
              status: "pending",
            },
            orderBy: { expiresAt: "desc" },
          });
          const invitation =
            existingInvitation ??
            (await options.prisma.invitation.create({
              data: {
                id: createId(),
                organizationId: workspaceId,
                email: checkpoint.input.primaryContactEmail,
                role: "owner",
                status: "pending",
                expiresAt: new Date(now().getTime() + 7 * 86_400_000),
                inviterId: systemUserId!,
              },
            }));
          return {
            resourceId: invitation.id,
            metadata: { kind: "invitation", created: !existingInvitation },
          };
        }
        case "primary_aimee": {
          const serviceIdentityId = await requireServiceIdentityId(options.prisma, workspaceId);
          const existing = await options.prisma.bot.findUnique({
            where: { workspaceId_spawnKey: { workspaceId, spawnKey: PRIMARY_AIMEE_SPAWN_KEY } },
          });
          const bot =
            existing ??
            (await options.prisma.$transaction(async (tx) => {
              const created = await tx.bot.create({
                data: {
                  workspaceId,
                  userId: systemUserId!,
                  createdByUserId: systemUserId,
                  ownerType: "workspace",
                  visibility: "workspace",
                  managedByBrandWell: true,
                  managedStatus: "active",
                  serviceIdentityId,
                  name: BRANDWELL_BRAND.productName,
                  title: "AI GTM Employee",
                  description:
                    "A managed AI employee for intent, visitor identification, campaigns, and GTM operations.",
                  instructions: BRANDWELL_AIMEE_INSTRUCTIONS,
                  color: BRANDWELL_BRAND.colors.primary,
                  notifyOnFinish: true,
                  pinned: true,
                  spawnKey: PRIMARY_AIMEE_SPAWN_KEY,
                  modelProvider: "openrouter",
                  modelId: options.defaultModel,
                },
              });
              const thread = await tx.thread.create({
                data: { workspaceId, botId: created.id, userId: systemUserId! },
              });
              await createThreadMessageInTransaction(tx, {
                threadId: thread.id,
                role: "bot",
                botId: created.id,
                blocks: [{ kind: "text", text: BRANDWELL_AIMEE_WELCOME }],
              });
              await tx.browserProfile.create({
                data: { workspaceId, botId: created.id, userId: systemUserId! },
              });
              await tx.memoryDocument.create({
                data: {
                  workspaceId,
                  userId: systemUserId!,
                  botId: created.id,
                  scope: "bot",
                  path: "MEMORY.md",
                  content: `# ${BRANDWELL_BRAND.productName}\n\n`,
                },
              });
              return created;
            }));
          await options.prisma.brandwellAiWorkspace.update({
            where: { id: mapping.id },
            data: { primaryBotId: bot.id },
          });
          return { resourceId: bot.id, metadata: { created: !existing } };
        }
        case "team_computer": {
          const existing = await options.prisma.computer.findUnique({
            where: { scopeKey: `team:${workspaceId}` },
          });
          const computer = await ensureComputerRecord(options.prisma, {
            mode: "team",
            workspaceId,
            userId: systemUserId!,
            kind: options.sandboxKind,
          });
          await options.prisma.bot.updateMany({
            where: { workspaceId, managedByBrandWell: true, archivedAt: null },
            data: { computerId: computer.id },
          });
          return { resourceId: computer.id, metadata: { created: !existing } };
        }
        case "openrouter_credential": {
          const existing = await options.prisma.brandwellWorkspaceModelCredential.findUnique({
            where: { workspaceId },
          });
          if (existing) return { resourceId: existing.id, metadata: { created: false } };
          const serviceIdentityId = await requireServiceIdentityId(options.prisma, workspaceId);
          // OpenRouter workspace_id is a provider-owned UUID, not Rakazo's
          // workspace ID. A unique child key still isolates spend and revocation
          // for this BrandWell client inside the configured OpenRouter workspace.
          const createdKey = await options.openRouter.createKey({
            name: `BrandWell AIMEE ${checkpoint.input.companyName} ${workspaceId}`,
            limitUsd: microsToUsd(options.monthlyLimitMicros),
            limitReset: "monthly",
          });
          try {
            const ciphertext = await options.secretCipher.encrypt(createdKey.key, {
              workspaceId,
              userId: systemUserId!,
            });
            const credential = await options.prisma.$transaction(async (tx) => {
              const secret = await tx.secret.create({
                data: {
                  userId: systemUserId!,
                  workspaceId,
                  ownerType: "service",
                  serviceIdentityId,
                  kind: "model:openrouter",
                  ciphertext,
                },
              });
              return tx.brandwellWorkspaceModelCredential.create({
                data: {
                  workspaceId,
                  serviceIdentityId,
                  provider: "openrouter",
                  secretId: secret.id,
                  externalKeyHash: createdKey.hash,
                  externalWorkspaceId: createdKey.workspaceId,
                  limitReset: createdKey.limitReset ?? "monthly",
                  status: "active",
                  monthlyLimitMicros: options.monthlyLimitMicros,
                  dailyLimitMicros: options.dailyLimitMicros,
                  warningLimitMicros: options.warningLimitMicros,
                  preferredModel: options.defaultModel,
                  computerModel: options.computerModel,
                  lightweightModel: options.lightweightModel,
                  reasoningModel: options.reasoningModel,
                  fallbackModels: options.fallbackModels ?? [],
                },
              });
            });
            await options.prisma.brandwellAiWorkspace.update({
              where: { id: mapping.id },
              data: { openRouterCredentialId: credential.id },
            });
            return {
              resourceId: credential.id,
              metadata: { created: true, externalKeyHash: createdKey.hash },
            };
          } catch (error) {
            await options.openRouter.deleteKey(createdKey.hash).catch(() => undefined);
            throw error;
          }
        }
        case "model_configuration": {
          const credential = await options.prisma.brandwellWorkspaceModelCredential.update({
            where: { workspaceId },
            data: {
              preferredModel: options.defaultModel,
              computerModel: options.computerModel,
              lightweightModel: options.lightweightModel,
              reasoningModel: options.reasoningModel,
              fallbackModels: options.fallbackModels ?? [],
              monthlyLimitMicros: options.monthlyLimitMicros,
              warningLimitMicros: options.warningLimitMicros,
              dailyLimitMicros: options.dailyLimitMicros,
            },
          });
          return { resourceId: credential.id };
        }
        case "default_routines": {
          const botId = await requirePrimaryBotId(options.prisma, workspaceId);
          const serviceIdentityId = await requireServiceIdentityId(options.prisma, workspaceId);
          const createdIds: string[] = [];
          const routineIds: string[] = [];
          for (const template of BRANDWELL_AIMEE_DEFAULT_ROUTINES) {
            const existing = await options.prisma.routine.findFirst({
              where: { workspaceId, botId, name: template.name },
            });
            const routine =
              existing ??
              (await options.prisma.routine.create({
                data: {
                  workspaceId,
                  botId,
                  userId: systemUserId!,
                  serviceIdentityId,
                  name: template.name,
                  prompt: template.prompt,
                  crons: [template.cron],
                  timezone: checkpoint.input.timezone,
                  active: false,
                  notify: true,
                },
              }));
            routineIds.push(routine.id);
            if (!existing) createdIds.push(routine.id);
          }
          return {
            resourceId: botId,
            metadata: { routineIds, createdIds, activation: "after_connector_onboarding" },
          };
        }
        case "brandwell_skills": {
          const createdIds: string[] = [];
          const skillIds: string[] = [];
          for (const template of BRANDWELL_AIMEE_SKILLS) {
            const existing = await options.prisma.agentSkill.findFirst({
              where: { workspaceId, userId: systemUserId!, name: template.name },
            });
            const skill = existing
              ? await options.prisma.agentSkill.update({
                  where: { id: existing.id },
                  data: { description: template.description, content: template.content },
                })
              : await options.prisma.agentSkill.create({
                  data: {
                    workspaceId,
                    userId: systemUserId!,
                    name: template.name,
                    description: template.description,
                    content: template.content,
                    source: "builtin",
                  },
                });
            skillIds.push(skill.id);
            if (!existing) createdIds.push(skill.id);
          }
          return { metadata: { skillIds, createdIds } };
        }
        case "intent_connection":
        case "trafficid_connection":
        case "postcard_connection": {
          const provider =
            step === "intent_connection"
              ? "brandwell-intent"
              : step === "trafficid_connection"
                ? "brandwell-trafficid"
                : "brandwell-postcards";
          const template = NATIVE_CONNECTIONS.find((item) => item.provider === provider)!;
          const serviceIdentityId = await requireServiceIdentityId(options.prisma, workspaceId);
          const existing = await options.prisma.connection.findFirst({
            where: {
              workspaceId,
              ownerType: "service",
              serviceIdentityId,
              provider,
            },
          });
          const connection = existing
            ? await options.prisma.connection.update({
                where: { id: existing.id },
                data: {
                  connectorId: "brandwell-native",
                  displayName: template.displayName,
                  status: "connected",
                  metadata: {
                    scope: "workspace",
                    managedByBrandWell: true,
                    automaticallyProvisioned: true,
                  },
                },
              })
            : await options.prisma.connection.create({
                data: {
                  workspaceId,
                  userId: systemUserId!,
                  ownerType: "service",
                  serviceIdentityId,
                  connectorId: "brandwell-native",
                  provider,
                  displayName: template.displayName,
                  status: "connected",
                  metadata: {
                    scope: "workspace",
                    managedByBrandWell: true,
                    automaticallyProvisioned: true,
                  },
                },
              });
          return {
            resourceId: connection.id,
            metadata: { created: !existing, status: connection.status },
          };
        }
        case "connector_onboarding":
          return {
            metadata: {
              required: ["gmail", "calendar", "crm"],
              optional: ["slack", "google-drive", "notion"],
              status: "pending_client",
            },
          };
        case "mobile_access":
          return {
            metadata: {
              apiUrl: BRANDWELL_BRAND.apiUrl,
              access: "workspace_membership",
            },
          };
        case "notification_preferences": {
          const user = await options.prisma.user.findUnique({
            where: { email: checkpoint.input.primaryContactEmail },
            select: { id: true },
          });
          if (!user) return { metadata: { pendingUntilMembership: true } };
          const existing = await options.prisma.notificationPreference.findUnique({
            where: { workspaceId_userId: { workspaceId, userId: user.id } },
          });
          const preference =
            existing ??
            (await options.prisma.notificationPreference.create({
              data: { workspaceId, userId: user.id, finish: true, help: true, takeover: true },
            }));
          return { resourceId: preference.id, metadata: { created: !existing } };
        }
      }
    },
    async rollback(step, checkpoint) {
      const mapping = await mappingFor(checkpoint.idempotencyKey);
      if (!mapping) return;
      const state = checkpoint.steps.find((candidate) => candidate.name === step);
      if (!state) return;
      if (state.metadata?.created !== true) {
        if (!["default_routines", "brandwell_skills"].includes(step)) return;
      }
      switch (step) {
        case "notification_preferences":
          if (state.resourceId) {
            await options.prisma.notificationPreference.deleteMany({
              where: { id: state.resourceId },
            });
          }
          return;
        case "postcard_connection":
        case "trafficid_connection":
        case "intent_connection":
          if (state.resourceId) {
            await options.prisma.connection.deleteMany({ where: { id: state.resourceId } });
          }
          return;
        case "brandwell_skills":
          await options.prisma.agentSkill.deleteMany({
            where: { id: { in: stringArray(state.metadata?.createdIds) } },
          });
          return;
        case "default_routines":
          await options.prisma.routine.deleteMany({
            where: { id: { in: stringArray(state.metadata?.createdIds) } },
          });
          return;
        case "model_configuration":
        case "connector_onboarding":
        case "mobile_access":
          return;
        case "openrouter_credential": {
          const hash =
            typeof state.metadata?.externalKeyHash === "string"
              ? state.metadata.externalKeyHash
              : "";
          if (hash) await options.openRouter.deleteKey(hash).catch(() => undefined);
          if (state.resourceId) {
            const credential = await options.prisma.brandwellWorkspaceModelCredential.findUnique({
              where: { id: state.resourceId },
              select: { secretId: true },
            });
            await options.prisma.brandwellWorkspaceModelCredential.deleteMany({
              where: { id: state.resourceId },
            });
            if (credential?.secretId) {
              await options.prisma.secret.deleteMany({ where: { id: credential.secretId } });
            }
          }
          return;
        }
        case "team_computer":
          if (state.resourceId)
            await options.prisma.computer.deleteMany({ where: { id: state.resourceId } });
          return;
        case "primary_aimee":
          if (state.resourceId)
            await options.prisma.bot.deleteMany({ where: { id: state.resourceId } });
          return;
        case "client_admin_membership":
          if (!state.resourceId) return;
          if (state.metadata?.kind === "member") {
            await options.prisma.member.deleteMany({ where: { id: state.resourceId } });
          } else if (state.metadata?.kind === "invitation") {
            await options.prisma.invitation.deleteMany({ where: { id: state.resourceId } });
          }
          return;
        case "service_identity":
          if (state.resourceId) {
            await options.prisma.brandwellServiceIdentity.deleteMany({
              where: { id: state.resourceId },
            });
          }
          return;
        case "workspace":
          await options.prisma.organization.deleteMany({
            where: { id: mapping.rakazoWorkspaceId },
          });
          return;
      }
    },
  };
}

export async function provisionBrandwellWorkspaceWithPrisma(
  input: BrandwellProvisioningInput,
  options: PrismaBrandwellProvisioningOptions,
) {
  return provisionBrandwellWorkspace(input, createPrismaBrandwellProvisioningRunner(options));
}

async function createWorkspaceMapping(
  prisma: PrismaClient,
  checkpoint: BrandwellProvisioningCheckpoint,
  createId: () => string,
  now: () => Date,
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.brandwellAiWorkspace.findUnique({
      where: { brandwellCustomerId: checkpoint.input.brandwellCustomerId },
    });
    if (existing) return existing;
    const workspaceId = createId();
    const slugHash = createHash("sha256")
      .update(checkpoint.input.brandwellCustomerId)
      .digest("hex")
      .slice(0, 8);
    const slugBase =
      checkpoint.input.companyName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40) || "client";
    await tx.organization.create({
      data: {
        id: workspaceId,
        name: checkpoint.input.companyName,
        slug: `brandwell-${slugBase}-${slugHash}`,
        createdAt: now(),
        metadata: JSON.stringify({ managedByBrandWell: true }),
      },
    });
    return tx.brandwellAiWorkspace.create({
      data: {
        brandwellCustomerId: checkpoint.input.brandwellCustomerId,
        rakazoWorkspaceId: workspaceId,
        subscriptionStatus: "provisioning",
        plan: checkpoint.input.plan,
        provisioningStatus: checkpoint.status,
        provisioningMetadata: {
          ...checkpointJson(checkpoint),
          bootstrapRunId: checkpoint.runId,
        },
        timezone: checkpoint.input.timezone,
        primaryContactEmail: checkpoint.input.primaryContactEmail,
      },
    });
  });
}

async function requireServiceIdentityId(
  prisma: PrismaClient,
  workspaceId: string,
): Promise<string> {
  const identity = await prisma.brandwellServiceIdentity.findFirst({
    where: { workspaceId, status: "active" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!identity) throw new Error("BrandWell service identity is unavailable");
  return identity.id;
}

async function requirePrimaryBotId(prisma: PrismaClient, workspaceId: string): Promise<string> {
  const bot = await prisma.bot.findUnique({
    where: { workspaceId_spawnKey: { workspaceId, spawnKey: PRIMARY_AIMEE_SPAWN_KEY } },
    select: { id: true },
  });
  if (!bot) throw new Error("Primary AIMEE employee is unavailable");
  return bot.id;
}

function customerIdFromKey(idempotencyKey: string): string {
  const prefix = "brandwell:provision:";
  if (!idempotencyKey.startsWith(prefix)) throw new Error("Invalid BrandWell idempotency key");
  return idempotencyKey.slice(prefix.length);
}

function checkpointJson(checkpoint: BrandwellProvisioningCheckpoint): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(checkpoint)) as Prisma.InputJsonObject;
}

function checkpointFromJson(value: unknown): BrandwellProvisioningCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<BrandwellProvisioningCheckpoint>;
  if (candidate.version !== 1 || typeof candidate.idempotencyKey !== "string") return null;
  if (!Array.isArray(candidate.steps) || !candidate.input || typeof candidate.status !== "string") {
    return null;
  }
  return candidate as BrandwellProvisioningCheckpoint;
}

function bootstrapRunId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const runId = (value as Record<string, unknown>).bootstrapRunId;
  return typeof runId === "string" ? runId : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}
