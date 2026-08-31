import type { Actor, BotChat } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { createRepos, IsolationError, Prisma, type PrismaClient } from "@rakazo/db";
import { withSerializableRetry } from "./serializable-retry.js";

const NEW_CHAT_TITLE = "New chat";

export class ActiveThreadArchiveError extends Error {
  constructor() {
    super("Stop the current work before archiving this chat.");
    this.name = "ActiveThreadArchiveError";
  }
}

type ChatRow = {
  id: string;
  botId: string | null;
  title: string;
  unread: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  messages: Array<{ blocks: unknown }>;
};

function messagePreview(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const text = "text" in block && typeof block.text === "string" ? block.text.trim() : "";
    if (text) return text;
  }
  return "";
}

function chatDto(row: ChatRow, primaryThreadId: string | null): BotChat {
  if (!row.botId) throw new IsolationError();
  return {
    id: row.id,
    botId: row.botId,
    title: row.title,
    preview: messagePreview(row.messages[0]?.blocks),
    unread: row.unread,
    selected: row.id === primaryThreadId,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const chatInclude = {
  messages: { orderBy: { seq: "desc" as const }, take: 1, select: { blocks: true } },
};

async function ownedBotThread(
  prisma: PrismaClient,
  actor: Actor,
  threadId: string,
  options: { includeArchived?: boolean } = {},
) {
  const row = await prisma.thread.findFirst({
    where: {
      id: threadId,
      workspaceId: actor.workspaceId,
      botId: { not: null },
      ...(options.includeArchived ? {} : { archivedAt: null }),
    },
    include: chatInclude,
  });
  if (!row?.botId) throw new IsolationError();
  const bot = await createRepos(prisma).getBot(actor, row.botId);
  return { row, bot };
}

export async function listBotChats(
  prisma: PrismaClient,
  actor: Actor,
  input: { botId: string; includeArchived?: boolean },
): Promise<BotChat[]> {
  const bot = await createRepos(prisma).getBot(actor, input.botId);
  const rows = await prisma.thread.findMany({
    where: {
      workspaceId: actor.workspaceId,
      botId: bot.id,
      groupId: null,
      ...(input.includeArchived ? {} : { archivedAt: null }),
    },
    include: chatInclude,
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  });
  return rows.map((row) => chatDto(row, bot.primaryThreadId));
}

export async function createBotChat(
  prisma: PrismaClient,
  actor: Actor,
  input: { botId: string; title?: string },
): Promise<BotChat> {
  const bot = await createRepos(prisma).getBot(actor, input.botId);
  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const row = await tx.thread.create({
          data: {
            workspaceId: actor.workspaceId,
            botId: bot.id,
            userId: actor.userId,
            title: input.title?.trim() || NEW_CHAT_TITLE,
          },
          include: chatInclude,
        });
        await tx.bot.update({
          where: { id: bot.id },
          data: { primaryThreadId: row.id },
        });
        return chatDto(row, row.id);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export async function selectBotChat(
  prisma: PrismaClient,
  actor: Actor,
  threadId: string,
): Promise<BotChat> {
  const { row, bot } = await ownedBotThread(prisma, actor, threadId);
  await prisma.bot.update({
    where: { id: bot.id },
    data: { primaryThreadId: row.id },
  });
  return chatDto(row, row.id);
}

export async function renameBotChat(
  prisma: PrismaClient,
  actor: Actor,
  input: { threadId: string; title: string },
): Promise<BotChat> {
  const { row, bot } = await ownedBotThread(prisma, actor, input.threadId);
  const updated = await prisma.thread.update({
    where: { id: row.id },
    data: { title: input.title.trim() },
    include: chatInclude,
  });
  return chatDto(updated, bot.primaryThreadId);
}

export async function archiveBotChat(
  prisma: PrismaClient,
  actor: Actor,
  threadId: string,
): Promise<{ archivedThreadId: string; selected: BotChat }> {
  const { row, bot } = await ownedBotThread(prisma, actor, threadId);
  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const activeRuns = await tx.run.count({
          where: { threadId: row.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
        });
        if (activeRuns > 0) throw new ActiveThreadArchiveError();
        await tx.thread.update({
          where: { id: row.id },
          data: { archivedAt: new Date(), unread: false },
        });
        let selected =
          bot.primaryThreadId && bot.primaryThreadId !== row.id
            ? await tx.thread.findFirst({
                where: {
                  id: bot.primaryThreadId,
                  workspaceId: actor.workspaceId,
                  botId: bot.id,
                  archivedAt: null,
                },
                include: chatInclude,
              })
            : null;
        selected ??= await tx.thread.findFirst({
          where: {
            workspaceId: actor.workspaceId,
            botId: bot.id,
            groupId: null,
            archivedAt: null,
          },
          include: chatInclude,
          orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        });
        if (!selected) {
          selected = await tx.thread.create({
            data: {
              workspaceId: actor.workspaceId,
              botId: bot.id,
              userId: actor.userId,
              title: NEW_CHAT_TITLE,
            },
            include: chatInclude,
          });
        }
        await tx.bot.update({
          where: { id: bot.id },
          data: { primaryThreadId: selected.id },
        });
        return { archivedThreadId: row.id, selected: chatDto(selected, selected.id) };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export async function restoreBotChat(
  prisma: PrismaClient,
  actor: Actor,
  threadId: string,
): Promise<BotChat> {
  const { row, bot } = await ownedBotThread(prisma, actor, threadId, { includeArchived: true });
  const restored = await prisma.$transaction(async (tx) => {
    const updated = await tx.thread.update({
      where: { id: row.id },
      data: { archivedAt: null },
      include: chatInclude,
    });
    await tx.bot.update({
      where: { id: bot.id },
      data: { primaryThreadId: row.id },
    });
    return updated;
  });
  return chatDto(restored, restored.id);
}

export async function autoTitleBotChat(
  prisma: PrismaClient,
  threadId: string,
  text: string | undefined,
): Promise<void> {
  const title = text?.trim().replace(/\s+/g, " ");
  const updatedAt = new Date();
  const titled = title
    ? await prisma.thread.updateMany({
        where: { id: threadId, title: NEW_CHAT_TITLE },
        data: { title: title.slice(0, 80), updatedAt },
      })
    : { count: 0 };
  if (titled.count === 0) {
    await prisma.thread.updateMany({
      where: { id: threadId },
      data: { updatedAt },
    });
  }
}
