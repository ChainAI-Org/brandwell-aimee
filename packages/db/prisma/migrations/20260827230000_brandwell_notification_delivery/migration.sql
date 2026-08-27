ALTER TABLE "brandwell_client_notifications"
ADD COLUMN "pushDeliveryStatus" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN "pushDeliveryAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "pushDeliveryNextAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "pushDeliveryLeaseOwner" TEXT,
ADD COLUMN "pushDeliveryLeaseExpiresAt" TIMESTAMP(3),
ADD COLUMN "pushDeliveryLastError" TEXT,
ADD COLUMN "pushSentAt" TIMESTAMP(3);

CREATE INDEX "brandwell_client_notifications_pushDeliveryStatus_pushDeliv_idx"
ON "brandwell_client_notifications"("pushDeliveryStatus", "pushDeliveryNextAt");
