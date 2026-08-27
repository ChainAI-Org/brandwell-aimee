export type BrandwellActor =
  | {
      kind: "brandwell_super_admin";
      userId: string;
    }
  | {
      kind: "brandwell_operator";
      userId: string;
      assignedWorkspaceIds: readonly string[];
      permissions: readonly BrandwellPermission[];
    }
  | {
      kind: "client_admin";
      userId: string;
      workspaceId: string;
    }
  | {
      kind: "client_user";
      userId: string;
      workspaceId: string;
      permissions?: readonly BrandwellPermission[];
    }
  | {
      kind: "service_identity";
      serviceIdentityId: string;
      workspaceId: string;
      status: "active" | "paused" | "disabled";
    };

export type BrandwellPermission =
  | "view"
  | "chat"
  | "operate"
  | "manage"
  | "support"
  | "billing"
  | "delete"
  | "execute";

export type WorkspaceResource = {
  workspaceId: string;
  ownerType: "workspace" | "user";
  visibility: "workspace" | "private";
  createdByUserId?: string | null;
  managedByBrandWell?: boolean;
};

export type AccessDecision = {
  allowed: boolean;
  reason:
    | "super_admin"
    | "assigned_operator"
    | "workspace_member"
    | "resource_owner"
    | "service_identity"
    | "wrong_workspace"
    | "private_resource"
    | "missing_permission"
    | "service_identity_disabled";
};

const CLIENT_ADMIN_PERMISSIONS = new Set<BrandwellPermission>([
  "view",
  "chat",
  "operate",
  "manage",
  "execute",
]);

const CLIENT_USER_PERMISSIONS = new Set<BrandwellPermission>(["view", "chat", "operate"]);

export function authorizeWorkspaceResource(
  actor: BrandwellActor,
  resource: WorkspaceResource,
  permission: BrandwellPermission,
): AccessDecision {
  if (actor.kind === "brandwell_super_admin") {
    return { allowed: true, reason: "super_admin" };
  }

  if (actor.kind === "brandwell_operator") {
    if (!actor.assignedWorkspaceIds.includes(resource.workspaceId)) {
      return { allowed: false, reason: "wrong_workspace" };
    }
    if (!actor.permissions.includes(permission) && !actor.permissions.includes("support")) {
      return { allowed: false, reason: "missing_permission" };
    }
    return { allowed: true, reason: "assigned_operator" };
  }

  if (actor.workspaceId !== resource.workspaceId) {
    return { allowed: false, reason: "wrong_workspace" };
  }

  if (actor.kind === "service_identity") {
    if (actor.status !== "active") {
      return { allowed: false, reason: "service_identity_disabled" };
    }
    if (permission !== "execute" && permission !== "view" && permission !== "operate") {
      return { allowed: false, reason: "missing_permission" };
    }
    return { allowed: true, reason: "service_identity" };
  }

  const isOwner = resource.createdByUserId === actor.userId;
  if (resource.ownerType === "user" && resource.visibility === "private" && !isOwner) {
    return { allowed: false, reason: "private_resource" };
  }

  if (isOwner) {
    return { allowed: true, reason: "resource_owner" };
  }

  const allowedPermissions =
    actor.kind === "client_admin"
      ? CLIENT_ADMIN_PERMISSIONS
      : new Set(actor.permissions ?? CLIENT_USER_PERMISSIONS);
  if (!allowedPermissions.has(permission)) {
    return { allowed: false, reason: "missing_permission" };
  }

  return { allowed: true, reason: "workspace_member" };
}

export function assertWorkspaceAccess(
  actor: BrandwellActor,
  resource: WorkspaceResource,
  permission: BrandwellPermission,
): void {
  const decision = authorizeWorkspaceResource(actor, resource, permission);
  if (!decision.allowed) {
    throw new Error(`BrandWell workspace access denied: ${decision.reason}`);
  }
}
