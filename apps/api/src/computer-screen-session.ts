import type {
  AdapterContext,
  ComputerRef,
  SandboxProvider,
  ScreenRequest,
  ScreenSession,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";

export async function connectLeasedComputerScreen(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider },
  computer: ComputerRef,
  request: ScreenRequest,
  context: AdapterContext,
  botId: string,
  computerId: string,
  stillAuthorized?: () => Promise<boolean>,
): Promise<ScreenSession> {
  if (request.interactive && !request.controlToken) {
    return { url: null, mimeType: "text/html", close: async () => undefined };
  }
  const session = await deps.sandbox.connectScreen(computer, request, context);
  if (!request.interactive) return session;
  let authorized = false;
  try {
    const current = await deps.prisma.computer.findFirst({
      where: {
        id: computerId,
        workspaceId: context.workspaceId,
        providerRef: computer.providerRef,
        kind: computer.kind,
        state: "running",
        bots: { some: { id: botId, workspaceId: context.workspaceId } },
        controlHolder: "user",
        controlBotId: botId,
        controlLeaseId: request.controlToken,
        controlLeaseExpiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    authorized = Boolean(current) && (!stillAuthorized || (await stillAuthorized()));
  } finally {
    if (!authorized) {
      await session.close?.().catch(() => undefined);
      await deps.sandbox.setScreenControl?.(computer, false, context, request.controlToken);
    }
  }
  return authorized ? session : { ...session, url: null };
}
