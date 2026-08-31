CREATE TABLE "brandwell_worker_heartbeats" (
    "id" TEXT NOT NULL,
    "revision" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brandwell_worker_heartbeats_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "brandwell_worker_heartbeats_heartbeatAt_idx"
ON "brandwell_worker_heartbeats"("heartbeatAt");
