ALTER TABLE "user"
  ADD COLUMN "brandwellUserId" TEXT;

ALTER TABLE "brandwell_ai_workspaces"
  ADD COLUMN "primaryBrandwellUserId" TEXT;

ALTER TABLE "brandwell_sidekicks"
  ADD COLUMN "brandwellUserId" TEXT;

CREATE UNIQUE INDEX "user_brandwellUserId_key"
  ON "user"("brandwellUserId");

CREATE UNIQUE INDEX "brandwell_sidekicks_aiWorkspaceId_brandwellUserId_key"
  ON "brandwell_sidekicks"("aiWorkspaceId", "brandwellUserId");

CREATE INDEX "brandwell_ai_workspaces_primaryBrandwellUserId_idx"
  ON "brandwell_ai_workspaces"("primaryBrandwellUserId");
