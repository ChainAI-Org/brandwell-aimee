import { describe, expect, it } from "vitest";
import { selectPreferredMembership } from "./scope.js";

describe("selectPreferredMembership", () => {
  it("prefers a managed BrandWell workspace over a personal workspace", () => {
    const personal = { id: "personal", organization: { brandwellWorkspace: null } };
    const managed = {
      id: "managed",
      organization: { brandwellWorkspace: { id: "mapping-1" } },
    };

    expect(selectPreferredMembership([personal, managed])).toBe(managed);
  });

  it("keeps the first membership when none is managed", () => {
    const first = { id: "first", organization: { brandwellWorkspace: null } };
    const second = { id: "second", organization: { brandwellWorkspace: null } };

    expect(selectPreferredMembership([first, second])).toBe(first);
  });
});
