ALTER TABLE "brandwell_workspace_model_credentials"
  ADD COLUMN "providerLimitMicros" BIGINT,
  ADD COLUMN "providerUsageSyncedAt" TIMESTAMP(3),
  ADD COLUMN "providerUsageSyncError" TEXT;
