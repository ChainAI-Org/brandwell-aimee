import type { DesktopUpdateState } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  desktopUpdatePollInterval,
  desktopUpdateView,
  pendingDesktopUpdateState,
} from "./DesktopUpdateSettings";

function state(patch: Partial<DesktopUpdateState>): DesktopUpdateState {
  return {
    phase: "idle",
    currentVersion: "1.2.3",
    availableVersion: null,
    percent: null,
    message: null,
    checkedAt: null,
    ...patch,
  };
}

describe("desktop update settings", () => {
  it("offers the complete explicit update lifecycle", () => {
    expect(desktopUpdateView(state({ phase: "idle" }))).toMatchObject({
      action: "check",
      actionLabel: "Check for updates",
    });
    expect(
      desktopUpdateView(state({ phase: "available", availableVersion: "1.3.0" })),
    ).toMatchObject({ action: "download", actionLabel: "Download update" });
    expect(desktopUpdateView(state({ phase: "ready", availableVersion: "1.3.0" }))).toMatchObject({
      action: "install",
      actionLabel: "Install and restart",
    });
  });

  it("shows download progress and safe updater errors", () => {
    expect(
      desktopUpdateView(state({ phase: "downloading", availableVersion: "1.3.0", percent: 42 })),
    ).toMatchObject({ activeLabel: "Downloading update 42%" });
    expect(
      desktopUpdateView(
        state({ phase: "error", message: "The update could not be completed. Try again later." }),
      ),
    ).toMatchObject({ actionLabel: "Try again" });
  });

  it("renders in-flight actions immediately while the preload call is pending", () => {
    expect(pendingDesktopUpdateState(state({ phase: "available" }), "download")).toMatchObject({
      phase: "downloading",
      percent: 0,
    });
    expect(pendingDesktopUpdateState(state({ phase: "idle" }), "check")).toMatchObject({
      phase: "checking",
    });
  });

  it("polls idle panels for launch-time checks and active downloads more quickly", () => {
    expect(desktopUpdatePollInterval(state({ phase: "idle" }))).toBe(10_000);
    expect(desktopUpdatePollInterval(state({ phase: "checking" }))).toBe(750);
    expect(desktopUpdatePollInterval(state({ phase: "downloading" }))).toBe(750);
  });

  it("does not describe an offline check as successful", () => {
    expect(
      desktopUpdateView(
        state({
          phase: "idle",
          checkedAt: "2026-08-30T00:00:00.000Z",
          message: "Could not reach the update server.",
        }),
      ),
    ).toMatchObject({ detail: "Could not reach the update server." });
    expect(
      desktopUpdateView(state({ phase: "idle", checkedAt: null, message: null })),
    ).toMatchObject({ detail: "Check for BrandWell AIMEE desktop updates." });
  });
});
