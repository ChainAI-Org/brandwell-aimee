CREATE TABLE "brandwell_sidekick_lifecycle_operations" (
  "id" TEXT NOT NULL,
  "sidekickId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "fromStatus" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "providerStatus" TEXT NOT NULL DEFAULT 'pending',
  "computerStatus" TEXT NOT NULL DEFAULT 'pending',
  "externalKeyHash" TEXT,
  "computerProviderRef" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 1,
  "lastError" TEXT,
  "auditMetadata" JSONB NOT NULL DEFAULT '{}',
  "result" JSONB NOT NULL DEFAULT '{}',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "brandwell_sidekick_lifecycle_operations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "brandwell_sidekick_lifecycle_operations_action_check"
    CHECK ("action" IN ('pause', 'resume', 'cancel')),
  CONSTRAINT "brandwell_sidekick_lifecycle_operations_status_check"
    CHECK ("status" IN ('running', 'failed', 'completed')),
  CONSTRAINT "brandwell_sidekick_lifecycle_operations_provider_status_check"
    CHECK ("providerStatus" IN ('pending', 'completed', 'not_required')),
  CONSTRAINT "brandwell_sidekick_lifecycle_operations_computer_status_check"
    CHECK ("computerStatus" IN ('pending', 'fenced', 'checkpointed', 'completed', 'not_required')),
  CONSTRAINT "brandwell_sidekick_lifecycle_operations_attempts_check"
    CHECK ("attempts" >= 1)
);

CREATE UNIQUE INDEX "brandwell_sidekick_lifecycle_operations_idempotencyKey_key"
  ON "brandwell_sidekick_lifecycle_operations"("idempotencyKey");

CREATE UNIQUE INDEX "brandwell_sidekick_lifecycle_operations_one_unfinished_idx"
  ON "brandwell_sidekick_lifecycle_operations"("sidekickId")
  WHERE "status" IN ('running', 'failed');

CREATE INDEX "brandwell_sidekick_lifecycle_operations_workspaceId_status_idx"
  ON "brandwell_sidekick_lifecycle_operations"("workspaceId", "status");

CREATE INDEX "brandwell_sidekick_lifecycle_operations_status_updatedAt_idx"
  ON "brandwell_sidekick_lifecycle_operations"("status", "updatedAt");

ALTER TABLE "brandwell_sidekick_lifecycle_operations"
  ADD CONSTRAINT "brandwell_sidekick_lifecycle_operations_sidekickId_fkey"
  FOREIGN KEY ("sidekickId") REFERENCES "brandwell_sidekicks"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "brandwell_sidekick_lifecycle_operations"
  ADD CONSTRAINT "brandwell_sidekick_lifecycle_operations_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
