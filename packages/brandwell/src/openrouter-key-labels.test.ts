import { describe, expect, it } from "vitest";
import {
  brandwellMasterOpenRouterKeyLabel,
  brandwellSidekickOpenRouterKeyLabel,
} from "./openrouter-key-labels.js";

describe("BrandWell OpenRouter key labels", () => {
  it("uses the client company for the master AIMEE key", () => {
    expect(brandwellMasterOpenRouterKeyLabel(" Acme   Dental ")).toBe("AIMEE-Acme Dental");
  });

  it("uses the client company and normalized teammate email for a Sidekick key", () => {
    expect(brandwellSidekickOpenRouterKeyLabel("Acme Dental", " Casey@Example.COM ")).toBe(
      "AIMEE-Acme Dental-casey@example.com",
    );
  });
});
