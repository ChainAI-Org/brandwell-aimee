import type { PrismaClient } from "@rakazo/db";

export const BRANDWELL_OPENROUTER_PROVIDER = "openrouter";
export const BRANDWELL_DEFAULT_OPENROUTER_MODEL = "openai/gpt-5.6-terra";

export async function brandwellPlatformModelDefault(prisma: PrismaClient): Promise<string> {
  const settings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { brandwellDefaultModelId: true },
  });
  return settings?.brandwellDefaultModelId?.trim() || BRANDWELL_DEFAULT_OPENROUTER_MODEL;
}
