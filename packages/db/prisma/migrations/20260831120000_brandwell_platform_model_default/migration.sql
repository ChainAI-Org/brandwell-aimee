ALTER TABLE "deployment_settings"
ADD COLUMN "brandwellDefaultModelId" TEXT NOT NULL DEFAULT 'openai/gpt-5.6-terra';

ALTER TABLE "brandwell_workspace_model_credentials"
ADD COLUMN "inheritsPlatformModelDefault" BOOLEAN NOT NULL DEFAULT true;

UPDATE "brandwell_workspace_model_credentials"
SET "preferredModel" = 'openai/gpt-5.6-terra'
WHERE "inheritsPlatformModelDefault" = true;

UPDATE "brandwell_sidekick_model_credentials" AS sidekick
SET "preferredModel" = 'openai/gpt-5.6-terra'
WHERE EXISTS (
    SELECT 1
    FROM "brandwell_workspace_model_credentials" AS master
    WHERE master."workspaceId" = sidekick."workspaceId"
      AND master."inheritsPlatformModelDefault" = true
);

UPDATE "bots"
SET "modelProvider" = 'openrouter',
    "modelId" = 'openai/gpt-5.6-terra'
WHERE "managedByBrandWell" = true
  AND "archivedAt" IS NULL;
