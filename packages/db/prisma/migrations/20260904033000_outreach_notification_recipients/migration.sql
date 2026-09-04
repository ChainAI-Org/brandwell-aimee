ALTER TABLE "brandwell_client_notifications" ADD COLUMN "targetUserIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
CREATE INDEX "brandwell_client_notifications_target_users" ON "brandwell_client_notifications" USING GIN ("targetUserIds");
