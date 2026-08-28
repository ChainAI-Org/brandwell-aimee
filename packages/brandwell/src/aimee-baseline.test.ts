import { describe, expect, it } from "vitest";
import {
  BRANDWELL_AIMEE_DEFAULT_ROUTINES,
  BRANDWELL_AIMEE_INSTRUCTIONS,
  BRANDWELL_AIMEE_SKILLS,
  BRANDWELL_AIMEE_WELCOME,
} from "./aimee-baseline.js";

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
    expect(BRANDWELL_AIMEE_INSTRUCTIONS).toContain("Never access, infer, or reveal another workspace");
    expect(BRANDWELL_AIMEE_INSTRUCTIONS).toContain("Ask for explicit approval");
  });

  it("provisions a GTM operating skill plus the native BrandWell skills and routines", () => {
    expect(BRANDWELL_AIMEE_SKILLS.map((skill) => skill.name)).toEqual([
      "BrandWell GTM Operating System",
      "BrandWell Intent",
      "BrandWell TrafficID",
      "BrandWell Postcards",
    ]);
    expect(BRANDWELL_AIMEE_DEFAULT_ROUTINES).toHaveLength(4);
  });
});
