ALTER TABLE "bots"
  ADD COLUMN "primaryThreadId" TEXT;

ALTER TABLE "threads"
  ADD COLUMN "title" TEXT NOT NULL DEFAULT 'New chat',
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "bots" AS bot
SET "primaryThreadId" = thread."id"
FROM "threads" AS thread
WHERE thread."botId" = bot."id";

DROP INDEX "threads_botId_key";

CREATE UNIQUE INDEX "bots_primaryThreadId_key" ON "bots"("primaryThreadId");
CREATE INDEX "threads_botId_archivedAt_updatedAt_idx"
  ON "threads"("botId", "archivedAt", "updatedAt");

ALTER TABLE "bots"
  ADD CONSTRAINT "bots_primaryThreadId_fkey"
  FOREIGN KEY ("primaryThreadId") REFERENCES "threads"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
