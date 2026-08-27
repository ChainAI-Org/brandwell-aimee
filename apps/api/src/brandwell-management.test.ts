import { BRANDWELL_PROVISIONING_STEPS } from "@brandwell/aimee";
import type { PrismaClient } from "@rakazo/db";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  constantTimeBearerMatches,
  mountBrandwellManagementRoutes,
} from "./brandwell-management.js";

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

  it("validates and provisions a workspace through the internal service boundary", async () => {
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
      prisma: {} as PrismaClient,
      provisionWorkspace,
    });

    const response = await app.request("/internal/workspaces/provision", {
      method: "POST",
      headers: {
        authorization: "Bearer management-secret",
        "content-type": "application/json",
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

  it("starts cancellation without exposing provider details", async () => {
    const cancelWorkspace = vi.fn(async () => ({
      retentionEndsAt: new Date("2026-09-26T12:00:00.000Z"),
      executed: ["mark_canceling", "pause_routines"],
    }));
    const app = new Hono();
    mountBrandwellManagementRoutes(app, {
      token: "management-secret",
      prisma: {} as PrismaClient,
      cancelWorkspace,
    });
    const response = await app.request("/internal/workspaces/customer-acme/cancel", {
      method: "POST",
      headers: {
        authorization: "Bearer management-secret",
        "content-type": "application/json",
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
      headers: { authorization: "Bearer management-secret" },
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
      headers: { authorization: "Bearer management-secret" },
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
  });
});
