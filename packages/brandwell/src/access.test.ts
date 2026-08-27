import { describe, expect, it } from "vitest";
import { authorizeWorkspaceResource, type WorkspaceResource } from "./access.js";

const managedAimee: WorkspaceResource = {
  workspaceId: "workspace-acme",
  ownerType: "workspace",
  visibility: "workspace",
  createdByUserId: "creator",
  managedByBrandWell: true,
};

describe("BrandWell workspace access", () => {
  it("lets an authorized workspace member use a workspace-owned AIMEE", () => {
    expect(
      authorizeWorkspaceResource(
        { kind: "client_user", userId: "member", workspaceId: "workspace-acme" },
        managedAimee,
        "chat",
      ),
    ).toEqual({ allowed: true, reason: "workspace_member" });
  });

  it("does not let a client cross a workspace boundary", () => {
    expect(
      authorizeWorkspaceResource(
        { kind: "client_admin", userId: "other", workspaceId: "workspace-other" },
        managedAimee,
        "view",
      ),
    ).toEqual({ allowed: false, reason: "wrong_workspace" });
  });

  it("lets an assigned BrandWell operator support only assigned workspaces", () => {
    expect(
      authorizeWorkspaceResource(
        {
          kind: "brandwell_operator",
          userId: "operator",
          assignedWorkspaceIds: ["workspace-acme"],
          permissions: ["support"],
        },
        managedAimee,
        "operate",
      ),
    ).toEqual({ allowed: true, reason: "assigned_operator" });

    expect(
      authorizeWorkspaceResource(
        {
          kind: "brandwell_operator",
          userId: "operator",
          assignedWorkspaceIds: ["workspace-other"],
          permissions: ["support"],
        },
        managedAimee,
        "operate",
      ),
    ).toEqual({ allowed: false, reason: "wrong_workspace" });
  });

  it("keeps private user-owned bots private", () => {
    expect(
      authorizeWorkspaceResource(
        { kind: "client_admin", userId: "admin", workspaceId: "workspace-acme" },
        {
          workspaceId: "workspace-acme",
          ownerType: "user",
          visibility: "private",
          createdByUserId: "creator",
        },
        "view",
      ),
    ).toEqual({ allowed: false, reason: "private_resource" });
  });

  it("blocks a paused service identity from scheduled execution", () => {
    expect(
      authorizeWorkspaceResource(
        {
          kind: "service_identity",
          serviceIdentityId: "svc-acme",
          workspaceId: "workspace-acme",
          status: "paused",
        },
        managedAimee,
        "execute",
      ),
    ).toEqual({ allowed: false, reason: "service_identity_disabled" });
  });
});
