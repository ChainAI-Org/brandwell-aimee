import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { connectionOwnerWhere, resolveConnectionOwner } from "./connection-owner.js";

const actor: Actor = {
  userId: "user-1",
  workspaceId: "workspace-1",
  email: "client@example.com",
  isDeploymentOwner: false,
};

describe("resolveConnectionOwner", () => {
  it("uses the workspace service identity for a managed BrandWell client", async () => {
    const prisma = {
      brandwellAiWorkspace: {
        findUnique: vi.fn(async () => ({ serviceIdentityId: "service-1" })),
      },
    } as unknown as PrismaClient;

    await expect(resolveConnectionOwner(prisma, actor)).resolves.toEqual({
      workspaceId: "workspace-1",
      userId: "service-1",
      ownerType: "service",
      serviceIdentityId: "service-1",
    });
  });

  it("keeps user ownership for an unmanaged workspace", async () => {
    const prisma = {
      brandwellAiWorkspace: { findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;

    await expect(resolveConnectionOwner(prisma, actor)).resolves.toEqual({
      workspaceId: "workspace-1",
      userId: "user-1",
      ownerType: "user",
      serviceIdentityId: null,
    });
  });
});

describe("connectionOwnerWhere", () => {
  it("does not scope managed connections to the human who connected the app", () => {
    expect(
      connectionOwnerWhere({
        workspaceId: "workspace-1",
        userId: "service-1",
        ownerType: "service",
        serviceIdentityId: "service-1",
      }),
    ).toEqual({
      workspaceId: "workspace-1",
      ownerType: "service",
      serviceIdentityId: "service-1",
    });
  });
});
