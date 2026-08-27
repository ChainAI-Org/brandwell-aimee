import { describe, expect, it } from "vitest";
import { connectorPrincipalId } from "./connector-safety.js";

describe("connector principal", () => {
  it("preserves ordinary user-owned connector behavior", () => {
    expect(connectorPrincipalId({ userId: "user-1" })).toBe("user-1");
  });

  it("uses the stable service identity for managed workspace connectors", () => {
    expect(
      connectorPrincipalId({
        userId: "client-admin-who-triggered-the-run",
        serviceIdentityId: "svc-acme",
      }),
    ).toBe("svc-acme");
  });
});
