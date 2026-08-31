import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { requireBrandwellUserAccess } from "./user-access.js";

function accessPrisma(input: {
  commercialStatus?: string;
  subscriptionStatus?: string;
  master?: boolean;
  sidekick?: boolean;
  membership?: boolean;
}) {
  const mapping = {
    id: "mapping-1",
    rakazoWorkspaceId: "workspace-1",
    commercialStatus: input.commercialStatus ?? "active",
    subscriptionStatus: input.subscriptionStatus ?? "active",
  };
  return {
    user: {
      findUnique: vi.fn(async () => ({
        id: "user-1",
        email: "ada@example.com",
        brandwellUserId: "brandwell-user-42",
      })),
    },
    brandwellAiWorkspace: {
      findFirst: vi.fn(async () => (input.master === false ? null : mapping)),
    },
    brandwellSidekick: {
      findFirst: vi.fn(async () => (input.sidekick ? { aiWorkspace: mapping } : null)),
    },
    member: {
      findUnique: vi.fn(async () => (input.membership === false ? null : { id: "member-1" })),
    },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({ ownerUserId: "system-user" })),
    },
  } as unknown as PrismaClient;
}

describe("BrandWell AIMEE session access", () => {
  it("returns the managed workspace actor for the paid master user", async () => {
    await expect(requireBrandwellUserAccess(accessPrisma({}), "user-1")).resolves.toEqual({
      userId: "user-1",
      workspaceId: "workspace-1",
      email: "ada@example.com",
      isDeploymentOwner: false,
    });
  });

  it("allows an active paid Sidekick when the user is not the master", async () => {
    await expect(
      requireBrandwellUserAccess(accessPrisma({ master: false, sidekick: true }), "user-1"),
    ).resolves.toMatchObject({ workspaceId: "workspace-1" });
  });

  it("denies an ordinary BrandWell sub-user without a paid Sidekick", async () => {
    await expect(
      requireBrandwellUserAccess(accessPrisma({ master: false, sidekick: false }), "user-1"),
    ).rejects.toMatchObject({ code: "aimee_sidekick_required", statusCode: 403 });
  });

  it("returns the failed-invoice lockout for an existing past-due session", async () => {
    await expect(
      requireBrandwellUserAccess(
        accessPrisma({ commercialStatus: "past_due", subscriptionStatus: "past_due" }),
        "user-1",
      ),
    ).rejects.toMatchObject({
      code: "aimee_billing_past_due",
      statusCode: 402,
      message: expect.stringMatching(/last BrandWell invoice failed/i),
    });
  });
});
