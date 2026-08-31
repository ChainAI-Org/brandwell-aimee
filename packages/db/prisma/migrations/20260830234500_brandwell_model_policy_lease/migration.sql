ALTER TABLE "brandwell_ai_workspaces"
  ADD COLUMN "modelPolicyLeaseOwner" TEXT,
  ADD COLUMN "modelPolicyLeaseExpiresAt" TIMESTAMP(3);

CREATE INDEX "brandwell_ai_workspaces_modelPolicyLeaseExpiresAt_idx"
  ON "brandwell_ai_workspaces"("modelPolicyLeaseExpiresAt");
