import { describe, expect, it, vi } from "vitest";
import { BrandwellPlatformAuthClient } from "./brandwell-user-auth.js";

const identity = {
  user: {
    id: "42",
    agencyId: "7",
    clientId: "11",
    name: "Ada Client",
    email: "ada@example.com",
  },
  access: {
    kind: "master" as const,
    brandwellCustomerId: "portal-client:11",
    workspaceId: "workspace-11",
    sidekickId: null,
  },
};

describe("BrandWell platform user authentication", () => {
  it("authenticates through the private BrandWell service route", async () => {
    const fetchImpl = vi.fn(async () => Response.json(identity)) as unknown as typeof fetch;
    const client = new BrandwellPlatformAuthClient(
      "https://intent.brandwell.ai/",
      "service-secret",
      fetchImpl,
    );
    await expect(client.authenticate("ada@example.com", "secret")).resolves.toEqual(identity);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://intent.brandwell.ai/internal/aimee/authenticate-user",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer service-secret" }),
      }),
    );
  });

  it("preserves the past-due status and administrator payment message", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        {
          error:
            "The last BrandWell invoice failed. Ask your BrandWell account administrator to pay the past-due invoice to restore access.",
          code: "aimee_billing_past_due",
        },
        { status: 402 },
      ),
    ) as unknown as typeof fetch;
    const client = new BrandwellPlatformAuthClient(
      "https://intent.brandwell.ai",
      "service-secret",
      fetchImpl,
    );
    await expect(client.authenticate("ada@example.com", "secret")).rejects.toMatchObject({
      code: "aimee_billing_past_due",
      statusCode: 402,
      message: expect.stringMatching(/account administrator/i),
    });
  });
});
