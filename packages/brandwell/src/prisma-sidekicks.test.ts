import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { BRANDWELL_AIMEE_SKILL_BUNDLE_VERSION } from "./aimee-baseline.js";
import {
  type PrismaBrandwellSidekickLifecycleOptions,
  provisionBrandwellSidekickWithPrisma,
  setBrandwellSidekickLifecycleWithPrisma,
  sidekickBudgetFromMaster,
  syncBrandwellWorkspaceDesiredStateWithPrisma,
} from "./prisma-sidekicks.js";

type LifecycleStopInput = Parameters<
  PrismaBrandwellSidekickLifecycleOptions["computerLifecycle"]["stop"]
>[0];

type TestLifecycleOperation = {
  id: string;
  sidekickId: string;
  workspaceId: string;
  idempotencyKey: string;
  action: string;
  fromStatus: string;
  status: string;
  providerStatus: string;
  computerStatus: string;
  externalKeyHash: string | null;
  computerProviderRef: string | null;
  attempts: number;
  lastError: string | null;
  auditMetadata: Record<string, unknown>;
  result: Record<string, unknown>;
  completedAt: Date | null;
};

function lifecycleHarness(
  options: {
    initialStatus?: string;
    workspaceAccessManaged?: boolean;
    otherActiveSidekicks?: number;
    managedAccessSidekicks?: number;
    memberExists?: boolean;
    commercialStatus?: string;
    subscriptionStatus?: string;
    leaseBusy?: boolean;
    auditFailures?: number;
  } = {},
) {
  const events: string[] = [];
  let auditFailures = options.auditFailures ?? 0;
  const store = {
    sidekick: {
      status: options.initialStatus ?? "active",
      pausedAt: options.initialStatus === "paused" ? new Date("2026-08-29T12:00:00.000Z") : null,
      canceledAt:
        options.initialStatus === "canceled" ? new Date("2026-08-29T12:00:00.000Z") : null,
      workspaceAccessManaged: options.workspaceAccessManaged ?? true,
    },
    bot: {
      managedStatus: options.initialStatus ?? "active",
      archivedAt:
        options.initialStatus === "canceled" ? new Date("2026-08-29T12:00:00.000Z") : null,
    },
    credential: {
      id: "credential-sidekick-1",
      secretId: "secret-sidekick-1",
      externalKeyHash: "hash-sidekick-1",
      status: options.initialStatus === "paused" ? "disabled" : "active",
      disabledAt: options.initialStatus === "paused" ? new Date("2026-08-29T12:00:00.000Z") : null,
    } as {
      id: string;
      secretId: string;
      externalKeyHash: string;
      status: string;
      disabledAt: Date | null;
    } | null,
    secretExists: true,
    memberExists: options.memberExists ?? true,
    memberDeleted: false,
    routinesActive: true,
    operation: null as TestLifecycleOperation | null,
    audits: [] as Array<Record<string, unknown>>,
    leaseOwner: null as string | null,
  };

  const readSidekick = () => ({
    id: "sidekick-1",
    brandwellSidekickId: "portal-sidekick-1",
    aiWorkspaceId: "mapping-1",
    workspaceId: "workspace-1",
    status: store.sidekick.status,
    userId: "user-1",
    botId: "bot-sidekick-1",
    computerId: "computer-sidekick-1",
    invitationId: null,
    workspaceAccessManaged: store.sidekick.workspaceAccessManaged,
    pausedAt: store.sidekick.pausedAt,
    canceledAt: store.sidekick.canceledAt,
    aiWorkspace: {
      commercialStatus: options.commercialStatus ?? "active",
      subscriptionStatus: options.subscriptionStatus ?? "active",
    },
    bot: {
      id: "bot-sidekick-1",
      userId: "user-1",
      managedStatus: store.bot.managedStatus,
      archivedAt: store.bot.archivedAt,
    },
    computer: {
      id: "computer-sidekick-1",
      providerRef: "sandbox-sidekick-1",
    },
    modelCredential: store.credential ? { ...store.credential } : null,
  });

  const updateKey = vi.fn(async (_hash: string, input: { disabled: boolean }) => {
    events.push(`provider.update:${input.disabled}`);
    return {} as never;
  });
  const deleteKey = vi.fn(async () => {
    events.push("provider.delete");
  });
  const stop = vi.fn(async (input: LifecycleStopInput) => {
    events.push("computer.stop");
    if (input.checkpointRequired) {
      events.push("computer.checkpoint");
      await input.markCheckpointed();
    }
  });
  const fence = vi.fn(async () => {
    events.push("computer.fence");
  });
  const deleteCredential = vi.fn(async () => {
    store.credential = null;
    return {};
  });
  const deleteSecret = vi.fn(async () => {
    store.secretExists = false;
    return {};
  });
  const updateCredential = vi.fn(async (input) => {
    if (store.credential) Object.assign(store.credential, input.data);
    return {};
  });
  const deleteMember = vi.fn(async () => {
    store.memberDeleted = true;
    return { count: 1 };
  });

  const client = {
    brandwellAiWorkspace: {
      updateMany: vi.fn(async (input) => {
        if (input.where.OR) {
          if (options.leaseBusy || store.leaseOwner) return { count: 0 };
          store.leaseOwner = input.data.modelPolicyLeaseOwner;
          return { count: 1 };
        }
        if (input.where.modelPolicyLeaseOwner !== store.leaseOwner) return { count: 0 };
        if (input.data.modelPolicyLeaseOwner === null) store.leaseOwner = null;
        return { count: 1 };
      }),
    },
    brandwellSidekick: {
      findFirst: vi.fn(async () => readSidekick()),
      count: vi.fn(async (input) =>
        input.where.workspaceAccessManaged
          ? (options.managedAccessSidekicks ?? (store.sidekick.workspaceAccessManaged ? 1 : 0))
          : (options.otherActiveSidekicks ?? 0),
      ),
      updateMany: vi.fn(async (input) => {
        if (input.where.status !== store.sidekick.status) return { count: 0 };
        Object.assign(store.sidekick, input.data);
        events.push(`local.sidekick:${input.data.status}`);
        return { count: 1 };
      }),
    },
    brandwellSidekickLifecycleOperation: {
      findUnique: vi.fn(async (input) => {
        if (!store.operation) return null;
        if (
          input.where.idempotencyKey &&
          input.where.idempotencyKey !== store.operation.idempotencyKey
        ) {
          return null;
        }
        if (input.where.id && input.where.id !== store.operation.id) return null;
        return { ...store.operation };
      }),
      findUniqueOrThrow: vi.fn(async (input) => {
        if (!store.operation || store.operation.id !== input.where.id) throw new Error("not found");
        return { ...store.operation };
      }),
      findFirst: vi.fn(async (input) => {
        if (!store.operation || store.operation.sidekickId !== input.where.sidekickId) return null;
        return input.where.status.in.includes(store.operation.status)
          ? { ...store.operation }
          : null;
      }),
      create: vi.fn(async (input) => {
        store.operation = {
          id: input.data.id,
          sidekickId: input.data.sidekickId,
          workspaceId: input.data.workspaceId,
          idempotencyKey: input.data.idempotencyKey,
          action: input.data.action,
          fromStatus: input.data.fromStatus,
          status: "running",
          providerStatus: input.data.providerStatus,
          computerStatus: input.data.computerStatus,
          externalKeyHash: input.data.externalKeyHash ?? null,
          computerProviderRef: input.data.computerProviderRef ?? null,
          attempts: 1,
          lastError: null,
          auditMetadata: input.data.auditMetadata ?? {},
          result: {},
          completedAt: null,
        };
        return { ...store.operation };
      }),
      update: vi.fn(async (input) => {
        if (!store.operation || store.operation.id !== input.where.id) throw new Error("not found");
        const { attempts, ...data } = input.data;
        if (attempts?.increment) store.operation.attempts += attempts.increment;
        Object.assign(store.operation, data);
        return { ...store.operation };
      }),
      updateMany: vi.fn(async (input) => {
        if (
          !store.operation ||
          store.operation.id !== input.where.id ||
          (typeof input.where.computerStatus === "string" &&
            store.operation.computerStatus !== input.where.computerStatus) ||
          (input.where.computerStatus?.in &&
            !input.where.computerStatus.in.includes(store.operation.computerStatus))
        ) {
          return { count: 0 };
        }
        Object.assign(store.operation, input.data);
        return { count: 1 };
      }),
    },
    bot: {
      update: vi.fn(async (input) => {
        Object.assign(store.bot, input.data);
        return {};
      }),
    },
    routine: {
      updateMany: vi.fn(async (input) => {
        store.routinesActive = input.data.active;
        return { count: 1 };
      }),
    },
    brandwellSidekickModelCredential: {
      update: updateCredential,
      delete: deleteCredential,
    },
    secret: {
      findUnique: vi.fn(async () => (store.secretExists ? { id: "secret-sidekick-1" } : null)),
      delete: deleteSecret,
    },
    member: {
      findUnique: vi.fn(async () => (store.memberExists ? { id: "member-1" } : null)),
      deleteMany: deleteMember,
    },
    invitation: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    brandwellAuditLog: {
      create: vi.fn(async (input) => {
        store.audits.push(input.data);
        events.push("audit.create");
        if (auditFailures > 0) {
          auditFailures -= 1;
          throw new Error("audit unavailable");
        }
        return input.data;
      }),
    },
    $transaction: vi.fn(async (callback) => {
      const snapshot = structuredClone(store);
      try {
        return await callback(client);
      } catch (error) {
        Object.assign(store, snapshot);
        throw error;
      }
    }),
  };

  return {
    prisma: client as unknown as PrismaClient,
    store,
    events,
    updateKey,
    deleteKey,
    stop,
    fence,
    deleteCredential,
    deleteSecret,
    updateCredential,
    deleteMember,
    leaseUpdateMany: client.brandwellAiWorkspace.updateMany,
    request(idempotencyKey: string): PrismaBrandwellSidekickLifecycleOptions {
      return {
        prisma: client as unknown as PrismaClient,
        openRouter: { updateKey, deleteKey },
        computerLifecycle: { fence, stop },
        idempotencyKey,
        auditMetadata: { operatorReference: "operator-1" },
        now: () => new Date("2026-08-30T12:00:00.000Z"),
        createId: () => "lifecycle-operation-1",
      };
    },
  };
}

