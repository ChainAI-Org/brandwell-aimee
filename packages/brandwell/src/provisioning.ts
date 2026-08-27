import { randomUUID } from "node:crypto";

export const BRANDWELL_PROVISIONING_STEPS = [
  "workspace",
  "service_identity",
  "client_admin_membership",
  "primary_aimee",
  "team_computer",
  "openrouter_credential",
  "model_configuration",
  "default_routines",
  "brandwell_skills",
  "intent_connection",
  "trafficid_connection",
  "postcard_connection",
  "connector_onboarding",
  "mobile_access",
  "notification_preferences",
] as const;

export type BrandwellProvisioningStep = (typeof BRANDWELL_PROVISIONING_STEPS)[number];

export type BrandwellProvisioningInput = {
  brandwellCustomerId: string;
  companyName: string;
  primaryContactName: string;
  primaryContactEmail: string;
  plan: string;
  timezone: string;
};

export type BrandwellProvisioningPlan = {
  idempotencyKey: string;
  input: BrandwellProvisioningInput;
  steps: Array<{
    name: BrandwellProvisioningStep;
    status: "pending";
  }>;
};

export type BrandwellProvisioningStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "rolled_back"
  | "rollback_failed";

export type BrandwellProvisioningStepState = {
  name: BrandwellProvisioningStep;
  status: BrandwellProvisioningStepStatus;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  error?: string;
  startedAt?: string;
  completedAt?: string;
};

export type BrandwellProvisioningCheckpoint = {
  version: 1;
  idempotencyKey: string;
  input: BrandwellProvisioningInput;
  status: "pending" | "running" | "complete" | "failed" | "rollback_failed";
  runId: string;
  steps: BrandwellProvisioningStepState[];
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
};

export type BrandwellProvisioningStepResult = {
  resourceId?: string;
  metadata?: Record<string, unknown>;
};

export type BrandwellProvisioningRunner = {
  load(idempotencyKey: string): Promise<BrandwellProvisioningCheckpoint | null>;
  save(checkpoint: BrandwellProvisioningCheckpoint): Promise<void>;
  execute(
    step: BrandwellProvisioningStep,
    checkpoint: BrandwellProvisioningCheckpoint,
  ): Promise<BrandwellProvisioningStepResult | undefined>;
  rollback(
    step: BrandwellProvisioningStep,
    checkpoint: BrandwellProvisioningCheckpoint,
  ): Promise<void>;
  now?: () => Date;
  createRunId?: () => string;
};

export class BrandwellProvisioningError extends Error {
  constructor(
    message: string,
    readonly checkpoint: BrandwellProvisioningCheckpoint,
  ) {
    super(message);
    this.name = "BrandwellProvisioningError";
  }
}

export function buildBrandwellProvisioningPlan(
  input: BrandwellProvisioningInput,
): BrandwellProvisioningPlan {
  const customerId = input.brandwellCustomerId.trim();
  if (!customerId) throw new Error("brandwellCustomerId is required");
  const companyName = input.companyName.trim();
  if (!companyName) throw new Error("companyName is required");
  const primaryContactEmail = input.primaryContactEmail.trim().toLowerCase();
  if (!primaryContactEmail?.includes("@")) {
    throw new Error("primaryContactEmail must be valid");
  }
  const timezone = input.timezone.trim();
  if (!timezone) throw new Error("timezone is required");

  return {
    idempotencyKey: `brandwell:provision:${customerId}`,
    input: {
      ...input,
      brandwellCustomerId: customerId,
      companyName,
      primaryContactEmail,
      primaryContactName: input.primaryContactName.trim(),
      plan: input.plan.trim() || "aimee",
      timezone,
    },
    steps: BRANDWELL_PROVISIONING_STEPS.map((name) => ({ name, status: "pending" })),
  };
}

export function rollbackOrderForCompletedSteps(
  completed: readonly BrandwellProvisioningStep[],
): BrandwellProvisioningStep[] {
  const completedSet = new Set(completed);
  return [...BRANDWELL_PROVISIONING_STEPS].reverse().filter((step) => completedSet.has(step));
}

