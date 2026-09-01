import { describe, expect, it, vi } from "vitest";
import { BRANDWELL_AIMEE_DEFAULT_ROUTINES } from "./aimee-baseline.js";
import { rolloutBrandwellSkillBundleWithPrisma } from "./prisma-sidekicks.js";

vi.mock("./prisma-skills.js", () => ({
  installBrandwellSkillBundle: vi.fn(async () => ({ skillIds: ["managed-skill"] })),
}));

describe("managed AIMEE bundle rollout", () => {
  it("adds the weekly content routine to every existing managed bot", async () => {
    const existing = BRANDWELL_AIMEE_DEFAULT_ROUTINES.slice(0, 4).map((template, index) => ({
      id: `routine-${index}`,
      name: template.name,
      active: true,
    }));
    const routineCreate = vi.fn(async ({ data }) => ({ id: "weekly-routine", ...data }));
    const routineUpdate = vi.fn(async ({ data }) => data);
    const prisma = {
      brandwellAiWorkspace: {
        findFirst: vi.fn(async () => ({
          id: "mapping-1",
          rakazoWorkspaceId: "workspace-1",
          timezone: "America/Phoenix",
          serviceIdentityId: "service-1",
        })),
        update: vi.fn(async () => ({})),
      },
      brandwellSidekick: { updateMany: vi.fn(async () => ({ count: 0 })) },
      bot: {
        findMany: vi.fn(async () => [
          { id: "bot-1", userId: "user-1", serviceIdentityId: "service-1" },
        ]),
      },
      routine: {
        findMany: vi.fn(async () => existing),
        update: routineUpdate,
        create: routineCreate,
      },
      $transaction: vi.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
    };

    const result = await rolloutBrandwellSkillBundleWithPrisma("workspace-1", prisma as never);

    expect(result).toMatchObject({ users: 1, routines: 5 });
    expect(routineUpdate).toHaveBeenCalledTimes(4);
    expect(routineCreate).toHaveBeenCalledOnce();
    expect(routineCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: "Review weekly content opportunities",
        active: true,
        timezone: "America/Phoenix",
        nextRunAt: expect.any(Date),
      }),
    });
  });
});
