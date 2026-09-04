import { describe, expect, it } from "vitest";
import {
  BRANDWELL_AIMEE_DEFAULT_ROUTINES,
  BRANDWELL_AIMEE_INSTRUCTIONS,
  BRANDWELL_AIMEE_SKILL_BUNDLE_VERSION,
  BRANDWELL_AIMEE_SKILLS,
  BRANDWELL_AIMEE_WELCOME,
} from "./aimee-baseline.js";
import { BRANDWELL_AIMEE_RANKWELL_SKILLS } from "./aimee-rankwell-skills.js";
import { BRANDWELL_AIMEE_VISIBILITY_SKILLS } from "./aimee-visibility-skills.js";

describe("AIMEE managed workspace baseline", () => {
  it("introduces AIMEE and leaves the client's first priority open", () => {
    expect(BRANDWELL_AIMEE_WELCOME).toContain("I'm AIMEE");
    expect(BRANDWELL_AIMEE_WELCOME).toContain("Tell me what you want");
    expect(BRANDWELL_AIMEE_WELCOME).toContain("ask before anything sends");
  });

  it("uses BrandWell-first GTM motions without weakening tenant or approval boundaries", () => {
    expect(BRANDWELL_AIMEE_INSTRUCTIONS).toContain("primary system for buyer intent");
    expect(BRANDWELL_AIMEE_INSTRUCTIONS).toContain("LLM answers and organic search");
    expect(BRANDWELL_AIMEE_INSTRUCTIONS).toContain("TrafficID signals");
    expect(BRANDWELL_AIMEE_INSTRUCTIONS).toContain("LinkedIn, Meta or Facebook");
    expect(BRANDWELL_AIMEE_INSTRUCTIONS).toContain(
      "Never access, infer, or reveal another workspace",
    );
    expect(BRANDWELL_AIMEE_INSTRUCTIONS).toContain("Ask for explicit approval");
    expect(BRANDWELL_AIMEE_INSTRUCTIONS).toContain("private BrandWell-managed computer");
    expect(BRANDWELL_AIMEE_INSTRUCTIONS).toContain("do not speculate about vendors");
    expect(BRANDWELL_AIMEE_INSTRUCTIONS).not.toMatch(/daytona/i);
  });

  it("provisions a GTM operating skill plus the native BrandWell skills and routines", () => {
    expect(BRANDWELL_AIMEE_SKILLS.map((skill) => skill.name).slice(0, 7)).toEqual([
      "cold-email",
      "BrandWell GTM Operating System",
      "BrandWell Application Operator",
      "BrandWell Intent",
      "BrandWell TrafficID",
      "BrandWell Postcard Offer Hooks",
      "BrandWell Postcards",
    ]);
    expect(
      BRANDWELL_AIMEE_SKILLS.find((skill) => skill.name === "BrandWell Postcard Offer Hooks")
        ?.content,
    ).toContain("exactly three hook concepts with GLM 5.3 through OpenRouter");
    expect(BRANDWELL_AIMEE_DEFAULT_ROUTINES).toHaveLength(5);
    expect(BRANDWELL_AIMEE_DEFAULT_ROUTINES).toContainEqual(
      expect.objectContaining({
        name: "Review weekly content opportunities",
        cron: "0 10 * * 1",
      }),
    );
  });

  it("installs the BrandWell visibility workflow pack without external product branding", () => {
    expect(BRANDWELL_AIMEE_VISIBILITY_SKILLS.map((item) => item.name)).toEqual([
      "BrandWell Visibility Project Setup",
      "BrandWell Visibility Coach",
      "BrandWell Site Health Audit",
      "BrandWell Keyword Research",
      "BrandWell Keyword Clustering",
      "BrandWell Content Opportunities",
      "BrandWell Content Consolidation",
      "BrandWell Competitive Landscape",
      "BrandWell Competitor Analysis",
      "BrandWell Local Visibility",
      "BrandWell Link Prospecting",
      "BrandWell AI Citation Analysis",
    ]);
    expect(BRANDWELL_AIMEE_SKILLS).toHaveLength(21);
    expect(BRANDWELL_AIMEE_SKILL_BUNDLE_VERSION).toBe(9);
    expect(new Set(BRANDWELL_AIMEE_SKILLS.map((item) => item.key)).size).toBe(21);
    expect(new Set(BRANDWELL_AIMEE_SKILLS.map((item) => item.name.toLowerCase())).size).toBe(21);
    expect(JSON.stringify(BRANDWELL_AIMEE_VISIBILITY_SKILLS)).not.toMatch(/open[\s-]*seo/i);
  });

  it("installs project-bound RankWell and AI query portfolio workflows", () => {
    expect(BRANDWELL_AIMEE_RANKWELL_SKILLS.map((item) => item.name)).toEqual([
      "BrandWell AI Query Portfolio",
      "BrandWell RankWell Content Studio",
    ]);
    for (const item of BRANDWELL_AIMEE_RANKWELL_SKILLS) {
      expect(item.content).toContain("Begin with brandwell_visibility_get_project");
      expect(item.content).toContain("brandwell_rankwell_get_strategy");
      expect(item.content).toContain("brandwell_rankwell_get_generation_job");
      expect(item.content).toContain("brandwell_rankwell_list_generation_jobs");
      expect(item.content).toContain("No current RankWell tool publishes content");
      expect(item.content).not.toMatch(/open[\s-]*seo/i);
    }
  });

  it("keeps every visibility skill project-bound, cache-aware, and explicit about evidence", () => {
    for (const item of BRANDWELL_AIMEE_VISIBILITY_SKILLS) {
      expect(item.key).toMatch(/^brandwell-/);
      expect(item.content).toContain("Begin with brandwell_visibility_get_project");
      expect(item.content).toContain("Start with stored first-party evidence");
      expect(item.content).toContain("cached by project and input for 24 hours");
      expect(item.content).toContain("never fan out redundant provider calls");
      expect(item.content).toContain("Never request, combine, infer, or reveal another workspace");
      expect(item.content).toContain("Separate measured evidence from your interpretation");
      expect(item.content).not.toMatch(/run_site_audit|refresh_visibility|refresh_domain/i);
    }
  });
});
