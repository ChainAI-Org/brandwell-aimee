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
});