describe("BrandWell Sidekick model-key lifecycle", () => {
  it("inherits negotiated model budgets from the master policy", () => {
    expect(
      sidekickBudgetFromMaster({
        monthlyLimitMicros: 175_000_000n,
        dailyLimitMicros: 8_000_000n,
        warningLimitMicros: 125_000_000n,
      }),
    ).toEqual({
      monthlyLimitMicros: 175_000_000n,
      dailyLimitMicros: 8_000_000n,
      warningLimitMicros: 125_000_000n,
    });
    expect(() =>
      sidekickBudgetFromMaster({
        monthlyLimitMicros: 200_000_001n,
        dailyLimitMicros: null,
        warningLimitMicros: 150_000_000n,
      }),
    ).toThrowError(expect.objectContaining({ code: "primary_aimee_budget_invalid" }));
  });

  it("revokes only the canceled Sidekick key and removes only its stored credential", async () => {
    const harness = lifecycleHarness();

    await expect(
      setBrandwellSidekickLifecycleWithPrisma(
        "portal-sidekick-1",
        "cancel",
        harness.request("cancel-sidekick-0001"),
      ),
    ).resolves.toMatchObject({ status: "canceled", botId: "bot-sidekick-1" });

    expect(harness.deleteKey).toHaveBeenCalledOnce();
    expect(harness.deleteKey).toHaveBeenCalledWith("hash-sidekick-1");
    expect(harness.deleteCredential).toHaveBeenCalledWith({
      where: { id: "credential-sidekick-1" },
    });
    expect(harness.deleteSecret).toHaveBeenCalledWith({ where: { id: "secret-sidekick-1" } });
    expect(harness.deleteMember).toHaveBeenCalledWith({
      where: { organizationId: "workspace-1", userId: "user-1", role: "member" },
    });
    expect(harness.events).toEqual([
      "local.sidekick:canceling",
      "computer.fence",
      "provider.delete",
      "computer.stop",
      "computer.checkpoint",
      "local.sidekick:canceled",
      "audit.create",
    ]);
    expect(harness.store.audits).toHaveLength(1);
  });

  it("preserves workspace access that existed before the Sidekick", async () => {
    const harness = lifecycleHarness({ workspaceAccessManaged: false });

    await setBrandwellSidekickLifecycleWithPrisma(
      "portal-sidekick-1",
      "cancel",
      harness.request("cancel-sidekick-0002"),
    );

    expect(harness.deleteMember).not.toHaveBeenCalled();
  });

  it("preserves managed workspace access while another Sidekick is active", async () => {
    const harness = lifecycleHarness({ otherActiveSidekicks: 1 });

    await setBrandwellSidekickLifecycleWithPrisma(
      "portal-sidekick-1",
      "cancel",
      harness.request("cancel-sidekick-0003"),
    );

    expect(harness.deleteMember).not.toHaveBeenCalled();
  });

  it("disables a paused Sidekick key without deleting it", async () => {
    const harness = lifecycleHarness();

    await setBrandwellSidekickLifecycleWithPrisma(
      "portal-sidekick-1",
      "pause",
      harness.request("pause-sidekick-0001"),
    );

    expect(harness.updateKey).toHaveBeenCalledWith("hash-sidekick-1", { disabled: true });
    expect(harness.updateCredential).toHaveBeenCalledWith({
      where: { id: "credential-sidekick-1" },
      data: {
        status: "disabled",
        disabledAt: new Date("2026-08-30T12:00:00.000Z"),
      },
    });
    expect(harness.deleteCredential).not.toHaveBeenCalled();
  });

  it("does not re-enable a Sidekick key while the client entitlement is inactive", async () => {
    const harness = lifecycleHarness({ initialStatus: "paused", commercialStatus: "paused" });

    await expect(
      setBrandwellSidekickLifecycleWithPrisma(
        "portal-sidekick-1",
        "resume",
        harness.request("resume-sidekick-0001"),
      ),
    ).rejects.toMatchObject({ code: "workspace_inactive", statusCode: 409 });
    expect(harness.updateKey).not.toHaveBeenCalled();
    expect(harness.updateCredential).not.toHaveBeenCalled();
  });

  it("retries a provider failure from the durable fail-closed state", async () => {
    const harness = lifecycleHarness();
    harness.updateKey.mockRejectedValueOnce(new Error("provider unavailable"));
    const request = harness.request("pause-retry-provider-0001");

    await expect(
      setBrandwellSidekickLifecycleWithPrisma("portal-sidekick-1", "pause", request),
    ).rejects.toMatchObject({ code: "sidekick_lifecycle_pending", statusCode: 503 });
    expect(harness.store.sidekick.status).toBe("paused");
    expect(harness.store.bot.managedStatus).toBe("paused");
    expect(harness.store.credential?.status).toBe("disabled");
    expect(harness.store.operation).toMatchObject({
      status: "failed",
      providerStatus: "pending",
      computerStatus: "completed",
    });
    expect(harness.stop).toHaveBeenCalledOnce();
    expect(harness.store.audits).toHaveLength(0);
    await expect(
      setBrandwellSidekickLifecycleWithPrisma(
        "portal-sidekick-1",
        "pause",
        harness.request("pause-retry-wrong-key-0001"),
      ),
    ).rejects.toMatchObject({ code: "sidekick_lifecycle_busy", statusCode: 409 });

    await expect(
      setBrandwellSidekickLifecycleWithPrisma("portal-sidekick-1", "pause", request),
    ).resolves.toMatchObject({ status: "paused", replayed: false });
    expect(harness.updateKey).toHaveBeenCalledTimes(2);
    expect(harness.stop).toHaveBeenCalledOnce();
    expect(harness.store.operation).toMatchObject({ status: "completed", attempts: 2 });
    expect(harness.store.audits).toHaveLength(1);
  });

  it("retries a computer failure without repeating completed provider work", async () => {
    const harness = lifecycleHarness();
    harness.stop
      .mockImplementationOnce(async (input) => {
        await input.markCheckpointed();
        throw new Error("sandbox stop unavailable");
      })
      .mockImplementationOnce(async () => undefined);
    const request = harness.request("pause-retry-computer-0001");

    await expect(
      setBrandwellSidekickLifecycleWithPrisma("portal-sidekick-1", "pause", request),
    ).rejects.toMatchObject({ code: "sidekick_lifecycle_pending", statusCode: 503 });
    expect(harness.store.operation).toMatchObject({
      status: "failed",
      providerStatus: "completed",
      computerStatus: "checkpointed",
    });

    await setBrandwellSidekickLifecycleWithPrisma("portal-sidekick-1", "pause", request);
    expect(harness.updateKey).toHaveBeenCalledOnce();
    expect(harness.stop).toHaveBeenCalledTimes(2);
    expect(harness.stop.mock.calls[1]?.[0]).toMatchObject({ checkpointRequired: false });
    expect(harness.store.audits).toHaveLength(1);
  });

  it("replays the stored result with no provider, computer, lease, or audit side effect", async () => {
    const harness = lifecycleHarness();
    const request = harness.request("pause-replay-exact-0001");
    await setBrandwellSidekickLifecycleWithPrisma("portal-sidekick-1", "pause", request);
    const providerCalls = harness.updateKey.mock.calls.length;
    const computerCalls = harness.stop.mock.calls.length;
    const leaseCalls = harness.leaseUpdateMany.mock.calls.length;
    harness.store.sidekick.status = "canceled";

    await expect(
      setBrandwellSidekickLifecycleWithPrisma("portal-sidekick-1", "pause", request),
    ).resolves.toEqual({
      sidekickId: "sidekick-1",
      status: "paused",
      botId: "bot-sidekick-1",
      computerId: "computer-sidekick-1",
      replayed: true,
    });
    expect(harness.updateKey).toHaveBeenCalledTimes(providerCalls);
    expect(harness.stop).toHaveBeenCalledTimes(computerCalls);
    expect(harness.leaseUpdateMany).toHaveBeenCalledTimes(leaseCalls);
    expect(harness.store.audits).toHaveLength(1);
  });

  it("compensates a failed resume finalization and converges on retry", async () => {
    const harness = lifecycleHarness({ initialStatus: "paused", auditFailures: 1 });
    const request = harness.request("resume-compensate-0001");

    await expect(
      setBrandwellSidekickLifecycleWithPrisma("portal-sidekick-1", "resume", request),
    ).rejects.toMatchObject({ code: "sidekick_lifecycle_pending", statusCode: 503 });
    expect(harness.store.sidekick.status).toBe("paused");
    expect(harness.updateKey.mock.calls.map((call) => call[1])).toEqual([
      { disabled: false },
      { disabled: true },
    ]);
    expect(harness.store.operation).toMatchObject({
      status: "failed",
      providerStatus: "pending",
    });
    expect(harness.store.audits).toHaveLength(0);

    await expect(
      setBrandwellSidekickLifecycleWithPrisma("portal-sidekick-1", "resume", request),
    ).resolves.toMatchObject({ status: "active" });
    expect(harness.updateKey.mock.calls.map((call) => call[1])).toEqual([
      { disabled: false },
      { disabled: true },
      { disabled: false },
    ]);
    expect(harness.store.audits).toHaveLength(1);
  });

  it("treats cancellation as terminal and rejects other actions without effects", async () => {
    const harness = lifecycleHarness({ initialStatus: "canceled" });

    await expect(
      setBrandwellSidekickLifecycleWithPrisma(
        "portal-sidekick-1",
        "pause",
        harness.request("pause-canceled-0001"),
      ),
    ).rejects.toMatchObject({ code: "sidekick_canceled", statusCode: 409 });
    await expect(
      setBrandwellSidekickLifecycleWithPrisma(
        "portal-sidekick-1",
        "cancel",
        harness.request("cancel-canceled-0001"),
      ),
    ).resolves.toMatchObject({ status: "canceled", replayed: true });
    expect(harness.updateKey).not.toHaveBeenCalled();
    expect(harness.deleteKey).not.toHaveBeenCalled();
    expect(harness.stop).not.toHaveBeenCalled();
    expect(harness.store.audits).toHaveLength(0);
  });

  it("fails before provider or computer effects when the workspace policy lease is held", async () => {
    const harness = lifecycleHarness({ leaseBusy: true });

    await expect(
      setBrandwellSidekickLifecycleWithPrisma(
        "portal-sidekick-1",
        "pause",
        harness.request("pause-policy-busy-0001"),
      ),
    ).rejects.toMatchObject({ code: "model_policy_busy", statusCode: 409 });
    expect(harness.store.sidekick.status).toBe("active");
    expect(harness.updateKey).not.toHaveBeenCalled();
    expect(harness.stop).not.toHaveBeenCalled();
  });

  it.each([
    [4, "skill_bundle_unavailable"],
    [5, "model_policy_busy"],
    [6, "model_policy_busy"],
    [7, "model_policy_busy"],
    [8, "model_policy_busy"],
    [9, "model_policy_busy"],
    [BRANDWELL_AIMEE_SKILL_BUNDLE_VERSION + 1, "skill_bundle_unavailable"],
  ] as const)(
    "validates rollout compatibility for skill bundle %s",
    async (skillBundleVersion, expectedCode) => {
      const updateKey = vi.fn();
      const prisma = {
        brandwellAiWorkspace: {
          findFirst: vi.fn(async () => ({
            id: "mapping-1",
            rakazoWorkspaceId: "workspace-1",
            commercialRevision: 1n,
            commercialStatus: "active",
          })),
          updateMany: vi.fn(async () => ({ count: 0 })),
        },
      } as unknown as PrismaClient;

      await expect(
        syncBrandwellWorkspaceDesiredStateWithPrisma(
          "workspace-1",
          {
            revision: 2n,
            agencyId: "agency-1",
            clientId: "client-1",
            primaryBrandwellUserId: "brandwell-user-master",
            status: "paused",
            plan: "aimee",
            masterSeats: 1,
            sidekickSeats: 1,
            skillBundleVersion,
          },
          prisma,
          { updateKey },
        ),
      ).rejects.toMatchObject({ code: expectedCode, statusCode: 409 });
      expect(updateKey).not.toHaveBeenCalled();
    },
  );

  it("installs the current managed skills when a same-revision desired state upgrades the bundle", async () => {
    const mapping = {
      id: "mapping-1",
      rakazoWorkspaceId: "workspace-1",
      commercialRevision: 7n,
      commercialStatus: "active",
      skillBundleVersion: BRANDWELL_AIMEE_SKILL_BUNDLE_VERSION - 1,
      timezone: "UTC",
      serviceIdentityId: "service-1",
    };
    const createdSkills: Array<{ managedKey: string; managedVersion: number }> = [];
    const prisma = {
      brandwellAiWorkspace: {
        findFirst: vi.fn(async () => ({ ...mapping })),
        updateMany: vi.fn(async () => ({ count: 1 })),
        update: vi.fn(async ({ data }: { data: { skillBundleVersion: number } }) => {
          mapping.skillBundleVersion = data.skillBundleVersion;
          return { ...mapping };
        }),
      },
      brandwellSidekick: {
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      bot: {
        findMany: vi.fn(async () => [
          { id: "bot-1", userId: "managed-user-1", serviceIdentityId: "service-1" },
        ]),
      },
      routine: {
        findMany: vi.fn(async () => []),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: `routine-${String(data.name)}`,
          ...data,
        })),
        update: vi.fn(),
      },
      agentSkill: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(
          async ({ data }: { data: { managedKey: string; managedVersion: number } }) => {
            createdSkills.push({
              managedKey: data.managedKey,
              managedVersion: data.managedVersion,
            });
            return { id: `skill-${createdSkills.length}`, ...data };
          },
        ),
        update: vi.fn(),
      },
      $transaction: vi.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
    } as unknown as PrismaClient;

    await expect(
      syncBrandwellWorkspaceDesiredStateWithPrisma(
        "workspace-1",
        {
          revision: 7n,
          agencyId: "agency-1",
          clientId: "client-1",
          primaryBrandwellUserId: "brandwell-user-master",
          status: "active",
          plan: "aimee",
          masterSeats: 1,
          sidekickSeats: 1,
          skillBundleVersion: BRANDWELL_AIMEE_SKILL_BUNDLE_VERSION,
        },
        prisma,
      ),
    ).resolves.toMatchObject({
      replayed: false,
      mapping: { skillBundleVersion: BRANDWELL_AIMEE_SKILL_BUNDLE_VERSION },
    });
    expect(createdSkills).toHaveLength(21);
    expect(
      createdSkills.every((skill) => skill.managedVersion === BRANDWELL_AIMEE_SKILL_BUNDLE_VERSION),
    ).toBe(true);
  });

  it("does not recreate a key for a canceled Sidekick provisioning identity", async () => {
    const createKey = vi.fn();
    const prisma = {
      brandwellAiWorkspace: {
        findFirst: vi.fn(async () => ({ id: "mapping-1" })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      brandwellSidekick: {
        findUnique: vi.fn(async () => ({
          id: "sidekick-1",
          aiWorkspaceId: "mapping-1",
          email: "casey@example.com",
          status: "canceled",
          modelCredential: null,
          bot: null,
          computer: null,
        })),
      },
    } as unknown as PrismaClient;

    await expect(
      provisionBrandwellSidekickWithPrisma(
        "workspace-1",
        {
          brandwellSidekickId: "portal-sidekick-1",
          brandwellUserId: "brandwell-user-1",
          email: "casey@example.com",
          name: "Casey",
          roleTitle: "Sales",
          timezone: "America/Phoenix",
        },
        {
          prisma,
          secretCipher: { encrypt: vi.fn() },
          openRouter: { createKey, deleteKey: vi.fn() },
          sandboxKind: "daytona",
          defaultModel: "openai/gpt-5.4-mini",
          monthlyLimitMicros: 200_000_000n,
          warningLimitMicros: 150_000_000n,
        },
      ),
    ).rejects.toMatchObject({ code: "sidekick_canceled", statusCode: 409 });
    expect(createKey).not.toHaveBeenCalled();
  });
});
