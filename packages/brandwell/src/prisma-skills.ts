import type { Prisma, PrismaClient } from "@rakazo/db";
import { BRANDWELL_AIMEE_SKILL_BUNDLE_VERSION, BRANDWELL_AIMEE_SKILLS } from "./aimee-baseline.js";

type SkillDb = Pick<PrismaClient, "agentSkill"> | Prisma.TransactionClient;

export async function installBrandwellSkillBundle(
  prisma: SkillDb,
  input: { workspaceId: string; userId: string },
) {
  const skillIds: string[] = [];
  const createdIds: string[] = [];
  for (const template of BRANDWELL_AIMEE_SKILLS) {
    const existing = await prisma.agentSkill.findFirst({
      where: {
        workspaceId: input.workspaceId,
        userId: input.userId,
        OR: [
          { managedKey: template.key },
          { managedKey: null, name: { equals: template.name, mode: "insensitive" } },
        ],
      },
    });
    const skill = existing
      ? await prisma.agentSkill.update({
          where: { id: existing.id },
          data: {
            name: template.name,
            description: template.description,
            content: template.content,
            source: "builtin",
            managedKey: template.key,
            managedVersion: BRANDWELL_AIMEE_SKILL_BUNDLE_VERSION,
          },
        })
      : await prisma.agentSkill.create({
          data: {
            workspaceId: input.workspaceId,
            userId: input.userId,
            name: template.name,
            description: template.description,
            content: template.content,
            source: "builtin",
            managedKey: template.key,
            managedVersion: BRANDWELL_AIMEE_SKILL_BUNDLE_VERSION,
          },
        });
    skillIds.push(skill.id);
    if (!existing) createdIds.push(skill.id);
  }
  return {
    version: BRANDWELL_AIMEE_SKILL_BUNDLE_VERSION,
    skillIds,
    createdIds,
  };
}
