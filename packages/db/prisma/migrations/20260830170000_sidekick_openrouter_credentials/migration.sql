CREATE TABLE "brandwell_sidekick_model_credentials" (
  "id" TEXT NOT NULL,
  "sidekickId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "serviceIdentityId" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'openrouter',
  "secretId" TEXT NOT NULL,
  "externalKeyHash" TEXT,
  "externalWorkspaceId" TEXT,
  "limitReset" TEXT NOT NULL DEFAULT 'monthly',
  "status" TEXT NOT NULL DEFAULT 'active',
  "monthlyLimitMicros" BIGINT NOT NULL DEFAULT 0,
  "dailyLimitMicros" BIGINT,
  "warningLimitMicros" BIGINT NOT NULL DEFAULT 0,
  "currentUsageMicros" BIGINT NOT NULL DEFAULT 0,
  "providerLimitMicros" BIGINT,
  "providerUsageSyncedAt" TIMESTAMP(3),
  "providerUsageSyncError" TEXT,
  "preferredModel" TEXT NOT NULL,
  "computerModel" TEXT,
  "lightweightModel" TEXT,
  "reasoningModel" TEXT,
  "fallbackModels" JSONB NOT NULL DEFAULT '[]',
  "maxTokens" INTEGER,
  "thinkingLevel" TEXT,
  "disabledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "brandwell_sidekick_model_credentials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "brandwell_sidekick_model_credentials_sidekickId_key"
  ON "brandwell_sidekick_model_credentials"("sidekickId");
CREATE UNIQUE INDEX "brandwell_sidekick_model_credentials_secretId_key"
  ON "brandwell_sidekick_model_credentials"("secretId");
CREATE UNIQUE INDEX "brandwell_sidekick_model_credentials_externalKeyHash_key"
  ON "brandwell_sidekick_model_credentials"("externalKeyHash");
CREATE INDEX "brandwell_sidekick_model_credentials_workspaceId_status_idx"
  ON "brandwell_sidekick_model_credentials"("workspaceId", "status");
CREATE INDEX "brandwell_sidekick_model_credentials_status_disabledAt_idx"
  ON "brandwell_sidekick_model_credentials"("status", "disabledAt");

ALTER TABLE "brandwell_sidekick_model_credentials"
  ADD CONSTRAINT "brandwell_sidekick_model_credentials_sidekickId_fkey"
  FOREIGN KEY ("sidekickId") REFERENCES "brandwell_sidekicks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "brandwell_sidekick_model_credentials"
  ADD CONSTRAINT "brandwell_sidekick_model_credentials_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "brandwell_sidekick_model_credentials"
  ADD CONSTRAINT "brandwell_sidekick_model_credentials_serviceIdentityId_fkey"
  FOREIGN KEY ("serviceIdentityId") REFERENCES "brandwell_service_identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "brandwell_sidekick_model_credentials"
  ADD CONSTRAINT "brandwell_sidekick_model_credentials_secretId_fkey"
  FOREIGN KEY ("secretId") REFERENCES "secrets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "brandwell_sidekick_model_credentials"
  ADD CONSTRAINT "brandwell_sidekick_model_credentials_status_check"
  CHECK ("status" IN ('active', 'disabled', 'revoked'));
ALTER TABLE "brandwell_sidekick_model_credentials"
  ADD CONSTRAINT "brandwell_sidekick_model_credentials_limitReset_check"
  CHECK ("limitReset" IN ('daily', 'weekly', 'monthly'));
ALTER TABLE "brandwell_sidekick_model_credentials"
  ADD CONSTRAINT "brandwell_sidekick_model_credentials_limits_check"
  CHECK (
    "monthlyLimitMicros" >= 0
    AND ("dailyLimitMicros" IS NULL OR "dailyLimitMicros" >= 0)
    AND "warningLimitMicros" >= 0
    AND "currentUsageMicros" >= 0
    AND ("providerLimitMicros" IS NULL OR "providerLimitMicros" >= 0)
  );
