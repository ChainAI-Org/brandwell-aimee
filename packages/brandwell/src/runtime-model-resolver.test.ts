import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  BrandwellManagedRunBlockedError,
  createBrandwellManagedModelResolver,
} from "./runtime-model-resolver.js";

function activePrisma(
  options: {
    subscriptionStatus?: string;
    secretWorkspaceMatch?: boolean;
    sidekick?: boolean;
    dailyLimitMicros?: bigint | null;
    managedByBrandWell?: boolean;
    workspaceMapping?: boolean;
  } = {},
) {
  const credential = {
    id: "credential-acme",
    workspaceId: "workspace-acme",
    serviceIdentityId: "svc-acme",
    secretId: "secret-acme",
    provider: "openrouter",
    status: "active",
    disabledAt: null,
    monthlyLimitMicros: 100_000_000n,
    dailyLimitMicros: options.dailyLimitMicros ?? null,
    warningLimitMicros: 75_000_000n,
    currentUsageMicros: 80_000_000n,
    preferredModel: "openai/gpt-5.4-mini",
    computerModel: "anthropic/claude-sonnet-4.6",
    lightweightModel: null,
    reasoningModel: null,
    fallbackModels: ["openai/gpt-5.4-mini", "anthropic/claude-sonnet-4.6"],
    maxTokens: 8_192,
    thinkingLevel: "medium",
  };
  return {
    bot: {
      findFirst: vi.fn(async () => ({
        managedByBrandWell: options.managedByBrandWell ?? true,
        managedStatus: "active",
        serviceIdentityId: "svc-acme",
      })),
    },
    brandwellAiWorkspace: {
      findUnique: vi.fn(async () =>
        options.workspaceMapping === false
          ? null
          : {
              id: "mapping-acme",
              subscriptionStatus: options.subscriptionStatus ?? "active",
              serviceIdentityId: "svc-acme",
              openRouterCredentialId: "credential-acme",
            },
      ),
    },
    brandwellServiceIdentity: {
      findUnique: vi.fn(async () => ({ workspaceId: "workspace-acme", status: "active" })),
    },
    brandwellWorkspaceModelCredential: {
      findUnique: vi.fn(async () => credential),
    },
    brandwellSidekick: {
      findUnique: vi.fn(async () =>
        options.sidekick
          ? {
              id: "sidekick-acme",
              workspaceId: "workspace-acme",
              status: "active",
              modelCredential: {
                ...credential,
                id: "credential-sidekick",
                sidekickId: "sidekick-acme",
                secretId: "secret-sidekick",
                currentUsageMicros: 5_000_000n,
              },
            }
          : null,
      ),
    },
    secret: {
      findFirst: vi.fn(async () =>
        options.secretWorkspaceMatch === false ? null : { id: "secret-acme" },
      ),
    },
    usageRecord: {
      aggregate: vi.fn(async () => ({ _sum: { costMicros: 0n } })),
    },
  } as unknown as PrismaClient;
}

describe("BrandWell managed runtime model resolver", () => {
  it("resolves the workspace model without exposing a raw key", async () => {
    const resolver = createBrandwellManagedModelResolver(activePrisma());

    await expect(
      resolver({
        workspaceId: "workspace-acme",
        userId: "client-admin",
        botId: "bot-acme",
        workloadType: "computer",
      }),
    ).resolves.toEqual({
      provider: "openrouter",
      id: "anthropic/claude-sonnet-4.6",
      secretId: "secret-acme",
      serviceIdentityId: "svc-acme",
      thinkingLevel: "medium",
      maxTokens: 8_192,
      fallbackModels: ["openai/gpt-5.4-mini"],
      warningExceeded: true,
    });
  });

  it("blocks a canceled workspace before inference", async () => {
    const resolver = createBrandwellManagedModelResolver(
      activePrisma({ subscriptionStatus: "canceled" }),
    );

    await expect(
      resolver({ workspaceId: "workspace-acme", userId: "user", botId: "bot-acme" }),
    ).rejects.toThrowError(new BrandwellManagedRunBlockedError("workspace_inactive"));
  });

  it("fails closed for an unmanaged bot in a mapped BrandWell workspace", async () => {
    const prisma = activePrisma({ managedByBrandWell: false });
    const resolver = createBrandwellManagedModelResolver(prisma);

    await expect(
      resolver({ workspaceId: "workspace-acme", userId: "user", botId: "bot-bypass" }),
    ).rejects.toThrowError(new BrandwellManagedRunBlockedError("unmanaged_bot"));
    expect(prisma.brandwellWorkspaceModelCredential.findUnique).not.toHaveBeenCalled();
  });

  it("leaves ordinary bots outside managed workspaces on the generic runtime path", async () => {
    const resolver = createBrandwellManagedModelResolver(
      activePrisma({ managedByBrandWell: false, workspaceMapping: false }),
    );

    await expect(
      resolver({ workspaceId: "workspace-acme", userId: "user", botId: "ordinary-bot" }),
    ).resolves.toBeNull();
  });

  it("rejects a secret that is not owned by this workspace service identity", async () => {
    const prisma = activePrisma({ secretWorkspaceMatch: false });
    const resolver = createBrandwellManagedModelResolver(prisma);

    await expect(
      resolver({ workspaceId: "workspace-acme", userId: "user", botId: "bot-acme" }),
    ).rejects.toThrowError(new BrandwellManagedRunBlockedError("credential_scope_mismatch"));
    expect(prisma.secret.findFirst).toHaveBeenCalledWith({
      where: {
        id: "secret-acme",
        workspaceId: "workspace-acme",
        ownerType: "service",
        serviceIdentityId: "svc-acme",
      },
      select: { id: true },
    });
  });

  it("routes a Sidekick through only its own OpenRouter credential", async () => {
    const prisma = activePrisma({ sidekick: true });
    const resolver = createBrandwellManagedModelResolver(prisma);

    await expect(
      resolver({
        workspaceId: "workspace-acme",
        userId: "casey",
        botId: "bot-acme",
        workloadType: "general",
      }),
    ).resolves.toMatchObject({
      secretId: "secret-sidekick",
      serviceIdentityId: "svc-acme",
    });
    expect(prisma.secret.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "secret-sidekick" }) }),
    );
  });

  it("keeps the master daily limit workspace-wide while isolating Sidekick daily usage", async () => {
    const masterPrisma = activePrisma({ dailyLimitMicros: 10_000_000n });
    await createBrandwellManagedModelResolver(masterPrisma)({
      workspaceId: "workspace-acme",
      userId: "client-admin",
      botId: "bot-master",
    });
    expect(masterPrisma.usageRecord.aggregate).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-acme",
        serviceIdentityId: "svc-acme",
        createdAt: { gte: expect.any(Date) },
      },
      _sum: { costMicros: true },
    });

    const sidekickPrisma = activePrisma({
      sidekick: true,
      dailyLimitMicros: 10_000_000n,
    });
    await createBrandwellManagedModelResolver(sidekickPrisma)({
      workspaceId: "workspace-acme",
      userId: "casey",
      botId: "bot-sidekick",
    });
    expect(sidekickPrisma.usageRecord.aggregate).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-acme",
        serviceIdentityId: "svc-acme",
        botId: "bot-sidekick",
        createdAt: { gte: expect.any(Date) },
      },
      _sum: { costMicros: true },
    });
  });
});
