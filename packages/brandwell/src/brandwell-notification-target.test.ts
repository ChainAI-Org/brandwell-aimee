import { describe, expect, it } from "vitest";
import { brandwellOutreachNotificationUrl } from "./brand-config.js";

describe("Outreach notification destination", () => {
  it("uses the fixed portal origin and only carries the account identifier", () => {
    expect(
      brandwellOutreachNotificationUrl("/outreach?client_id=42&redirect=https://elsewhere.test"),
    ).toBe("https://portal.brandwell.ai/#/outreach?client_id=42&workflows=open");
    for (const target of [
      "//elsewhere.test/outreach?client_id=42",
      "/outreach?client_id=abc",
      "/outreach?client_id=-1",
      null,
    ]) {
      expect(brandwellOutreachNotificationUrl(target)).toBeNull();
    }
  });
});
