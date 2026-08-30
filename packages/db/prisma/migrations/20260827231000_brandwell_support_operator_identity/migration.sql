ALTER TABLE "brandwell_support_sessions"
ADD COLUMN "operatorReference" TEXT NOT NULL DEFAULT 'brandwell_service',
ADD COLUMN "operatorName" TEXT NOT NULL DEFAULT 'BrandWell Support',
ADD COLUMN "operatorEmail" TEXT,
ADD COLUMN "controlLeaseId" TEXT,
ADD COLUMN "controlLeaseExpiresAt" TIMESTAMP(3);

ALTER TABLE "brandwell_support_sessions"
ALTER COLUMN "operatorReference" DROP DEFAULT,
ALTER COLUMN "operatorName" DROP DEFAULT;

CREATE INDEX "brandwell_support_sessions_operatorReference_startedAt_idx"
ON "brandwell_support_sessions"("operatorReference", "startedAt");

CREATE INDEX "brandwell_support_sessions_controlLeaseId_idx"
ON "brandwell_support_sessions"("controlLeaseId");
