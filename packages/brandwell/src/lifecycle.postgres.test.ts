import { randomUUID } from "node:crypto";
import { createDb, type PrismaClient } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BrandwellManagedRunBlockedError,
  cancelBrandwellWorkspaceWithPrisma,
  createBrandwellManagedModelResolver,
  deliverPendingBrandwellClientNotifications,
  provisionBrandwellWorkspaceWithPrisma,
  reconcileBrandwellFleetHealth,
  reconcileBrandwellRetentionCleanupWithPrisma,
  syncBrandwellWorkspaceDesiredStateWithPrisma,
} from "./index.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;

describePostgres("BrandWell AIMEE managed lifecycle (PostgreSQL acceptance)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(() => {
    const database = createDb(databaseUrl!);
    prisma = database.prisma;
    close = async () => {
      await prisma.$disconnect();
      await database.pool.end();
    };
  });

  afterAll(async () => {
    await close?.();
  });

  it("provisions, escalates, recovers, cancels, and retires one isolated client", async () => {
    const suffix = `${Date.now()}-${randomUUID()}`;
    const customerId = `brandwell-customer-${suffix}`;
    const systemUserId = `brandwell-system-${suffix}`;
    const clientUserId = `brandwell-client-${suffix}`;
    const clientEmail = `client-${suffix}@example.test`;
    const keyHash = `openrouter-key-${suffix}`;
    const now = new Date("2026-08-27T18:00:00.000Z");
    const disableKey = vi.fn(async () => undefined);
    const deleteKey = vi.fn(async () => undefined);
    const updateKey = vi.fn(
      async (
        hash: string,
        input: { limitUsd?: number | null; limitReset?: "daily" | "weekly" | "monthly" | null },
      ) => ({
        hash,
        disabled: false,
        usageUsd: 0,
        usageDailyUsd: 0,
        usageMonthlyUsd: 0,
        limitUsd: input.limitUsd ?? undefined,
        limitReset: input.limitReset ?? undefined,
        includeByokInLimit: true,
      }),
    );
    const createKey = vi.fn(
      async (input: { limitUsd?: number; limitReset?: "daily" | "weekly" | "monthly" }) => ({
        key: `sk-or-${suffix}`,
        hash: keyHash,
        limitUsd: input.limitUsd,
        limitReset: input.limitReset,
      }),
    );
    const getModel = vi.fn(async (id: string) => ({
      id,
      name: id,
      inputModalities: id === "anthropic/claude-sonnet-4.6" ? ["text", "image"] : ["text"],
      outputModalities: ["text"],
      supportedParameters: ["tools"],
      reasoning: false,
      pricing: {},
    }));
    const suspend = vi.fn(async () => undefined);
    const destroy = vi.fn(async () => undefined);
    let workspaceId: string | null = null;

    await prisma.user.createMany({
      data: [
        {
          id: systemUserId,
          name: "BrandWell System",
          email: `system-${suffix}@example.test`,
          emailVerified: true,
        },
        {
          id: clientUserId,
          name: "Alex Client",
          email: clientEmail,
          emailVerified: true,
        },
      ],
    });

    try {
      const provisioned = await provisionBrandwellWorkspaceWithPrisma(
        {
          brandwellCustomerId: customerId,
          companyName: `Acme Roofing ${suffix}`,
          primaryContactName: "Alex Client",
          primaryContactEmail: clientEmail,
          plan: "aimee",
          timezone: "America/Phoenix",
        },
        {
          prisma,
          secretCipher: {
            encrypt: async (plaintext, context) =>
              `encrypted:${context.workspaceId}:${context.userId}:${plaintext.length}`,
          },
          openRouter: {
            createKey,
            deleteKey,
            getModel,
            updateKey,
          },
          systemUserId,
          sandboxKind: "fake",
          defaultModel: "openai/gpt-5.4",
          computerModel: "anthropic/claude-sonnet-4.6",
          lightweightModel: "openai/gpt-5.4-mini",
          reasoningModel: "openai/gpt-5.4",
          fallbackModels: ["anthropic/claude-sonnet-4.6"],
          monthlyLimitMicros: 200_000_000n,
          warningLimitMicros: 150_000_000n,
          dailyLimitMicros: 25_000_000n,
          now: () => now,
        },
      );

      expect(provisioned.status).toBe("complete");
      expect(provisioned.steps.every((step) => step.status === "completed")).toBe(true);
      expect(createKey).toHaveBeenCalledOnce();
      expect(createKey.mock.calls[0]?.[0]).not.toHaveProperty("workspaceId");

      const mapping = await prisma.brandwellAiWorkspace.findUniqueOrThrow({
        where: { brandwellCustomerId: customerId },
        include: {
          rakazoWorkspace: {
            include: {
              bots: { where: { managedByBrandWell: true }, include: { thread: true } },
              routines: true,
              connections: true,
              notificationPreferences: true,
            },
          },
        },
      });
      workspaceId = mapping.rakazoWorkspaceId;
      const bot = mapping.rakazoWorkspace.bots[0];
      expect(mapping).toMatchObject({
        subscriptionStatus: "pending_entitlement",
        provisioningStatus: "complete",
        primaryContactEmail: clientEmail,
      });
      expect(bot).toMatchObject({
        ownerType: "workspace",
        visibility: "workspace",
        managedByBrandWell: true,
        managedStatus: "active",
      });
      expect(bot?.thread).not.toBeNull();
      expect(mapping.rakazoWorkspace.routines).toHaveLength(4);
      expect(mapping.rakazoWorkspace.routines.every((routine) => !routine.active)).toBe(true);
      expect(mapping.rakazoWorkspace.connections.map((item) => item.provider).sort()).toEqual([
        "brandwell-intent",
        "brandwell-postcards",
        "brandwell-trafficid",
      ]);
      expect(mapping.rakazoWorkspace.notificationPreferences).toEqual([
        expect.objectContaining({ userId: clientUserId, finish: true, help: true, takeover: true }),
      ]);

      await syncBrandwellWorkspaceDesiredStateWithPrisma(
        workspaceId,
        {
          revision: 1n,
          agencyId: `agency-${suffix}`,
          clientId: customerId,
          status: "active",
          plan: "aimee",
          masterSeats: 1,
          sidekickSeats: 0,
          skillBundleVersion: 1,
        },
        prisma,
      );

      const model = await createBrandwellManagedModelResolver(prisma)({
        workspaceId,
        userId: clientUserId,
        botId: bot!.id,
        workloadType: "computer",
      });
      expect(model).toMatchObject({
        provider: "openrouter",
        id: "anthropic/claude-sonnet-4.6",
        serviceIdentityId: mapping.serviceIdentityId,
      });
      expect(model?.secretId).toBeTruthy();
      expect(JSON.stringify(model)).not.toContain(`sk-or-${suffix}`);

      const routine = mapping.rakazoWorkspace.routines[0]!;
      await prisma.routine.update({
        where: { id: routine.id },
        data: { active: true, nextRunAt: new Date(now.getTime() + 60 * 60_000) },
      });
      const task = await prisma.task.create({
        data: {
          workspaceId,
          botId: bot!.id,
          threadId: bot!.thread!.id,
          userId: systemUserId,
          prompt: "Run the scheduled buyer follow-up.",
          status: "running",
        },
      });
      const run = await prisma.run.create({
        data: {
          workspaceId,
          botId: bot!.id,
          threadId: bot!.thread!.id,
          taskId: task.id,
          userId: systemUserId,
          serviceIdentityId: mapping.serviceIdentityId,
          routineId: routine.id,
          status: "waiting_takeover",
          trigger: "routine",
          modelProvider: model!.provider,
          modelId: model!.id,
        },
      });

      const escalated = await reconcileBrandwellFleetHealth(prisma, now);
      expect(escalated).toMatchObject({ notifications: 1 });
      const alert = await prisma.brandwellAlert.findUniqueOrThrow({
        where: {
          workspaceId_dedupeKey: {
            workspaceId,
            dedupeKey: `${workspaceId}:LOGIN_REQUIRED:${run.id}`,
          },
        },
      });
      expect(alert).toMatchObject({
        type: "LOGIN_REQUIRED",
        status: "OPEN",
        clientActionRequired: true,
      });

      const delivered: Array<Record<string, unknown>> = [];
      const delivery = await deliverPendingBrandwellClientNotifications(
        prisma,
        async (message) => {
          delivered.push(message);
        },
        { workerId: `acceptance-${suffix}`, now: new Date(now.getTime() + 60_000) },
      );
      expect(delivery).toMatchObject({ sent: 1, retry: 0 });
      expect(delivered).toEqual([
        expect.objectContaining({
          workspaceId,
          userId: clientUserId,
          botId: bot!.id,
          kind: "takeover",
          actionTarget: `/computer?botId=${bot!.id}`,
        }),
      ]);

      await prisma.run.update({
        where: { id: run.id },
        data: { status: "completed", completedAt: new Date(now.getTime() + 5 * 60_000) },
      });
      await prisma.task.update({ where: { id: task.id }, data: { status: "completed" } });
      const recovered = await reconcileBrandwellFleetHealth(
        prisma,
        new Date(now.getTime() + 6 * 60_000),
      );
      expect(recovered.resolved).toBe(1);
      expect(
        await prisma.brandwellAlert.findUniqueOrThrow({ where: { id: alert.id } }),
      ).toMatchObject({ status: "RESOLVED" });
      expect(
        await prisma.brandwellClientNotification.findFirstOrThrow({
          where: { workspaceId, runId: run.id },
        }),
      ).toMatchObject({ resolvedBy: "brandwell_health_reconciler" });

      const computer = await prisma.computer.findFirstOrThrow({ where: { workspaceId } });
      await prisma.computer.update({
        where: { id: computer.id },
        data: { providerRef: `fake-computer-${suffix}`, state: "running" },
      });
      const canceled = await cancelBrandwellWorkspaceWithPrisma(
        customerId,
        "Acceptance test cancellation",
        { retentionDays: 0, deleteAfterRetention: true },
        {
          prisma,
          openRouter: { disableKey, deleteKey },
          computerLifecycle: { suspend, destroy },
          now: () => new Date(now.getTime() + 10 * 60_000),
        },
      );
      expect(canceled.executed).toEqual([
        "mark_canceling",
        "pause_routines",
        "block_new_runs",
        "disable_openrouter",
        "suspend_computer",
      ]);
      expect(disableKey).toHaveBeenCalledWith(keyHash);
      expect(suspend).toHaveBeenCalledOnce();
      await expect(
        createBrandwellManagedModelResolver(prisma)({
          workspaceId,
          userId: clientUserId,
          botId: bot!.id,
        }),
      ).rejects.toBeInstanceOf(BrandwellManagedRunBlockedError);

      const retired = await reconcileBrandwellRetentionCleanupWithPrisma(
        {
          prisma,
          openRouter: { disableKey, deleteKey },
          computerLifecycle: { suspend, destroy },
          now: () => new Date(now.getTime() + 10 * 60_000),
        },
        { retentionDays: 0, deleteAfterRetention: true },
      );
      expect(retired).toEqual([
        {
          workspaceId,
          executed: [
            "delete_openrouter",
            "revoke_connectors",
            "destroy_computer",
            "delete_secrets",
            "archive_workspace",
          ],
        },
      ]);
      expect(deleteKey).toHaveBeenCalledWith(keyHash);
      expect(destroy).toHaveBeenCalledOnce();
      expect(
        await prisma.brandwellAiWorkspace.findUniqueOrThrow({
          where: { brandwellCustomerId: customerId },
        }),
      ).toMatchObject({ subscriptionStatus: "canceled" });
      expect(await prisma.connection.count({ where: { workspaceId, status: "revoked" } })).toBe(3);
      expect(await prisma.brandwellWorkspaceModelCredential.count({ where: { workspaceId } })).toBe(
        0,
      );
      expect(await prisma.secret.count({ where: { workspaceId, ownerType: "service" } })).toBe(0);
      expect(await prisma.bot.count({ where: { workspaceId, archivedAt: { not: null } } })).toBe(1);
    } finally {
      if (workspaceId) {
        await prisma.organization.deleteMany({ where: { id: workspaceId } });
      }
      await prisma.user.deleteMany({ where: { id: { in: [systemUserId, clientUserId] } } });
    }
  });
});
