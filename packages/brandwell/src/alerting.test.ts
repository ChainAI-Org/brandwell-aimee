import { describe, expect, it } from "vitest";
import {
  brandwellAlertDedupeKey,
  reconcileBrandwellAlerts,
  routeBrandwellAlert,
} from "./alerting.js";

describe("BrandWell fleet alerts", () => {
  it("creates deterministic tenant-scoped dedupe keys", () => {
    expect(brandwellAlertDedupeKey("workspace-acme", "RUN_FAILED", "run-1")).toBe(
      "workspace-acme:RUN_FAILED:run-1",
    );
  });

  it("routes client login work to the client and model infrastructure to BrandWell", () => {
    expect(routeBrandwellAlert("MFA_REQUIRED")).toBe("client");
    expect(routeBrandwellAlert("OPENROUTER_DISABLED")).toBe("brandwell");
    expect(routeBrandwellAlert("CRM_DISCONNECTED")).toBe("both");
  });

  it("upserts one unresolved condition and resolves conditions that disappeared", () => {
    const result = reconcileBrandwellAlerts(
      [
        {
          id: "alert-old",
          workspaceId: "workspace-acme",
          dedupeKey: "workspace-acme:RUN_STUCK:run-old",
          status: "OPEN",
        },
      ],
      [
        {
          workspaceId: "workspace-acme",
          type: "MFA_REQUIRED",
          resourceId: "computer-1",
          source: "computer",
          severity: "WARNING",
          summary: "A browser login requires client verification.",
          clientActionRequired: true,
          brandwellActionRequired: false,
        },
        {
          workspaceId: "workspace-acme",
          type: "MFA_REQUIRED",
          resourceId: "computer-1",
          source: "computer",
          severity: "WARNING",
          summary: "Duplicate observation of the same condition.",
          clientActionRequired: true,
          brandwellActionRequired: false,
        },
      ],
    );

    expect(result.upsert).toHaveLength(1);
    expect(result.upsert[0]).toMatchObject({
      dedupeKey: "workspace-acme:MFA_REQUIRED:computer-1",
      audience: "client",
    });
    expect(result.resolveIds).toEqual(["alert-old"]);
  });
});
