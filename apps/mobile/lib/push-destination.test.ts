import { describe, expect, it } from "vitest";
import { pushNotificationDestination } from "./push-destination.js";

describe("AIMEE push notification deep links", () => {
  it("opens the requested computer for a client login escalation", () => {
    expect(
      pushNotificationDestination({
        botId: "bot-aimee",
        actionTarget: "/computer?botId=bot-aimee",
      }),
    ).toEqual({ pathname: "/computer", params: { botId: "bot-aimee" } });
  });

  it("opens connections and falls back to the relevant chat", () => {
    expect(pushNotificationDestination({ actionTarget: "/integrations" })).toBe("/integrations");
    expect(pushNotificationDestination({ botId: "bot-aimee" })).toEqual({
      pathname: "/thread",
      params: { botId: "bot-aimee" },
    });
  });
});