export async function provisionBrandwellWorkspace(
  input: BrandwellProvisioningInput,
  runner: BrandwellProvisioningRunner,
): Promise<BrandwellProvisioningCheckpoint> {
  const plan = buildBrandwellProvisioningPlan(input);
  const existing = await runner.load(plan.idempotencyKey);
  if (existing?.status === "complete") return existing;
  if (existing?.status === "running") {
    throw new BrandwellProvisioningError("Provisioning is already running", existing);
  }

  const now = runner.now ?? (() => new Date());
  const createRunId = runner.createRunId ?? randomUUID;
  const startedAt = now().toISOString();
  let checkpoint: BrandwellProvisioningCheckpoint = {
    version: 1,
    idempotencyKey: plan.idempotencyKey,
    input: plan.input,
    status: "running",
    runId: createRunId(),
    steps: BRANDWELL_PROVISIONING_STEPS.map((name) => ({ name, status: "pending" })),
    startedAt,
    updatedAt: startedAt,
  };
  await runner.save(checkpoint);

  for (const step of BRANDWELL_PROVISIONING_STEPS) {
    checkpoint = updateStep(checkpoint, step, {
      status: "running",
      startedAt: now().toISOString(),
    });
    await runner.save(checkpoint);

    try {
      const result = await runner.execute(step, checkpoint);
      checkpoint = updateStep(checkpoint, step, {
        status: "completed",
        completedAt: now().toISOString(),
        ...(result?.resourceId ? { resourceId: result.resourceId } : {}),
        ...(result?.metadata ? { metadata: result.metadata } : {}),
      });
      await runner.save(checkpoint);
    } catch (error) {
      const message = safeProvisioningError(error);
      checkpoint = updateStep(checkpoint, step, { status: "failed", error: message });
      checkpoint = { ...checkpoint, status: "failed", error: message };
      await runner.save(checkpoint);
      checkpoint = await rollbackCompletedProvisioning(checkpoint, runner, now);
      throw new BrandwellProvisioningError(
        checkpoint.status === "rollback_failed"
          ? "Provisioning failed and one or more rollback actions failed"
          : "Provisioning failed and completed work was rolled back",
        checkpoint,
      );
    }
  }

  const completedAt = now().toISOString();
  checkpoint = {
    ...checkpoint,
    status: "complete",
    completedAt,
    updatedAt: completedAt,
  };
  await runner.save(checkpoint);
  return checkpoint;
}

async function rollbackCompletedProvisioning(
  checkpoint: BrandwellProvisioningCheckpoint,
  runner: BrandwellProvisioningRunner,
  now: () => Date,
): Promise<BrandwellProvisioningCheckpoint> {
  const completed = checkpoint.steps
    .filter((step) => step.status === "completed")
    .map((step) => step.name);
  let rollbackFailed = false;
  for (const step of rollbackOrderForCompletedSteps(completed)) {
    try {
      await runner.rollback(step, checkpoint);
      checkpoint = updateStep(checkpoint, step, {
        status: "rolled_back",
        completedAt: now().toISOString(),
      });
    } catch (error) {
      rollbackFailed = true;
      checkpoint = updateStep(checkpoint, step, {
        status: "rollback_failed",
        error: safeProvisioningError(error),
      });
    }
    await runner.save(checkpoint);
  }
  checkpoint = {
    ...checkpoint,
    status: rollbackFailed ? "rollback_failed" : "failed",
    updatedAt: now().toISOString(),
  };
  await runner.save(checkpoint);
  return checkpoint;
}

function updateStep(
  checkpoint: BrandwellProvisioningCheckpoint,
  name: BrandwellProvisioningStep,
  patch: Partial<BrandwellProvisioningStepState>,
): BrandwellProvisioningCheckpoint {
  return {
    ...checkpoint,
    steps: checkpoint.steps.map((step) => (step.name === name ? { ...step, ...patch } : step)),
    updatedAt: patch.completedAt ?? patch.startedAt ?? checkpoint.updatedAt,
  };
}

function safeProvisioningError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.slice(0, 500);
  return "Provisioning step failed";
}
