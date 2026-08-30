-- BrandWell additions stay additive so existing Rakazo behavior remains intact.
ALTER TABLE "bots" ADD COLUMN "createdByUserId" TEXT,
ADD COLUMN "managedByBrandWell" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "managedStatus" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN "ownerType" TEXT NOT NULL DEFAULT 'user',
ADD COLUMN "serviceIdentityId" TEXT,
ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'private';

UPDATE "bots" SET "createdByUserId" = "userId" WHERE "createdByUserId" IS NULL;

ALTER TABLE "runs" ADD COLUMN "serviceIdentityId" TEXT;
ALTER TABLE "routines" ADD COLUMN "serviceIdentityId" TEXT;

ALTER TABLE "connections" ADD COLUMN "ownerType" TEXT NOT NULL DEFAULT 'user',
ADD COLUMN "serviceIdentityId" TEXT;

ALTER TABLE "capability_installs" ADD COLUMN "ownerType" TEXT NOT NULL DEFAULT 'user',
ADD COLUMN "serviceIdentityId" TEXT;

ALTER TABLE "computers" ADD COLUMN "controlActorName" TEXT,
ADD COLUMN "controlActorType" TEXT,
ADD COLUMN "controlStartedAt" TIMESTAMP(3),
ADD COLUMN "controlUserId" TEXT,
ADD COLUMN "lastComputerActivityAt" TIMESTAMP(3),
ADD COLUMN "lastComputerState" TEXT,
ADD COLUMN "lastScreenshotAt" TIMESTAMP(3);

ALTER TABLE "usage_records" ADD COLUMN "costMicros" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'USD',
ADD COLUMN "serviceIdentityId" TEXT,
ADD COLUMN "workloadType" TEXT NOT NULL DEFAULT 'general';

ALTER TABLE "secrets" ADD COLUMN "ownerType" TEXT NOT NULL DEFAULT 'user',
ADD COLUMN "serviceIdentityId" TEXT;

