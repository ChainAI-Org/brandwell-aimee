ALTER TABLE "brandwell_workspace_model_credentials"
  ADD COLUMN "modelCatalog" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "providerLimitReset" TEXT,
  ADD COLUMN "providerIncludeByokInLimit" BOOLEAN;

ALTER TABLE "brandwell_sidekick_model_credentials"
  ADD COLUMN "modelCatalog" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "providerLimitReset" TEXT,
  ADD COLUMN "providerIncludeByokInLimit" BOOLEAN;

ALTER TABLE "runs"
  ADD COLUMN "workloadType" TEXT NOT NULL DEFAULT 'general';
