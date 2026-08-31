import { BRANDWELL_PROVISIONING_STEPS } from "@brandwell/aimee";
import type { PrismaClient } from "@rakazo/db";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  constantTimeBearerMatches,
  mountBrandwellManagementRoutes,
  supportActor,
} from "./brandwell-management.js";

const OPERATOR_HEADERS = {
  "x-brandwell-operator-ref": "user:42",
  "x-brandwell-operator-name": "Test Operator",
  "x-brandwell-operator-email": "operator@example.test",
} as const;

describe("BrandWell management API authentication", () => {
  it("matches only an exact bearer token", () => {
    expect(constantTimeBearerMatches("Bearer management-secret", "management-secret")).toBe(true);
    expect(constantTimeBearerMatches("Bearer management-secrex", "management-secret")).toBe(false);
    expect(constantTimeBearerMatches("Bearer short", "management-secret")).toBe(false);
    expect(constantTimeBearerMatches(undefined, "management-secret")).toBe(false);
  });

  it("rejects unauthenticated requests before touching tenant data", async () => {
    const findFirst = vi.fn();
    const app = new Hono();
    mountBrandwellManagementRoutes(app, {
      token: "management-secret",
      prisma: {
        brandwellAiWorkspace: { findFirst },
      } as unknown as PrismaClient,
    });

    const response = await app.request("/internal/workspaces/customer-acme");
    expect(response.status).toBe(401);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("requires a traceable BrandWell operator for computer support", async () => {
    expect(
      supportActor({
        "x-brandwell-operator-ref": "user:42",
        "x-brandwell-operator-name": "Test Operator",
        "x-brandwell-operator-email": "operator@example.test",
      }),
    ).toEqual({
      ok: true,
      value: {
        reference: "user:42",
        name: "Test Operator",
        email: "operator@example.test",
      },
    });
    expect(supportActor({})).toEqual({
      ok: false,
      error: "A valid BrandWell operator reference is required",
    });
  });

  it("returns a tenant-safe not-found response after authentication", async () => {
    const app = new Hono();
    mountBrandwellManagementRoutes(app, {
      token: "management-secret",
      prisma: {
        brandwellAiWorkspace: { findFirst: vi.fn().mockResolvedValue(null) },
      } as unknown as PrismaClient,
    });

    const response = await app.request("/internal/workspaces/customer-acme", {
      headers: { authorization: "Bearer management-secret" },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Workspace not found" });
  });

  it("returns binding coordinates only to the authenticated BrandWell service", async () => {
    const findFirst = vi.fn(async () => ({
      id: "mapping-1",
      brandwellCustomerId: "portal-client:19",
      rakazoWorkspaceId: "workspace-1",
      serviceIdentityId: "service-1",
      subscriptionStatus: "active",
      provisioningStatus: "complete",
      rakazoWorkspace: { name: "Acme", slug: "acme" },
    }));
    const app = new Hono();
    mountBrandwellManagementRoutes(app, {
      token: "management-secret",
      prisma: {
        brandwellAiWorkspace: { findFirst },
      } as unknown as PrismaClient,
    });

    const response = await app.request("/internal/workspaces/mapping-1/binding", {
      headers: { authorization: "Bearer management-secret" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      brandwellCustomerId: "portal-client:19",
      workspaceId: "workspace-1",
      serviceIdentityId: "service-1",
      subscriptionStatus: "active",
      provisioningStatus: "complete",
    });
  });

  it("returns each Sidekick as an AI employee with its own operational stats", async () => {
    const now = new Date("2026-08-30T18:00:00.000Z");
    const sidekickBot = {
      id: "bot-sidekick-1",
      name: "Jordan's AIMEE",
      title: "Demand Generation Sidekick",
      description: "Private AI employee",
      instructions: "Help Jordan with demand generation.",
      managedStatus: "active",
      computerId: "computer-sidekick-1",
      updatedAt: now,
    };
    const sidekickComputer = {
      id: "computer-sidekick-1",
      state: "running",
      scope: "bot",
      kind: "daytona",
      controlHolder: "none",
      controlActorType: null,
      controlActorName: null,
      controlStartedAt: null,
      lastScreenshotAt: now,
      lastComputerActivityAt: now,
      lastComputerState: "running",
      updatedAt: now,
    };
    const app = new Hono();
    mountBrandwellManagementRoutes(app, {
      token: "management-secret",
      prisma: {
        brandwellAiWorkspace: {
          findMany: vi.fn(async () => [
            {
              id: "mapping-1",
              brandwellCustomerId: "portal-client:19",
              rakazoWorkspaceId: "workspace-1",
              rakazoWorkspace: { name: "Acme", slug: "acme" },
              subscriptionStatus: "active",
              brandwellAgencyId: "7",
              brandwellClientId: "19",
              brandwellContractId: "31",
              commercialRevision: 5n,
              commercialStatus: "active",
              masterSeats: 1,
              sidekickSeats: 2,
              skillBundleVersion: 1,
              plan: "aimee",
              provisioningStatus: "ready",
            },
          ]),
        },
        bot: {
          findMany: vi.fn(async () => [
            { ...sidekickBot, id: "bot-primary", workspaceId: "workspace-1" },
          ]),
        },
        computer: {
          findMany: vi.fn(async () => [{ ...sidekickComputer, workspaceId: "workspace-1" }]),
        },
        run: {
          findMany: vi.fn(async (args) =>
            args.where.botId
              ? [
                  {
                    id: "run-sidekick-1",
                    botId: sidekickBot.id,
                    status: "completed",
                    completedAt: now,
                    createdAt: now,
                  },
                ]
              : [],
          ),
        },
        routine: {
          findMany: vi.fn(async (args) =>
            args.where.botId ? [{ botId: sidekickBot.id, nextRunAt: now }] : [],
          ),
        },
        brandwellAlert: {
          groupBy: vi.fn(async (args) =>
            args.by.includes("workspaceId")
              ? [{ workspaceId: "workspace-1", _count: { id: 1 } }]
              : [{ botId: sidekickBot.id, _count: { id: 2 } }],
          ),
        },
        usageRecord: {
          groupBy: vi.fn(async (args) =>
            args.by.includes("workspaceId")
              ? [
                  {
                    workspaceId: "workspace-1",
                    _sum: { inputTokens: 10, outputTokens: 20, costMicros: 30n },
                    _count: { id: 1 },
                  },
                ]
              : [
                  {
                    botId: sidekickBot.id,
                    _sum: { inputTokens: 100, outputTokens: 200, costMicros: 300n },
                    _count: { id: 3 },
                  },
                ],
          ),
        },
        brandwellWorkspaceModelCredential: { findMany: vi.fn(async () => []) },
        brandwellSidekick: {
          findMany: vi.fn(async () => [
            {
              id: "sidekick-1",
              aiWorkspaceId: "mapping-1",
              brandwellSidekickId: "bw-sidekick-1",
              email: "jordan@acme.example",
              name: "Jordan Lee",
              roleTitle: "Demand Generation Manager",
              status: "active",
              userId: "user-sidekick-1",
              invitationId: null,
              skillBundleVersion: 1,
              activatedAt: now,
              pausedAt: null,
              canceledAt: null,
              createdAt: now,
              updatedAt: now,
              botId: sidekickBot.id,
              bot: sidekickBot,
              computer: sidekickComputer,
              modelCredential: {
                id: "sidekick-model-1",
                provider: "openrouter",
                status: "active",
                preferredModel: "provider/general",
                computerModel: "provider/vision",
                lightweightModel: null,
                reasoningModel: null,
                fallbackModels: ["provider/fallback"],
                maxTokens: 8192,
                thinkingLevel: "medium",
                monthlyLimitMicros: 200_000_000n,
                dailyLimitMicros: null,
                warningLimitMicros: 150_000_000n,
                currentUsageMicros: 3_000_000n,
                providerLimitMicros: 200_000_000n,
                providerUsageSyncedAt: now,
                providerUsageSyncError: null,
                disabledAt: null,
                updatedAt: now,
              },
            },
          ]),
        },
      } as unknown as PrismaClient,
    });

    const response = await app.request("/internal/workspaces", {
      headers: { authorization: "Bearer management-secret" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      workspaces: [
        {
          sidekickCount: 1,
          sidekicks: [
            {
              name: "Jordan Lee",
              employee: { id: sidekickBot.id, name: "Jordan's AIMEE" },
              computer: { id: sidekickComputer.id, state: "running" },
              lastRun: { id: "run-sidekick-1", status: "completed" },
              nextRunAt: now.toISOString(),
              openAlerts: 2,
              usage: { records: 3, inputTokens: 100, outputTokens: 200, costMicros: "300" },
              modelPolicy: {
                provider: "openrouter",
                preferredModel: "provider/general",
                monthlyLimitMicros: "200000000",
              },
            },
          ],
        },
      ],
    });
  });

  it("paginates the fleet with an opaque stable cursor", async () => {
    const firstCreatedAt = new Date("2026-08-30T18:00:00.000Z");
    const secondCreatedAt = new Date("2026-08-29T18:00:00.000Z");
    const mapping = (id: string, createdAt: Date) => ({
      id,
      createdAt,
      brandwellCustomerId: `portal-client:${id}`,
      rakazoWorkspaceId: `workspace-${id}`,
      rakazoWorkspace: { name: `Client ${id}`, slug: `client-${id}` },
      subscriptionStatus: "active",
      brandwellAgencyId: "7",
      brandwellClientId: id,
      brandwellContractId: `contract-${id}`,
      commercialRevision: 1n,
      commercialStatus: "active",
      masterSeats: 1,
      sidekickSeats: 0,
      skillBundleVersion: 1,
      plan: "aimee",
      provisioningStatus: "ready",
    });
    const first = mapping("1", firstCreatedAt);
    const second = mapping("2", secondCreatedAt);
    const findMany = vi.fn(async (args: { where?: unknown }) =>
      args.where ? [second] : [first, second],
    );
    const app = new Hono();
    mountBrandwellManagementRoutes(app, {
      token: "management-secret",
      prisma: {
        brandwellAiWorkspace: { findMany },
        bot: { findMany: vi.fn(async () => []) },
        computer: { findMany: vi.fn(async () => []) },
        run: { findMany: vi.fn(async () => []) },
        routine: { findMany: vi.fn(async () => []) },
        brandwellAlert: { groupBy: vi.fn(async () => []) },
        usageRecord: {
          groupBy: vi.fn(async () => []),
        },
        brandwellWorkspaceModelCredential: { findMany: vi.fn(async () => []) },
        brandwellSidekick: { findMany: vi.fn(async () => []) },
      } as unknown as PrismaClient,
    });

    const firstResponse = await app.request("/internal/workspaces?limit=1", {
      headers: { authorization: "Bearer management-secret" },
    });
    expect(firstResponse.status).toBe(200);
    const firstPage = await firstResponse.json();
    expect(firstPage).toMatchObject({
      workspaces: [{ id: "1" }],
      hasMore: true,
    });
    expect(firstPage.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);

    const secondResponse = await app.request(
      `/internal/workspaces?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
      { headers: { authorization: "Bearer management-secret" } },
    );
    expect(secondResponse.status).toBe(200);
    await expect(secondResponse.json()).resolves.toMatchObject({
      workspaces: [{ id: "2" }],
      hasMore: false,
      nextCursor: null,
    });
    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        take: 2,
        where: {
          OR: [
            { createdAt: { lt: firstCreatedAt } },
            { createdAt: firstCreatedAt, id: { gt: "1" } },
          ],
        },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      }),
    );

    const invalidResponse = await app.request("/internal/workspaces?cursor=not-json", {
      headers: { authorization: "Bearer management-secret" },
    });
    expect(invalidResponse.status).toBe(400);
  });

  it("validates and provisions a workspace through the internal service boundary", async () => {
    const auditCreate = vi.fn(async () => ({ id: "audit-provision" }));
    const provisionWorkspace = vi.fn(async (input) => ({
      version: 1 as const,
      idempotencyKey: `brandwell:provision:${input.brandwellCustomerId}`,
      input,
      status: "complete" as const,
      runId: "run-1",
      startedAt: "2026-08-27T12:00:00.000Z",
      updatedAt: "2026-08-27T12:00:00.000Z",
      completedAt: "2026-08-27T12:00:00.000Z",
      steps: BRANDWELL_PROVISIONING_STEPS.map((name) => ({
        name,
        status: "completed" as const,
        ...(name === "workspace" ? { resourceId: "workspace-acme" } : {}),
        ...(name === "primary_aimee" ? { resourceId: "bot-aimee" } : {}),
        ...(name === "client_admin_membership"
          ? { resourceId: "invite-1", metadata: { kind: "invitation" } }
          : {}),
      })),
    }));
    const app = new Hono();
    mountBrandwellManagementRoutes(app, {
      token: "management-secret",
      prisma: { brandwellAuditLog: { create: auditCreate } } as unknown as PrismaClient,
      provisionWorkspace,
    });

    const response = await app.request("/internal/workspaces/provision", {
      method: "POST",
      headers: {
        authorization: "Bearer management-secret",
        "content-type": "application/json",
        "x-brandwell-operator-ref": "user:42",
        "x-brandwell-operator-name": "Jordan Support",
        "x-brandwell-operator-email": "jordan@brandwell.ai",
      },
      body: JSON.stringify({
        brandwellCustomerId: "customer-acme",
        companyName: "Acme Roofing",
        primaryContactName: "Alex",
        primaryContactEmail: "alex@example.com",
        plan: "aimee",
        timezone: "America/Phoenix",
      }),
    });

    expect(response.status).toBe(200);
    expect(provisionWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ brandwellCustomerId: "customer-acme", plan: "aimee" }),
    );
    expect(await response.json()).toMatchObject({
      status: "complete",
      workspaceId: "workspace-acme",
      botId: "bot-aimee",
      clientAccess: { kind: "invitation", resourceId: "invite-1" },
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-acme",
        actorType: "brandwell_operator",
        action: "workspace.provision",
        resourceId: "customer-acme",
        metadata: expect.objectContaining({
          operatorReference: "user:42",
          operatorName: "Jordan Support",
          operatorEmail: "jordan@brandwell.ai",
        }),
      }),
    });
  });

  it("does not expose provisioning when OpenRouter management is unavailable", async () => {
    const app = new Hono();
    mountBrandwellManagementRoutes(app, {
      token: "management-secret",
      prisma: {} as PrismaClient,
    });
    const response = await app.request("/internal/workspaces/provision", {
      method: "POST",
      headers: { authorization: "Bearer management-secret" },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "AIMEE provisioning is not configured" });
  });

  it("synchronizes a versioned commercial entitlement before Sidekick provisioning", async () => {
    const syncDesiredState = vi.fn(async (_workspaceId, input) => ({
      mapping: { commercialRevision: input.revision },
      replayed: false,
    }));
    const auditCreate = vi.fn(async () => ({ id: "audit-entitlement" }));
    const app = new Hono();
    mountBrandwellManagementRoutes(app, {
      token: "management-secret",
      prisma: {
        brandwellAiWorkspace: {
          findFirst: vi.fn(async () => ({
            id: "mapping-1",
            rakazoWorkspaceId: "workspace-1",
            rakazoWorkspace: { name: "Acme", slug: "acme" },
          })),
        },
        brandwellAuditLog: { create: auditCreate },
      } as unknown as PrismaClient,
      syncDesiredState,
    });
    const response = await app.request("/internal/workspaces/customer-acme/desired-state", {
      method: "PUT",
      headers: {
        authorization: "Bearer management-secret",
        "content-type": "application/json",
        ...OPERATOR_HEADERS,
      },
      body: JSON.stringify({
        revision: "7",
        agencyId: "42",
        clientId: "99",
        contractId: "contract-5",
        status: "active",
        plan: "aimee",
        masterSeats: 1,
        sidekickSeats: 3,
        skillBundleVersion: 1,
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, revision: "7", replayed: false });
    expect(syncDesiredState).toHaveBeenCalledWith(
      "customer-acme",
      expect.objectContaining({ revision: 7n, sidekickSeats: 3, status: "active" }),
    );
    expect(auditCreate).toHaveBeenCalled();
  });

  it("provisions a private Sidekick through the managed service boundary", async () => {
    const provisionSidekick = vi.fn(async (_workspaceId, input) => ({
      id: "sidekick-1",
      brandwellSidekickId: input.brandwellSidekickId,
      status: "invited",
      botId: "bot-sidekick-1",
      computerId: "computer-sidekick-1",
    }));
    const auditCreate = vi.fn(async () => ({ id: "audit-sidekick" }));
    const app = new Hono();
    mountBrandwellManagementRoutes(app, {
      token: "management-secret",
      prisma: {
        brandwellAiWorkspace: {
          findFirst: vi.fn(async () => ({
            id: "mapping-1",
            rakazoWorkspaceId: "workspace-1",
            rakazoWorkspace: { name: "Acme", slug: "acme" },
          })),
        },
        brandwellAuditLog: { create: auditCreate },
      } as unknown as PrismaClient,
      provisionSidekick,
    });
    const response = await app.request("/internal/workspaces/customer-acme/sidekicks", {
      method: "POST",
      headers: {
        authorization: "Bearer management-secret",
        "content-type": "application/json",
        ...OPERATOR_HEADERS,
      },
      body: JSON.stringify({
        brandwellSidekickId: "portal-sidekick:101",
        email: "sam@example.com",
        name: "Sam Lee",
        roleTitle: "Demand Generation Manager",
        timezone: "America/Phoenix",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "invited",
      botId: "bot-sidekick-1",
      computerId: "computer-sidekick-1",
    });
    expect(provisionSidekick).toHaveBeenCalledWith(
      "customer-acme",
      expect.objectContaining({
        brandwellSidekickId: "portal-sidekick:101",
        email: "sam@example.com",
      }),
    );
    expect(auditCreate).toHaveBeenCalled();
  });

  it("requires lifecycle idempotency before invoking the Sidekick orchestrator", async () => {
    const setSidekickLifecycle = vi.fn();
    const app = new Hono();
    mountBrandwellManagementRoutes(app, {
      token: "management-secret",
      prisma: {} as PrismaClient,
      setSidekickLifecycle,
    });

    const response = await app.request("/internal/sidekicks/sidekick-1/pause", {
      method: "POST",
      headers: { authorization: "Bearer management-secret", ...OPERATOR_HEADERS },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "A valid x-idempotency-key header is required",
    });
    expect(setSidekickLifecycle).not.toHaveBeenCalled();
  });

  it("forwards lifecycle identity and leaves exact-once audit ownership to the orchestrator", async () => {
    const setSidekickLifecycle = vi.fn(async () => ({
      sidekickId: "sidekick-1",
      status: "paused",
      replayed: false,
    }));
    const auditCreate = vi.fn();
    const app = new Hono();
    mountBrandwellManagementRoutes(app, {
      token: "management-secret",
      prisma: { brandwellAuditLog: { create: auditCreate } } as unknown as PrismaClient,
      setSidekickLifecycle,
    });

    const response = await app.request("/internal/sidekicks/sidekick-1/pause", {
      method: "POST",
      headers: {
        authorization: "Bearer management-secret",
        "x-idempotency-key": "pause-sidekick-0001",
        ...OPERATOR_HEADERS,
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "paused", replayed: false });
    expect(setSidekickLifecycle).toHaveBeenCalledWith("sidekick-1", "pause", {
      idempotencyKey: "pause-sidekick-0001",
      auditMetadata: {
        operatorReference: "user:42",
        operatorName: "Test Operator",
        operatorEmail: "operator@example.test",
      },
    });
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("starts cancellation without exposing provider details", async () => {
    const auditCreate = vi.fn(async () => ({ id: "audit-cancel" }));
    const cancelWorkspace = vi.fn(async () => ({
      retentionEndsAt: new Date("2026-09-26T12:00:00.000Z"),
      executed: ["mark_canceling", "pause_routines"],
    }));
    const app = new Hono();
    mountBrandwellManagementRoutes(app, {
      token: "management-secret",
      prisma: {
        brandwellAiWorkspace: {
          findFirst: vi.fn(async () => ({
            id: "mapping-acme",
            brandwellCustomerId: "customer-acme",
            rakazoWorkspaceId: "workspace-acme",
            rakazoWorkspace: { name: "Acme Roofing", slug: "acme-roofing" },
          })),
        },
        brandwellAuditLog: { create: auditCreate },
      } as unknown as PrismaClient,
      cancelWorkspace,
    });
    const response = await app.request("/internal/workspaces/customer-acme/cancel", {
      method: "POST",
      headers: {
        authorization: "Bearer management-secret",
        "content-type": "application/json",
        "x-brandwell-operator-ref": "user:42",
        "x-brandwell-operator-name": "Jordan Support",
        "x-brandwell-operator-email": "jordan@brandwell.ai",
      },
      body: JSON.stringify({ reason: "Subscription ended" }),
    });
    expect(response.status).toBe(200);
    expect(cancelWorkspace).toHaveBeenCalledWith("customer-acme", "Subscription ended");
    expect(await response.json()).toEqual({
      status: "canceling",
      retentionEndsAt: "2026-09-26T12:00:00.000Z",
      executed: ["mark_canceling", "pause_routines"],
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-acme",
        actorType: "brandwell_operator",
        action: "workspace.cancel.request",
        resourceId: "mapping-acme",
        metadata: expect.objectContaining({
          reason: "Subscription ended",
          retentionEndsAt: "2026-09-26T12:00:00.000Z",
          operatorReference: "user:42",
        }),
      }),
    });
  });

  it("rejects lifecycle operations without an attributable BrandWell operator", async () => {
    const app = new Hono();
    mountBrandwellManagementRoutes(app, {
      token: "management-secret",
      prisma: {} as PrismaClient,
      provisionWorkspace: vi.fn(),
      cancelWorkspace: vi.fn(),
    });
    const provision = await app.request("/internal/workspaces/provision", {
      method: "POST",
      headers: { authorization: "Bearer management-secret" },
    });
    const cancel = await app.request("/internal/workspaces/customer-acme/cancel", {
      method: "POST",
      headers: { authorization: "Bearer management-secret" },
    });
    expect(provision.status).toBe(400);
    expect(cancel.status).toBe(400);
    expect(await provision.json()).toEqual({
      error: "A valid BrandWell operator reference is required",
    });
    expect(await cancel.json()).toEqual({
      error: "A valid BrandWell operator reference is required",
    });
  });

  it("runs one active managed routine with idempotency and an audit record", async () => {
    const enqueue = vi.fn(async () => undefined);
    const taskCreate = vi.fn(async () => ({ id: "task-1" }));
    const runCreate = vi.fn(async () => ({ id: "run-1", status: "queued" }));
    const auditCreate = vi.fn(async () => ({ id: "audit-1" }));
    const prisma = {
      bot: {
        findFirst: vi.fn(async () => ({
          id: "bot-1",
          workspaceId: "workspace-1",
          userId: "system-user",
          serviceIdentityId: "service-1",
          thread: { id: "thread-1" },
        })),
      },
      routine: {
        findFirst: vi.fn(async () => ({ id: "routine-1", prompt: "Run the GTM review" })),
      },
      run: { findFirst: vi.fn(async () => null) },
      $transaction: vi.fn(async (callback) =>
        callback({
          run: { findFirst: vi.fn(async () => null), create: runCreate },
          task: { create: taskCreate },
          brandwellAuditLog: { create: auditCreate },
        }),
      ),
    };
    const app = new Hono();
    mountBrandwellManagementRoutes(app, {
      token: "management-secret",
      prisma: prisma as unknown as PrismaClient,
      jobs: { enqueue } as never,
    });
    const response = await app.request("/internal/bots/bot-1/run", {
      method: "POST",
      headers: {
        authorization: "Bearer management-secret",
        "x-idempotency-key": "operator-run-0001",
        ...OPERATOR_HEADERS,
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ runId: "run-1", status: "queued", replayed: false });
    expect(taskCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: "system-user", prompt: "Run the GTM review" }),
      }),
    );
    expect(runCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          serviceIdentityId: "service-1",
          trigger: "brandwell_support",
          clientNonce: "brandwell-support:operator-run-0001",
        }),
      }),
    );
    expect(auditCreate).toHaveBeenCalled();
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorType: "brandwell_operator",
          metadata: expect.objectContaining({
            operatorReference: "user:42",
            operatorName: "Test Operator",
          }),
        }),
      }),
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "run.continue",
        payload: { runId: "run-1" },
      }),
    );
  });

  it("rejects a duplicate-prone run-now request without an idempotency key", async () => {
    const findFirst = vi.fn();
    const app = new Hono();
    mountBrandwellManagementRoutes(app, {
      token: "management-secret",
      prisma: { bot: { findFirst } } as unknown as PrismaClient,
      jobs: { enqueue: vi.fn() } as never,
    });
    const response = await app.request("/internal/bots/bot-1/run", {
      method: "POST",
      headers: { authorization: "Bearer management-secret", ...OPERATOR_HEADERS },
    });
    expect(response.status).toBe(400);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("retries only a failed managed run and preserves its execution identity", async () => {
    const enqueue = vi.fn(async () => undefined);
    const runUpdate = vi.fn(async () => ({ count: 1 }));
    const taskUpdate = vi.fn(async () => ({ id: "task-1" }));
    const auditCreate = vi.fn(async () => ({ id: "audit-1" }));
    const app = new Hono();
    mountBrandwellManagementRoutes(app, {
      token: "management-secret",
      prisma: {
        run: {
          findFirst: vi.fn(async () => ({
            id: "run-1",
            workspaceId: "workspace-1",
            taskId: "task-1",
            botId: "bot-1",
          })),
        },
        $transaction: vi.fn(async (callback) =>
          callback({
            run: { updateMany: runUpdate },
            task: { update: taskUpdate },
            brandwellAuditLog: { create: auditCreate },
          }),
        ),
      } as unknown as PrismaClient,
      jobs: { enqueue } as never,
    });
    const response = await app.request("/internal/runs/run-1/retry", {
      method: "POST",
      headers: { authorization: "Bearer management-secret", ...OPERATOR_HEADERS },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, runId: "run-1", status: "queued" });
    expect(runUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run-1", status: "failed" },
        data: expect.objectContaining({ status: "queued", error: null }),
      }),
    );
    expect(taskUpdate).toHaveBeenCalled();
    expect(auditCreate).toHaveBeenCalled();
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorType: "brandwell_operator",
          metadata: expect.objectContaining({ operatorReference: "user:42" }),
        }),
      }),
    );
    expect(enqueue).toHaveBeenCalled();
  });

  it("creates an auditable client notification without exposing provider credentials", async () => {
    const notificationCreate = vi.fn(async (data) => ({
      id: "notification-1",
      createdAt: new Date("2026-08-27T18:00:00.000Z"),
      ...data.data,
    }));
    const auditCreate = vi.fn(async () => ({ id: "audit-1" }));
    const app = new Hono();
    mountBrandwellManagementRoutes(app, {
      token: "management-secret",
      prisma: {
        brandwellAiWorkspace: {
          findFirst: vi.fn(async () => ({
            id: "mapping-1",
            rakazoWorkspaceId: "workspace-1",
            rakazoWorkspace: { name: "Acme", slug: "acme" },
          })),
        },
        brandwellClientNotification: { findUnique: vi.fn(async () => null) },
        $transaction: vi.fn(async (callback) =>
          callback({
            brandwellClientNotification: { create: notificationCreate },
            brandwellAuditLog: { create: auditCreate },
          }),
        ),
      } as unknown as PrismaClient,
    });
    const response = await app.request("/internal/workspaces/mapping-1/notify-client", {
      method: "POST",
      headers: {
        authorization: "Bearer management-secret",
        "content-type": "application/json",
        "x-idempotency-key": "notify-client-0001",
        ...OPERATOR_HEADERS,
      },
      body: JSON.stringify({
        type: "LOGIN_REQUIRED",
        title: "AIMEE needs your help",
        body: "Please reconnect Gmail so outreach can continue.",
        severity: "warning",
        requiresAction: true,
        actionType: "CONNECTION_REQUIRED",
        actionTarget: "/integrations",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "notification-1",
      type: "LOGIN_REQUIRED",
      requiresAction: true,
      replayed: false,
    });
    expect(notificationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: "workspace-1",
          dedupeKey: "brandwell-notify:notify-client-0001",
          actionTarget: "/integrations",
        }),
      }),
    );
    expect(auditCreate).toHaveBeenCalled();
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorType: "brandwell_operator",
          metadata: expect.objectContaining({ operatorReference: "user:42" }),
        }),
      }),
    );
  });

  it("rejects operator mutations that cannot be attributed to a person", async () => {
    const findFirst = vi.fn();
    const app = new Hono();
    mountBrandwellManagementRoutes(app, {
      token: "management-secret",
      prisma: { bot: { findFirst } } as unknown as PrismaClient,
    });
    const response = await app.request("/internal/bots/bot-1/pause", {
      method: "POST",
      headers: { authorization: "Bearer management-secret" },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "A valid BrandWell operator reference is required",
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("records the operator when pausing a managed employee", async () => {
    const auditCreate = vi.fn(async () => ({ id: "audit-1" }));
    const app = new Hono();
    mountBrandwellManagementRoutes(app, {
      token: "management-secret",
      prisma: {
        bot: {
          findFirst: vi.fn(async () => ({ id: "bot-1", workspaceId: "workspace-1" })),
          update: vi.fn(async () => ({ id: "bot-1" })),
        },
        routine: { updateMany: vi.fn(async () => ({ count: 2 })) },
        brandwellAuditLog: { create: auditCreate },
        $transaction: vi.fn(async (operations) => Promise.all(operations)),
      } as unknown as PrismaClient,
    });
    const response = await app.request("/internal/bots/bot-1/pause", {
      method: "POST",
      headers: { authorization: "Bearer management-secret", ...OPERATOR_HEADERS },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: "paused" });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorType: "brandwell_operator",
        action: "employee.pause",
        metadata: expect.objectContaining({
          operatorReference: "user:42",
          operatorEmail: "operator@example.test",
        }),
      }),
    });
  });

  it("updates managed employee instructions with an operator audit record", async () => {
    const auditCreate = vi.fn(async () => ({ id: "audit-1" }));
    const botUpdate = vi.fn(async ({ data }) => ({
      id: "bot-1",
      instructions: data.instructions,
      updatedAt: new Date("2026-08-27T19:00:00.000Z"),
    }));
    const app = new Hono();
    mountBrandwellManagementRoutes(app, {
      token: "management-secret",
      prisma: {
        bot: {
          findFirst: vi.fn(async () => ({ id: "bot-1", workspaceId: "workspace-1" })),
        },
        $transaction: vi.fn(async (callback) =>
          callback({
            bot: { update: botUpdate },
            brandwellAuditLog: { create: auditCreate },
          }),
        ),
      } as unknown as PrismaClient,
    });
    const response = await app.request("/internal/bots/bot-1/instructions", {
      method: "POST",
      headers: {
        authorization: "Bearer management-secret",
        "content-type": "application/json",
        ...OPERATOR_HEADERS,
      },
      body: JSON.stringify({ instructions: "Qualify every buyer against the saved ICP." }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      employeeId: "bot-1",
      instructions: "Qualify every buyer against the saved ICP.",
    });
    expect(botUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { instructions: "Qualify every buyer against the saved ICP." },
      }),
    );
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "employee.instructions.update",
        metadata: expect.objectContaining({ operatorReference: "user:42" }),
      }),
    });
  });

  it("updates a recurring AIMEE routine and synchronizes its wakeup job", async () => {
    const enqueue = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const auditCreate = vi.fn(async () => ({ id: "audit-1" }));
    const routineUpdate = vi.fn(async ({ data }) => ({
      id: "routine-1",
      botId: "bot-1",
      name: data.name ?? "Daily GTM review",
      prompt: "Review new qualified buyers",
      crons: data.crons ?? ["0 9 * * *"],
      timezone: data.timezone ?? "America/Phoenix",
      active: data.active ?? true,
      notify: true,
      lastRunAt: null,
      nextRunAt: data.nextRunAt,
      updatedAt: new Date("2026-08-27T19:00:00.000Z"),
    }));
    const app = new Hono();
    mountBrandwellManagementRoutes(app, {
      token: "management-secret",
      prisma: {
        routine: {
          findFirst: vi.fn(async () => ({
            id: "routine-1",
            botId: "bot-1",
            workspaceId: "workspace-1",
            name: "Daily GTM review",
            prompt: "Review new qualified buyers",
            crons: ["0 9 * * *"],
            timezone: "UTC",
            active: false,
            notify: true,
            bot: { managedStatus: "active" },
          })),
        },
        brandwellAiWorkspace: {
          findUnique: vi.fn(async () => ({ subscriptionStatus: "active" })),
        },
        $transaction: vi.fn(async (callback) =>
          callback({
            routine: { update: routineUpdate },
            brandwellAuditLog: { create: auditCreate },
          }),
        ),
      } as unknown as PrismaClient,
      jobs: { enqueue, cancel } as never,
    });
    const response = await app.request("/internal/routines/routine-1/settings", {
      method: "POST",
      headers: {
        authorization: "Bearer management-secret",
        "content-type": "application/json",
        ...OPERATOR_HEADERS,
      },
      body: JSON.stringify({
        name: "Daily buyer follow-up",
        crons: ["0 9 * * *"],
        timezone: "America/Phoenix",
        active: true,
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      routine: { id: "routine-1", active: true, timezone: "America/Phoenix" },
    });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "routine.wakeup",
        payload: expect.objectContaining({ routineId: "routine-1" }),
      }),
    );
    expect(cancel).not.toHaveBeenCalled();
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "routine.settings.update" }),
    });
  });

  it("updates model routing and spend limits without returning credential secrets", async () => {
    const current = {
      id: "model-policy-1",
      workspaceId: "workspace-1",
      provider: "openrouter",
      status: "active",
      secretId: "secret-never-returned",
      externalKeyHash: "hash-acme",
      preferredModel: "provider/old",
      computerModel: null,
      lightweightModel: null,
      reasoningModel: null,
      fallbackModels: [],
      maxTokens: 8192,
      thinkingLevel: "medium",
      monthlyLimitMicros: 200_000_000n,
      dailyLimitMicros: null,
      warningLimitMicros: 150_000_000n,
      currentUsageMicros: 10_000_000n,
      providerLimitMicros: 200_000_000n,
      providerUsageSyncedAt: new Date("2026-08-27T18:59:00.000Z"),
      providerUsageSyncError: null,
      disabledAt: null,
      updatedAt: new Date("2026-08-27T19:00:00.000Z"),
    };
    const app = new Hono();
    const updateOpenRouterLimit = vi.fn(async () => undefined);
    const validateOpenRouterModel = vi.fn(async (id: string) => ({
      id,
      name: id,
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      supportedParameters: ["tools"],
      reasoning: false,
      pricing: {},
    }));
    const sidekickPolicyUpdateMany = vi.fn(async () => ({ count: 1 }));
    const botUpdateMany = vi.fn(async () => ({ count: 2 }));
    const workspacePolicyUpdate = vi.fn(async ({ data }) => ({ ...current, ...data }));
    const sidekickCredential = {
      ...current,
      id: "sidekick-policy-1",
      secretId: "sidekick-secret-never-returned",
      externalKeyHash: "hash-acme-sidekick",
    };
    mountBrandwellManagementRoutes(app, {
      token: "management-secret",
      updateOpenRouterLimit,
      validateOpenRouterModel,
      prisma: {
        brandwellAiWorkspace: {
          findFirst: vi.fn(async () => ({
            id: "mapping-1",
            rakazoWorkspaceId: "workspace-1",
            rakazoWorkspace: { name: "Acme", slug: "acme" },
          })),
          updateMany: vi.fn(async () => ({ count: 1 })),
        },
        brandwellWorkspaceModelCredential: {
          findUnique: vi.fn(async () => current),
        },
        brandwellSidekickModelCredential: {
          findMany: vi.fn(async () => [sidekickCredential]),
        },
        $transaction: vi.fn(async (callback) =>
          callback({
            brandwellWorkspaceModelCredential: {
              update: workspacePolicyUpdate,
            },
            brandwellSidekickModelCredential: {
              updateMany: sidekickPolicyUpdateMany,
            },
            bot: { updateMany: botUpdateMany },
            brandwellAuditLog: { create: vi.fn(async () => ({ id: "audit-1" })) },
          }),
        ),
      } as unknown as PrismaClient,
    });
    const response = await app.request("/internal/workspaces/mapping-1/model-policy", {
      method: "POST",
      headers: {
        authorization: "Bearer management-secret",
        "content-type": "application/json",
        ...OPERATOR_HEADERS,
      },
      body: JSON.stringify({
        preferredModel: "provider/general",
        computerModel: "provider/vision",
        fallbackModels: ["provider/fallback"],
        monthlyLimitMicros: "175000000",
        warningLimitMicros: "175000000",
      }),
    });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.modelPolicy).toMatchObject({
      provider: "openrouter",
      preferredModel: "provider/general",
      computerModel: "provider/vision",
      monthlyLimitMicros: "175000000",
    });
    expect(JSON.stringify(payload)).not.toContain("secret-never-returned");
    expect(payload.modelPolicy.secretId).toBeUndefined();
    expect(payload.modelPolicy.modelCatalog["provider/general"]).toMatchObject({
      id: "provider/general",
      inputModalities: ["text", "image"],
    });
    expect(updateOpenRouterLimit).toHaveBeenCalledWith("hash-acme", 175_000_000n);
    expect(updateOpenRouterLimit).toHaveBeenCalledWith("hash-acme-sidekick", 175_000_000n);
    expect(sidekickPolicyUpdateMany).toHaveBeenCalledWith({
      where: { workspaceId: "workspace-1" },
      data: expect.objectContaining({
        preferredModel: "provider/general",
        computerModel: "provider/vision",
        monthlyLimitMicros: 175_000_000n,
      }),
    });
    const savedPolicyData = workspacePolicyUpdate.mock.calls[0]?.[0].data;
    expect(savedPolicyData).toMatchObject({ providerLimitMicros: 175_000_000n });
    expect(savedPolicyData).not.toHaveProperty("providerUsageSyncedAt");
    expect(botUpdateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        managedByBrandWell: true,
        archivedAt: null,
      },
      data: {
        modelProvider: "openrouter",
        modelId: "provider/general",
        thinkingLevel: "medium",
      },
    });
    expect(payload).toMatchObject({
      managedCredentialsUpdated: 2,
      sidekickCredentialsUpdated: 1,
      openRouterLimitsUpdated: 2,
    });
    expect(validateOpenRouterModel).toHaveBeenCalledWith("provider/general");
    expect(validateOpenRouterModel).toHaveBeenCalledWith("provider/vision");

    const overCap = await app.request("/internal/workspaces/mapping-1/model-policy", {
      method: "POST",
      headers: {
        authorization: "Bearer management-secret",
        "content-type": "application/json",
        ...OPERATOR_HEADERS,
      },
      body: JSON.stringify({ monthlyLimitMicros: "200000001" }),
    });
    expect(overCap.status).toBe(400);
    await expect(overCap.json()).resolves.toMatchObject({
      error: expect.stringContaining("$200"),
    });

    const invalidModel = await app.request("/internal/workspaces/mapping-1/model-policy", {
      method: "POST",
      headers: {
        authorization: "Bearer management-secret",
        "content-type": "application/json",
        ...OPERATOR_HEADERS,
      },
      body: JSON.stringify({ preferredModel: "not a model" }),
    });
    expect(invalidModel.status).toBe(400);

    validateOpenRouterModel.mockImplementation(async (id: string) => ({
      id,
      name: id,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportedParameters: ["tools"],
      reasoning: false,
      pricing: {},
    }));
    const textOnlyComputer = await app.request("/internal/workspaces/mapping-1/model-policy", {
      method: "POST",
      headers: {
        authorization: "Bearer management-secret",
        "content-type": "application/json",
        ...OPERATOR_HEADERS,
      },
      body: JSON.stringify({ computerModel: "provider/text-only" }),
    });
    expect(textOnlyComputer.status).toBe(400);
    await expect(textOnlyComputer.json()).resolves.toEqual({
      error: "The managed computer model must support image input",
    });

    updateOpenRouterLimit.mockReset();
    updateOpenRouterLimit
      .mockRejectedValueOnce(new Error("ambiguous timeout"))
      .mockResolvedValueOnce(undefined);
    const ambiguousLimitUpdate = await app.request("/internal/workspaces/mapping-1/model-policy", {
      method: "POST",
      headers: {
        authorization: "Bearer management-secret",
        "content-type": "application/json",
        ...OPERATOR_HEADERS,
      },
      body: JSON.stringify({
        monthlyLimitMicros: "160000000",
        warningLimitMicros: "150000000",
      }),
    });
    expect(ambiguousLimitUpdate.status).toBe(503);
    expect(updateOpenRouterLimit.mock.calls).toEqual([
      ["hash-acme", 160_000_000n],
      ["hash-acme", 200_000_000n],
    ]);
  });

  it("lists only safe workspace integration health fields", async () => {
    const app = new Hono();
    mountBrandwellManagementRoutes(app, {
      token: "management-secret",
      prisma: {
        brandwellAiWorkspace: {
          findFirst: vi.fn(async () => ({
            id: "mapping-1",
            rakazoWorkspaceId: "workspace-1",
            rakazoWorkspace: { name: "Acme", slug: "acme" },
          })),
        },
        connection: {
          findMany: vi.fn(async () => [
            {
              id: "connection-1",
              connectorId: "composio",
              provider: "gmail",
              displayName: "Gmail",
              status: "connected",
              ownerType: "service",
              secretId: "secret-never-returned",
              providerRef: "provider-ref-never-returned",
              metadata: { accessToken: "never-returned" },
              updatedAt: new Date("2026-08-27T19:00:00.000Z"),
            },
          ]),
        },
      } as unknown as PrismaClient,
    });
    const response = await app.request("/internal/workspaces/mapping-1/integrations", {
      headers: { authorization: "Bearer management-secret" },
    });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.integrations[0]).toMatchObject({ displayName: "Gmail", status: "connected" });
    expect(JSON.stringify(payload)).not.toContain("never-returned");
  });

  it("acknowledges an alert with operator attribution", async () => {
    const auditCreate = vi.fn(async () => ({ id: "audit-1" }));
    const alertUpdate = vi.fn(async ({ data }) => ({
      id: "alert-1",
      workspaceId: "workspace-1",
      summary: "Gmail needs attention",
      acknowledgedAt: data.acknowledgedAt,
      resolvedAt: data.resolvedAt,
      status: data.status,
    }));
    const app = new Hono();
    mountBrandwellManagementRoutes(app, {
      token: "management-secret",
      prisma: {
        brandwellAlert: {
          findUnique: vi.fn(async () => ({
            id: "alert-1",
            workspaceId: "workspace-1",
            acknowledgedAt: null,
          })),
        },
        $transaction: vi.fn(async (callback) =>
          callback({
            brandwellAlert: { update: alertUpdate },
            brandwellAuditLog: { create: auditCreate },
          }),
        ),
      } as unknown as PrismaClient,
    });
    const response = await app.request("/internal/alerts/alert-1/status", {
      method: "POST",
      headers: {
        authorization: "Bearer management-secret",
        "content-type": "application/json",
        ...OPERATOR_HEADERS,
      },
      body: JSON.stringify({ status: "ACKNOWLEDGED" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      alert: { id: "alert-1", status: "ACKNOWLEDGED" },
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "alert.acknowledged",
        metadata: expect.objectContaining({ operatorReference: "user:42" }),
      }),
    });
  });

  it("forwards operator identity to the isolated computer support service", async () => {
    const takeControl = vi.fn(async () => ({
      sessionId: "support-1",
      leaseId: "lease-1",
      expiresAt: "2026-08-27T18:15:00.000Z",
      replayed: false,
    }));
    const app = new Hono();
    mountBrandwellManagementRoutes(app, {
      token: "management-secret",
      prisma: {
        brandwellAiWorkspace: {
          findFirst: vi.fn(async () => ({
            id: "mapping-1",
            rakazoWorkspaceId: "workspace-1",
            primaryBotId: "bot-1",
            subscriptionStatus: "active",
            rakazoWorkspace: { name: "Acme", slug: "acme" },
          })),
        },
      } as unknown as PrismaClient,
      computerSupport: {
        boot: vi.fn(),
        takeControl,
        screen: vi.fn(),
        release: vi.fn(),
      },
    });
    const response = await app.request("/internal/workspaces/mapping-1/computer/takeover", {
      method: "POST",
      headers: {
        authorization: "Bearer management-secret",
        "content-type": "application/json",
        ...OPERATOR_HEADERS,
      },
      body: JSON.stringify({ reason: "Resolve the client login alert" }),
    });
    expect(response.status).toBe(200);
    expect(takeControl).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      botId: "bot-1",
      actor: {
        reference: "user:42",
        name: "Test Operator",
        email: "operator@example.test",
      },
      reason: "Resolve the client login alert",
    });
  });
});
