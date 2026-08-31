UPDATE "brandwell_workspace_model_credentials"
SET "limitReset" = 'monthly'
WHERE "limitReset" <> 'monthly';

UPDATE "brandwell_sidekick_model_credentials"
SET "limitReset" = 'monthly'
WHERE "limitReset" <> 'monthly';
