import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  archiveBotChat,
  autoTitleBotChat,
  createBotChat,
  listBotChats,
  restoreBotChat,
  selectBotChat,
} from "./thread-chats.js";

const actor = {
  workspaceId: "workspace-1",
  userId: "user-1",
  email: "user@example.test",
  isDeploymentOwner: false,
} satisfies Actor;

const now = new Date("2026-08-30T21:00:00.000Z");

function bot(primaryThreadId = "thread-existing") {
  return {
    id: "bot-1",
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    archivedAt: null,
    primaryThreadId,
    thread: { id: primaryThreadId, botId: "bot-1", archivedAt: null },
    computer: null,
  };
}

function chatRow(id: string, title = "New chat") {
  return {
    id,
    botId: "bot-1",
    title,
    unread: false,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

describe("bot chat lifecycle", () => {
  it("creates and selects a retained chat without clearing existing messages", async () => {
    const updateBot = vi.fn().mockResolvedValue({});
    const deleteMessages = vi.fn();
    const tx = {
      thread: { create: vi.fn().mockResolvedValue(chatRow("thread-new")) },
      bot: { update: updateBot },
      message: { deleteMany: deleteMessages },
    };
    const prisma = {
      bot: { findFirst: vi.fn().mockResolvedValue(bot()) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    const created = await createBotChat(prisma, actor, { botId: "bot-1" });

    expect(created).toMatchObject({ id: "thread-new", selected: true, title: "New chat" });
    expect(updateBot).toHaveBeenCalledWith({
      where: { id: "bot-1" },
      data: { primaryThreadId: "thread-new" },
    });
    expect(deleteMessages).not.toHaveBeenCalled();
  });

  it("selects only an active workspace-owned chat", async () => {
    const updateBot = vi.fn().mockResolvedValue({});
    const row = chatRow("thread-two", "Campaign ideas");
    const prisma = {
      thread: { findFirst: vi.fn().mockResolvedValue(row) },
      bot: { findFirst: vi.fn().mockResolvedValue(bot()), update: updateBot },
    } as unknown as PrismaClient;

    const selected = await selectBotChat(prisma, actor, row.id);

    expect(selected).toMatchObject({ id: row.id, selected: true });
    expect(updateBot).toHaveBeenCalledWith({
      where: { id: "bot-1" },
      data: { primaryThreadId: row.id },
    });
  });

  it("lists active chats newest first with a safe message preview", async () => {
    const rows = [
      {
        ...chatRow("thread-new", "Newer"),
        messages: [{ blocks: [{ kind: "text", text: "Latest work" }] }],
      },
      chatRow("thread-old", "Older"),
    ];
    const findMany = vi.fn().mockResolvedValue(rows);
    const prisma = {
      bot: { findFirst: vi.fn().mockResolvedValue(bot("thread-new")) },
      thread: { findMany },
    } as unknown as PrismaClient;

    const chats = await listBotChats(prisma, actor, { botId: "bot-1" });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ botId: "bot-1", archivedAt: null }),
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      }),
    );
    expect(chats).toEqual([
      expect.objectContaining({ id: "thread-new", preview: "Latest work", selected: true }),
      expect.objectContaining({ id: "thread-old", selected: false }),
    ]);
  });

  it("archives without deleting messages and selects the next active chat", async () => {
    const row = chatRow("thread-old", "Retained history");
    const next = chatRow("thread-next", "Current work");
    const deleteMessages = vi.fn();
    const tx = {
      thread: {
        update: vi.fn().mockResolvedValue({ ...row, archivedAt: now }),
        findFirst: vi.fn().mockResolvedValue(next),
        create: vi.fn(),
      },
      bot: { update: vi.fn().mockResolvedValue({}) },
      run: { count: vi.fn().mockResolvedValue(0) },
      message: { deleteMany: deleteMessages },
    };
    const prisma = {
      thread: { findFirst: vi.fn().mockResolvedValue(row) },
      bot: { findFirst: vi.fn().mockResolvedValue(bot(row.id)) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    const result = await archiveBotChat(prisma, actor, row.id);

    expect(result).toMatchObject({
      archivedThreadId: row.id,
      selected: { id: next.id, selected: true },
    });
    expect(deleteMessages).not.toHaveBeenCalled();
    expect(tx.thread.create).not.toHaveBeenCalled();
  });

  it("restores an archived chat with its messages still retained", async () => {
    const archived = { ...chatRow("thread-archived", "Past work"), archivedAt: now };
    const restored = { ...archived, archivedAt: null };
    const deleteMessages = vi.fn();
    const tx = {
      thread: { update: vi.fn().mockResolvedValue(restored) },
      bot: { update: vi.fn().mockResolvedValue({}) },
      message: { deleteMany: deleteMessages },
    };
    const prisma = {
      thread: { findFirst: vi.fn().mockResolvedValue(archived) },
      bot: { findFirst: vi.fn().mockResolvedValue(bot("thread-current")) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;

    const result = await restoreBotChat(prisma, actor, archived.id);

    expect(result).toMatchObject({ id: archived.id, archivedAt: null, selected: true });
    expect(tx.thread.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: archived.id },
        data: { archivedAt: null },
      }),
    );
    expect(deleteMessages).not.toHaveBeenCalled();
  });
});

describe("chat recency and automatic titles", () => {
  it("touches an existing titled chat after every message so it can move to the top", async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const prisma = { thread: { updateMany } } as unknown as PrismaClient;

    await autoTitleBotChat(prisma, "thread-1", "Continue our campaign analysis");

    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "thread-1", title: "New chat" },
      data: {
        title: "Continue our campaign analysis",
        updatedAt: expect.any(Date),
      },
    });
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "thread-1" },
      data: { updatedAt: expect.any(Date) },
    });
  });
});
