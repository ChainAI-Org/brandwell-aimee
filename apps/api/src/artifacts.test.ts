import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { getOwnedArtifact } from "./artifacts.js";

const actor = {
  workspaceId: "workspace-acme",
  userId: "client-user",
  email: "client@example.test",
  isDeploymentOwner: false,
} satisfies Actor;

function artifactDeps() {
  const findFirst = vi.fn().mockResolvedValue({
    id: "artifact-1",
    botId: "bot-aimee",
    groupId: null,
    runId: "run-1",
    storageKey: "stored-1",
    name: "daily-report.csv",
    mimeType: "text/csv",
    size: 12,
    createdAt: new Date("2026-08-27T12:00:00.000Z"),
  });
  const get = vi.fn().mockResolvedValue(new TextEncoder().encode("name\nAcme\n"));
  return {
    findFirst,
    deps: {
      prisma: { artifact: { findFirst } } as unknown as PrismaClient,
      artifacts: { get } as unknown as ArtifactStore,
    },
  };
}

describe("getOwnedArtifact", () => {
  it("keeps private bot artifacts scoped to the current user", async () => {
    const { deps, findFirst } = artifactDeps();

    await getOwnedArtifact(deps, actor, {
      botId: "bot-aimee",
      artifactId: "artifact-1",
    });

    expect(findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        workspaceId: "workspace-acme",
        userId: "client-user",
      }),
    });
  });

  it("lets an authorized workspace employee expose its scheduled artifacts to members", async () => {
    const { deps, findFirst } = artifactDeps();

    await getOwnedArtifact(deps, actor, {
      botId: "bot-aimee",
      artifactId: "artifact-1",
      allowWorkspaceBotAccess: true,
    });

    const where = findFirst.mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({
      id: "artifact-1",
      botId: "bot-aimee",
      workspaceId: "workspace-acme",
    });
    expect(where).not.toHaveProperty("userId");
  });
});
