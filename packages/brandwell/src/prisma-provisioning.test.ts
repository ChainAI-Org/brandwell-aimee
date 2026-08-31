import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  createPrismaBrandwellProvisioningRunner,
  validateBrandwellProvisioningModels,
} from "./prisma-provisioning.js";
import type { BrandwellProvisioningCheckpoint } from "./provisioning.js";

function options(monthlyLimitMicros: bigint, warningLimitMicros: bigint) {
  return {
    prisma: {} as PrismaClient,
    secretCipher: { encrypt: vi.fn() },
    openRouter: {
      createKey: vi.fn(),
      deleteKey: vi.fn(),
      getModel: vi.fn(),
      updateKey: vi.fn(),
    },
    sandboxKind: "daytona",
    defaultModel: "openai/gpt-5.4-mini",
    monthlyLimitMicros,
    warningLimitMicros,
  };
}

describe("BrandWell initial provisioning policy", () => {
  it("rejects a master OpenRouter budget above the product-wide $200 cap", () => {
    expect(() =>
      createPrismaBrandwellProvisioningRunner(options(200_000_001n, 150_000_000n)),
    ).toThrow(/at most \$200/);
  });

  it("rejects warning and daily limits above the monthly budget", () => {
    expect(() =>
      createPrismaBrandwellProvisioningRunner(options(100_000_000n, 100_000_001n)),
    ).toThrow(/warning limits/);
    expect(() =>
      createPrismaBrandwellProvisioningRunner({
        ...options(100_000_000n, 75_000_000n),
        dailyLimitMicros: 100_000_001n,
      }),
    ).toThrow(/daily limits/);
  });

  it("rejects a computer model without image input before creating a child key", async () => {
    const provisioningOptions = {
      ...options(200_000_000n, 150_000_000n),
      computerModel: "provider/text-only",
    };
    provisioningOptions.openRouter.getModel.mockImplementation(async (id: string) => ({
      id,
      name: id,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportedParameters: ["tools"],
      reasoning: false,
      pricing: {},
    }));

    await expect(validateBrandwellProvisioningModels(provisioningOptions)).rejects.toThrow(
      /computer model must support image input/,
    );
    expect(provisioningOptions.openRouter.createKey).not.toHaveBeenCalled();
  });

  it("persists validated metadata for every centrally configured model", async () => {
    const provisioningOptions = {
      ...options(200_000_000n, 150_000_000n),
      fallbackModels: ["provider/fallback"],
    };
    provisioningOptions.openRouter.getModel.mockImplementation(async (id: string) => ({
      id,
      name: id,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportedParameters: ["tools"],
      reasoning: false,
      pricing: {},
    }));

    await expect(validateBrandwellProvisioningModels(provisioningOptions)).resolves.toEqual({
      "openai/gpt-5.4-mini": expect.objectContaining({ id: "openai/gpt-5.4-mini" }),
      "provider/fallback": expect.objectContaining({ id: "provider/fallback" }),
    });
  });

  it("patches an existing provider key from persisted policy without overwriting a newer central update", async () => {
    const events: string[] = [];
    const credential = {
      id: "credential-1",
      workspaceId: "workspace-1",
      externalKeyHash: "hash-1",
      limitReset: "monthly",
      monthlyLimitMicros: 125_000_000n,
      preferredModel: "provider/centrally-updated",
    };
    const credentialUpdate = vi.fn(
      async (_args: { where: { id: string }; data: Record<string, unknown> }) => {
        events.push("database");
        return credential;
      },
    );
    const updateKey = vi.fn(async () => {
      events.push("provider");
      return {
        hash: "hash-1",
        disabled: false,
        usageUsd: 0,
        usageDailyUsd: 0,
        usageMonthlyUsd: 0,
        limitUsd: 125,
        limitReset: "monthly" as const,
        includeByokInLimit: true,
      };
    });
    const leaseUpdate = vi.fn(async (args: { data: { modelPolicyLeaseOwner?: string | null } }) => {
      events.push(
        args.data.modelPolicyLeaseOwner === null
          ? "release"
          : args.data.modelPolicyLeaseOwner
            ? "acquire"
            : "renew",
      );
      return { count: 1 };
    });
    const prisma = {
      user: { findUnique: vi.fn(async () => ({ id: "system-1" })) },
      brandwellAiWorkspace: {
        findUnique: vi.fn(async () => ({
          id: "mapping-1",
          rakazoWorkspaceId: "workspace-1",
        })),
        updateMany: leaseUpdate,
      },
      brandwellWorkspaceModelCredential: {
        findUniqueOrThrow: vi.fn(async () => credential),
        update: credentialUpdate,
      },
    } as unknown as PrismaClient;
    const runner = createPrismaBrandwellProvisioningRunner({
      ...options(200_000_000n, 150_000_000n),
      prisma,
      systemUserId: "system-1",
      defaultModel: "provider/stale-provisioning-env",
      openRouter: {
        createKey: vi.fn(),
        deleteKey: vi.fn(),
        getModel: vi.fn(),
        updateKey,
      },
    });

    await expect(runner.execute("model_configuration", provisioningCheckpoint())).resolves.toEqual({
      resourceId: "credential-1",
    });
    expect(updateKey).toHaveBeenCalledWith("hash-1", {
      limitUsd: 125,
      limitReset: "monthly",
    });
    expect(credentialUpdate).toHaveBeenCalledWith({
      where: { id: "credential-1" },
      data: {
        limitReset: "monthly",
        providerLimitMicros: 125_000_000n,
        providerLimitReset: "monthly",
        providerIncludeByokInLimit: true,
      },
    });
    expect(credentialUpdate.mock.calls[0]?.[0].data).not.toHaveProperty("preferredModel");
    expect(events).toEqual(["acquire", "provider", "renew", "database", "release"]);
  });

  it("does not substitute desired values when provider PATCH omits policy evidence", async () => {
    const credential = {
      id: "credential-1",
      workspaceId: "workspace-1",
      externalKeyHash: "hash-1",
      limitReset: "daily",
      monthlyLimitMicros: 125_000_000n,
    };
    const credentialUpdate = vi.fn(async () => credential);
    const prisma = {
      user: { findUnique: vi.fn(async () => ({ id: "system-1" })) },
      brandwellAiWorkspace: {
        findUnique: vi.fn(async () => ({
          id: "mapping-1",
          rakazoWorkspaceId: "workspace-1",
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      brandwellWorkspaceModelCredential: {
        findUniqueOrThrow: vi.fn(async () => credential),
        update: credentialUpdate,
      },
    } as unknown as PrismaClient;
    const runner = createPrismaBrandwellProvisioningRunner({
      ...options(200_000_000n, 150_000_000n),
      prisma,
      systemUserId: "system-1",
      openRouter: {
        createKey: vi.fn(),
        deleteKey: vi.fn(),
        getModel: vi.fn(),
        updateKey: vi.fn(async () => ({
          hash: "hash-1",
          disabled: false,
          usageUsd: 0,
          usageDailyUsd: 0,
          usageMonthlyUsd: 0,
        })),
      },
    });

    await expect(runner.execute("model_configuration", provisioningCheckpoint())).resolves.toEqual({
      resourceId: "credential-1",
    });
    expect(credentialUpdate).toHaveBeenCalledWith({
      where: { id: "credential-1" },
      data: {
        limitReset: "monthly",
        providerLimitMicros: null,
        providerLimitReset: null,
        providerIncludeByokInLimit: null,
      },
    });
  });

  it("releases the policy lease and leaves the database unchanged when provider PATCH fails", async () => {
    const leaseUpdate = vi.fn(async () => ({ count: 1 }));
    const credentialUpdate = vi.fn();
    const prisma = {
      user: { findUnique: vi.fn(async () => ({ id: "system-1" })) },
      brandwellAiWorkspace: {
        findUnique: vi.fn(async () => ({
          id: "mapping-1",
          rakazoWorkspaceId: "workspace-1",
        })),
        updateMany: leaseUpdate,
      },
      brandwellWorkspaceModelCredential: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: "credential-1",
          externalKeyHash: "hash-1",
          limitReset: "monthly",
          monthlyLimitMicros: 125_000_000n,
        })),
        update: credentialUpdate,
      },
    } as unknown as PrismaClient;
    const runner = createPrismaBrandwellProvisioningRunner({
      ...options(200_000_000n, 150_000_000n),
      prisma,
      systemUserId: "system-1",
      openRouter: {
        createKey: vi.fn(),
        deleteKey: vi.fn(),
        getModel: vi.fn(),
        updateKey: vi.fn(async () => {
          throw new Error("provider unavailable");
        }),
      },
    });

    await expect(runner.execute("model_configuration", provisioningCheckpoint())).rejects.toThrow(
      "provider unavailable",
    );
    expect(credentialUpdate).not.toHaveBeenCalled();
    expect(leaseUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ modelPolicyLeaseOwner: expect.any(String) }),
        data: { modelPolicyLeaseOwner: null, modelPolicyLeaseExpiresAt: null },
      }),
    );
  });
});

function provisioningCheckpoint(): BrandwellProvisioningCheckpoint {
  return {
    version: 1,
    idempotencyKey: "brandwell:provision:customer-acme",
    input: {
      brandwellCustomerId: "customer-acme",
      primaryBrandwellUserId: "brandwell-user-1",
      companyName: "Acme",
      primaryContactName: "Alex",
      primaryContactEmail: "alex@example.test",
      plan: "aimee",
      timezone: "UTC",
    },
    status: "running",
    runId: "run-1",
    steps: [],
    startedAt: "2026-08-30T12:00:00.000Z",
    updatedAt: "2026-08-30T12:00:00.000Z",
  };
}
