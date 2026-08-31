import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { acquireBrandwellModelPolicyLease } from "./prisma-model-policy-lease.js";

describe("BrandWell model-policy lease", () => {
  it("serializes policy and Sidekick mutations and releases only its own lease", async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const now = new Date("2026-08-30T12:00:00.000Z");
    const lease = await acquireBrandwellModelPolicyLease(
      { brandwellAiWorkspace: { updateMany } } as unknown as PrismaClient,
      "mapping-1",
      "model-policy-update",
      () => now,
    );

    expect(lease).not.toBeNull();
    await lease!.renew();
    await lease!.release();
    expect(updateMany).toHaveBeenCalledTimes(3);
    expect(updateMany.mock.calls[2]?.[0]).toEqual({
      where: { id: "mapping-1", modelPolicyLeaseOwner: lease!.owner },
      data: { modelPolicyLeaseOwner: null, modelPolicyLeaseExpiresAt: null },
    });
  });

  it("returns busy when another process owns the unexpired lease", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));

    await expect(
      acquireBrandwellModelPolicyLease(
        { brandwellAiWorkspace: { updateMany } } as unknown as PrismaClient,
        "mapping-1",
        "sidekick-provision",
      ),
    ).resolves.toBeNull();
  });
});