CREATE TABLE "brandwell_ai_workspaces" (
    "id" TEXT NOT NULL,
    "brandwellCustomerId" TEXT NOT NULL,
    "rakazoWorkspaceId" TEXT NOT NULL,
    "primaryBotId" TEXT,
    "serviceIdentityId" TEXT,
    "openRouterCredentialId" TEXT,
    "subscriptionStatus" TEXT NOT NULL DEFAULT 'provisioning',
    "plan" TEXT NOT NULL DEFAULT 'aimee',
    "provisioningStatus" TEXT NOT NULL DEFAULT 'pending',
    "provisioningError" TEXT,
    "provisioningMetadata" JSONB NOT NULL DEFAULT '{}',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "primaryContactEmail" TEXT NOT NULL,
    "retentionEndsAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "brandwell_ai_workspaces_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "brandwell_service_identities" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "brandwell_service_identities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "brandwell_workspace_model_credentials" (
    "id" TEXT NOT NULL,
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
    CONSTRAINT "brandwell_workspace_model_credentials_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "brandwell_operator_assignments" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'brandwell_operator',
    "permissions" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "brandwell_operator_assignments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "brandwell_alerts" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "botId" TEXT,
    "runId" TEXT,
    "source" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "type" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "technicalDetails" JSONB NOT NULL DEFAULT '{}',
    "clientActionRequired" BOOLEAN NOT NULL DEFAULT false,
    "brandwellActionRequired" BOOLEAN NOT NULL DEFAULT false,
    "assignedOperatorId" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "brandwell_alerts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "brandwell_client_notifications" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "botId" TEXT,
    "runId" TEXT,
    "dedupeKey" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "requiresAction" BOOLEAN NOT NULL DEFAULT false,
    "actionType" TEXT,
    "actionTarget" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    CONSTRAINT "brandwell_client_notifications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "brandwell_support_sessions" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "computerId" TEXT NOT NULL,
    "botId" TEXT,
    "operatorUserId" TEXT NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "actionsMetadata" JSONB NOT NULL DEFAULT '{}',
    CONSTRAINT "brandwell_support_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "brandwell_audit_logs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorType" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "brandwell_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "brandwell_cancellation_events" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "reason" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastError" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "brandwell_cancellation_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "brandwell_ai_workspaces_brandwellCustomerId_key" ON "brandwell_ai_workspaces"("brandwellCustomerId");
CREATE UNIQUE INDEX "brandwell_ai_workspaces_rakazoWorkspaceId_key" ON "brandwell_ai_workspaces"("rakazoWorkspaceId");
CREATE INDEX "brandwell_ai_workspaces_subscriptionStatus_provisioningStat_idx" ON "brandwell_ai_workspaces"("subscriptionStatus", "provisioningStatus");
CREATE INDEX "brandwell_service_identities_workspaceId_status_idx" ON "brandwell_service_identities"("workspaceId", "status");
CREATE UNIQUE INDEX "brandwell_service_identities_workspaceId_name_key" ON "brandwell_service_identities"("workspaceId", "name");
CREATE UNIQUE INDEX "brandwell_workspace_model_credentials_workspaceId_key" ON "brandwell_workspace_model_credentials"("workspaceId");
CREATE UNIQUE INDEX "brandwell_workspace_model_credentials_serviceIdentityId_key" ON "brandwell_workspace_model_credentials"("serviceIdentityId");
CREATE UNIQUE INDEX "brandwell_workspace_model_credentials_secretId_key" ON "brandwell_workspace_model_credentials"("secretId");
CREATE UNIQUE INDEX "brandwell_workspace_model_credentials_externalKeyHash_key" ON "brandwell_workspace_model_credentials"("externalKeyHash");
CREATE INDEX "brandwell_workspace_model_credentials_status_disabledAt_idx" ON "brandwell_workspace_model_credentials"("status", "disabledAt");
CREATE INDEX "brandwell_operator_assignments_userId_role_idx" ON "brandwell_operator_assignments"("userId", "role");
CREATE UNIQUE INDEX "brandwell_operator_assignments_workspaceId_userId_key" ON "brandwell_operator_assignments"("workspaceId", "userId");
CREATE INDEX "brandwell_alerts_status_severity_createdAt_idx" ON "brandwell_alerts"("status", "severity", "createdAt");
CREATE INDEX "brandwell_alerts_workspaceId_status_idx" ON "brandwell_alerts"("workspaceId", "status");
CREATE UNIQUE INDEX "brandwell_alerts_workspaceId_dedupeKey_key" ON "brandwell_alerts"("workspaceId", "dedupeKey");
CREATE INDEX "brandwell_client_notifications_workspaceId_createdAt_idx" ON "brandwell_client_notifications"("workspaceId", "createdAt");
CREATE INDEX "brandwell_client_notifications_workspaceId_resolvedAt_requi_idx" ON "brandwell_client_notifications"("workspaceId", "resolvedAt", "requiresAction");
CREATE UNIQUE INDEX "brandwell_client_notifications_workspaceId_dedupeKey_key" ON "brandwell_client_notifications"("workspaceId", "dedupeKey");
CREATE INDEX "brandwell_support_sessions_workspaceId_startedAt_idx" ON "brandwell_support_sessions"("workspaceId", "startedAt");
CREATE INDEX "brandwell_support_sessions_operatorUserId_startedAt_idx" ON "brandwell_support_sessions"("operatorUserId", "startedAt");
CREATE INDEX "brandwell_audit_logs_workspaceId_createdAt_idx" ON "brandwell_audit_logs"("workspaceId", "createdAt");
CREATE INDEX "brandwell_audit_logs_actorUserId_createdAt_idx" ON "brandwell_audit_logs"("actorUserId", "createdAt");
CREATE INDEX "brandwell_cancellation_events_workspaceId_createdAt_idx" ON "brandwell_cancellation_events"("workspaceId", "createdAt");
CREATE INDEX "brandwell_cancellation_events_stage_scheduledAt_idx" ON "brandwell_cancellation_events"("stage", "scheduledAt");
CREATE UNIQUE INDEX "brandwell_cancellation_events_workspaceId_stage_key" ON "brandwell_cancellation_events"("workspaceId", "stage");
CREATE INDEX "bots_workspaceId_ownerType_visibility_managedStatus_archive_idx" ON "bots"("workspaceId", "ownerType", "visibility", "managedStatus", "archivedAt");
CREATE INDEX "bots_serviceIdentityId_idx" ON "bots"("serviceIdentityId");
CREATE INDEX "runs_serviceIdentityId_createdAt_idx" ON "runs"("serviceIdentityId", "createdAt");
CREATE INDEX "routines_serviceIdentityId_active_nextRunAt_idx" ON "routines"("serviceIdentityId", "active", "nextRunAt");
CREATE INDEX "connections_workspaceId_ownerType_serviceIdentityId_connect_idx" ON "connections"("workspaceId", "ownerType", "serviceIdentityId", "connectorId");
CREATE INDEX "capability_installs_workspaceId_ownerType_serviceIdentityId_idx" ON "capability_installs"("workspaceId", "ownerType", "serviceIdentityId");
CREATE INDEX "usage_records_workspaceId_serviceIdentityId_createdAt_idx" ON "usage_records"("workspaceId", "serviceIdentityId", "createdAt");
CREATE INDEX "secrets_workspaceId_ownerType_serviceIdentityId_idx" ON "secrets"("workspaceId", "ownerType", "serviceIdentityId");

ALTER TABLE "bots" ADD CONSTRAINT "bots_serviceIdentityId_fkey" FOREIGN KEY ("serviceIdentityId") REFERENCES "brandwell_service_identities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "runs" ADD CONSTRAINT "runs_serviceIdentityId_fkey" FOREIGN KEY ("serviceIdentityId") REFERENCES "brandwell_service_identities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "routines" ADD CONSTRAINT "routines_serviceIdentityId_fkey" FOREIGN KEY ("serviceIdentityId") REFERENCES "brandwell_service_identities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "connections" ADD CONSTRAINT "connections_serviceIdentityId_fkey" FOREIGN KEY ("serviceIdentityId") REFERENCES "brandwell_service_identities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "capability_installs" ADD CONSTRAINT "capability_installs_serviceIdentityId_fkey" FOREIGN KEY ("serviceIdentityId") REFERENCES "brandwell_service_identities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_serviceIdentityId_fkey" FOREIGN KEY ("serviceIdentityId") REFERENCES "brandwell_service_identities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_serviceIdentityId_fkey" FOREIGN KEY ("serviceIdentityId") REFERENCES "brandwell_service_identities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "brandwell_ai_workspaces" ADD CONSTRAINT "brandwell_ai_workspaces_rakazoWorkspaceId_fkey" FOREIGN KEY ("rakazoWorkspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "brandwell_service_identities" ADD CONSTRAINT "brandwell_service_identities_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "brandwell_service_identities" ADD CONSTRAINT "brandwell_service_identities_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "brandwell_workspace_model_credentials" ADD CONSTRAINT "brandwell_workspace_model_credentials_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "brandwell_workspace_model_credentials" ADD CONSTRAINT "brandwell_workspace_model_credentials_serviceIdentityId_fkey" FOREIGN KEY ("serviceIdentityId") REFERENCES "brandwell_service_identities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "brandwell_workspace_model_credentials" ADD CONSTRAINT "brandwell_workspace_model_credentials_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "secrets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "brandwell_operator_assignments" ADD CONSTRAINT "brandwell_operator_assignments_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "brandwell_operator_assignments" ADD CONSTRAINT "brandwell_operator_assignments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "brandwell_alerts" ADD CONSTRAINT "brandwell_alerts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "brandwell_client_notifications" ADD CONSTRAINT "brandwell_client_notifications_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "brandwell_support_sessions" ADD CONSTRAINT "brandwell_support_sessions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "brandwell_support_sessions" ADD CONSTRAINT "brandwell_support_sessions_operatorUserId_fkey" FOREIGN KEY ("operatorUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "brandwell_audit_logs" ADD CONSTRAINT "brandwell_audit_logs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "brandwell_audit_logs" ADD CONSTRAINT "brandwell_audit_logs_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "brandwell_cancellation_events" ADD CONSTRAINT "brandwell_cancellation_events_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
