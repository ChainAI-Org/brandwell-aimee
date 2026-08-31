import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../prisma/migrations/20260830231500_multiple_bot_chats/migration.sql", import.meta.url),
  "utf8",
);

describe("multiple bot chat migration", () => {
  it("backfills the selected chat and removes only the one-chat uniqueness constraint", () => {
    expect(migration).toContain('SET "primaryThreadId" = thread."id"');
    expect(migration).toContain('DROP INDEX "threads_botId_key"');
    expect(migration).toContain('CREATE INDEX "threads_botId_archivedAt_updatedAt_idx"');
  });

  it("does not delete existing threads or messages", () => {
    expect(migration).not.toMatch(/DELETE\s+FROM\s+"?(threads|messages)"?/i);
    expect(migration).not.toMatch(/DROP\s+TABLE\s+"?(threads|messages)"?/i);
  });
});
