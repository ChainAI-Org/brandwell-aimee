import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

export type ConnectionOwner = {
  workspaceId: string;
  userId: string;
  ownerType: "user" | "service";
  serviceIdentityId: string | null;
};

export async function resolveConnectionOwner(
  prisma: PrismaClient,
  actor: Actor,
): Promise<ConnectionOwner> {
  const managed = await prisma.brandwellAiWorkspace.findUnique({
    where: { rakazoWorkspaceId: actor.workspaceId },
    select: { serviceIdentityId: true },
  });
  if (managed?.serviceIdentityId) {
    return {
      workspaceId: actor.workspaceId,
      userId: managed.serviceIdentityId,
      ownerType: "service",
      serviceIdentityId: managed.serviceIdentityId,
    };
  }
  return {
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    ownerType: "user",
    serviceIdentityId: null,
  };
}

export function connectionOwnerWhere(owner: ConnectionOwner) {
  return owner.ownerType === "service"
    ? {
        workspaceId: owner.workspaceId,
        ownerType: "service",
        serviceIdentityId: owner.serviceIdentityId,
      }
    : {
        workspaceId: owner.workspaceId,
        ownerType: "user",
        userId: owner.userId,
      };
}
