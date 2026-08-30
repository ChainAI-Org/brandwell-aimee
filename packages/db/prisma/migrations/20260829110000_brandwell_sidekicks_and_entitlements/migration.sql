-- BrandWell commercial desired state and Sidekick seats are additive to the
-- generic Rakazo workspace model.
ALTER TABLE "brandwell_ai_workspaces"
  ADD COLUMN "brandwellAgencyId" TEXT,
  ADD COLUMN "brandwellClientId" TEXT,
  ADD COLUMN "brandwellContractId" TEXT,
  ADD COLUMN "commercialRevision" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "commercialStatus" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "masterSeats" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "sidekickSeats" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "skillBundleVersion" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "agent_skills"
  ADD COLUMN "managedKey" TEXT,
  ADD COLUMN "managedVersion" INTEGER;

CREATE UNIQUE INDEX "agent_skills_workspaceId_userId_managedKey_key"
  ON "agent_skills"("workspaceId", "userId", "managedKey");

CREATE TABLE "brandwell_sidekicks" (
  "id" TEXT NOT NULL,
  "brandwellSidekickId" TEXT NOT NULL,
  "aiWorkspaceId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "roleTitle" TEXT NOT NULL DEFAULT 'GTM Teammate',
  "status" TEXT NOT NULL DEFAULT 'provisioning',
  "userId" TEXT,
  "botId" TEXT,
  "computerId" TEXT,
  "invitationId" TEXT,
  "skillBundleVersion" INTEGER NOT NULL DEFAULT 1,
  "commercialRevision" BIGINT NOT NULL DEFAULT 0,
  "activatedAt" TIMESTAMP(3),
  "pausedAt" TIMESTAMP(3),
  "canceledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "brandwell_sidekicks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "brandwell_sidekicks_brandwellSidekickId_key"
  ON "brandwell_sidekicks"("brandwellSidekickId");
CREATE UNIQUE INDEX "brandwell_sidekicks_botId_key"
  ON "brandwell_sidekicks"("botId");
CREATE UNIQUE INDEX "brandwell_sidekicks_computerId_key"
  ON "brandwell_sidekicks"("computerId");
CREATE UNIQUE INDEX "brandwell_sidekicks_aiWorkspaceId_email_key"
  ON "brandwell_sidekicks"("aiWorkspaceId", "email");
CREATE INDEX "brandwell_sidekicks_workspaceId_status_idx"
  ON "brandwell_sidekicks"("workspaceId", "status");
CREATE INDEX "brandwell_sidekicks_userId_status_idx"
  ON "brandwell_sidekicks"("userId", "status");

ALTER TABLE "brandwell_sidekicks"
  ADD CONSTRAINT "brandwell_sidekicks_aiWorkspaceId_fkey"
  FOREIGN KEY ("aiWorkspaceId") REFERENCES "brandwell_ai_workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "brandwell_sidekicks"
  ADD CONSTRAINT "brandwell_sidekicks_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "brandwell_sidekicks"
  ADD CONSTRAINT "brandwell_sidekicks_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "brandwell_sidekicks"
  ADD CONSTRAINT "brandwell_sidekicks_botId_fkey"
  FOREIGN KEY ("botId") REFERENCES "bots"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "brandwell_sidekicks"
  ADD CONSTRAINT "brandwell_sidekicks_computerId_fkey"
  FOREIGN KEY ("computerId") REFERENCES "computers"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "brandwell_ai_workspaces"
  ADD CONSTRAINT "brandwell_ai_workspaces_masterSeats_check"
  CHECK ("masterSeats" = 1),
  ADD CONSTRAINT "brandwell_ai_workspaces_sidekickSeats_check"
  CHECK ("sidekickSeats" >= 0),
  ADD CONSTRAINT "brandwell_ai_workspaces_skillBundleVersion_check"
  CHECK ("skillBundleVersion" >= 1);

ALTER TABLE "brandwell_sidekicks"
  ADD CONSTRAINT "brandwell_sidekicks_status_check"
  CHECK ("status" IN ('provisioning','invited','active','paused','canceling','canceled','failed')),
  ADD CONSTRAINT "brandwell_sidekicks_skillBundleVersion_check"
  CHECK ("skillBundleVersion" >= 1);
