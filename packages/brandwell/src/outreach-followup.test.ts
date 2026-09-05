import { describe, expect, it } from "vitest";
import {
  brandwellOutreachFollowupPrompt,
  parseBrandwellOutreachFollowup,
} from "./outreach-followup.js";

const base = {
  targetBrandwellUserId: "42",
  contact: { name: "Example Company", email: "", company: "Example", linkedinUrl: null },
  campaignName: "SocialStreams: hiring",
  event: "sequence",
  mode: "review",
  socialSignal: {
    recordId: "b15e3b32-2be5-4d0f-9da7-cf1609b9167b",
    type: "job",
    sourceUrl: "https://www.linkedin.com/jobs/view/123456/",
  },
};

describe("Link Builder qualification", () => {
  it("accepts a publisher without an email only for placement review", () => {
    const placement = {
      ...base,
      socialSignal: undefined,
      placementTask: {
        taskId: "b15e3b32-2be5-4d0f-9da7-cf1609b9167b",
        opportunityId: "fa286c42-08e1-46c3-9956-d03e8cfbe1bf",
      },
    };
    expect(parseBrandwellOutreachFollowup(placement).ok).toBe(true);
    expect(parseBrandwellOutreachFollowup({ ...placement, placementTask: undefined }).ok).toBe(
      false,
    );
    expect(parseBrandwellOutreachFollowup({ ...placement, mode: "execute" }).ok).toBe(false);
  });
});

describe("SocialStreams handoff", () => {
  it("accepts a source-backed job signal without an email and produces review instructions", () => {
    const parsed = parseBrandwellOutreachFollowup(base);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.contact.email).toBe("");
    expect(parsed.value.socialSignal?.type).toBe("job");
    const prompt = brandwellOutreachFollowupPrompt(parsed.value);
    expect(prompt).toContain("Do not send messages");
    expect(prompt).toContain("poster is not automatically a buyer");
    expect(prompt).toContain(base.socialSignal.sourceUrl);
  });
  it.each([
    "http://x.com/a/status/1",
    "https://x.com.evil.test/post",
    "https://localhost/post",
    "https://name:secret@facebook.com/post",
  ])("rejects an untrusted source URL %s", (sourceUrl) => {
    expect(
      parseBrandwellOutreachFollowup({ ...base, socialSignal: { ...base.socialSignal, sourceUrl } })
        .ok,
    ).toBe(false);
  });
  it("requires an email on the existing Outreach contract", () => {
    expect(parseBrandwellOutreachFollowup({ ...base, socialSignal: undefined }).ok).toBe(false);
    expect(
      parseBrandwellOutreachFollowup({
        ...base,
        socialSignal: undefined,
        contact: { ...base.contact, email: "person@example.test" },
      }).ok,
    ).toBe(true);
  });
  it("rejects autonomous execution and invalid nonempty emails", () => {
    expect(
      parseBrandwellOutreachFollowup({ ...base, mode: "execute", instruction: "Send a message" })
        .ok,
    ).toBe(false);
    expect(
      parseBrandwellOutreachFollowup({ ...base, contact: { ...base.contact, email: "invalid" } })
        .ok,
    ).toBe(false);
  });
});
