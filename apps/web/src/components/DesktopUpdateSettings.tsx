import type { AimeeDesktopUpdate, DesktopUpdateState } from "@rakazo/contracts";
import { useCallback, useEffect, useState } from "react";
import { desktopBridge } from "../lib/desktop";
import { BuiButton, LoadingState, SuccessPop } from "./beautiful-ui/primitives";

type UpdateAction = "check" | "download" | "install";

export function desktopUpdatePollInterval(state: DesktopUpdateState | null): number {
  return state?.phase === "checking" || state?.phase === "downloading" ? 750 : 10_000;
}

export interface DesktopUpdateView {
  detail: string;
  action: UpdateAction | null;
  actionLabel: string | null;
  activeLabel: string | null;
}

export function pendingDesktopUpdateState(
  state: DesktopUpdateState,
  action: UpdateAction,
): DesktopUpdateState {
  if (action === "check") {
    return { ...state, phase: "checking", percent: null, message: null };
  }
  if (action === "download") {
    return { ...state, phase: "downloading", percent: 0, message: null };
  }
  return state;
}

export function desktopUpdateView(state: DesktopUpdateState): DesktopUpdateView {
  switch (state.phase) {
    case "checking":
      return {
        detail: "Looking for a newer desktop release.",
        action: null,
        actionLabel: null,
        activeLabel: "Checking for updates",
      };
    case "available":
      return {
        detail: `Version ${state.availableVersion ?? "new"} is ready to download.`,
        action: "download",
        actionLabel: "Download update",
        activeLabel: null,
      };
    case "downloading":
      return {
        detail: `Downloading version ${state.availableVersion ?? "new"}.`,
        action: null,
        actionLabel: null,
        activeLabel: `Downloading update${state.percent === null ? "" : ` ${state.percent}%`}`,
      };
    case "ready":
      return {
        detail: state.message ?? "The verified update is ready to install.",
        action: "install",
        actionLabel: "Install and restart",
        activeLabel: null,
      };
    case "error":
      return {
        detail: state.message ?? "The update could not be completed. Try again later.",
        action: "check",
        actionLabel: "Try again",
        activeLabel: null,
      };
    case "unsupported":
      return {
        detail: state.message ?? "Updates are not available for this build.",
        action: null,
        actionLabel: null,
        activeLabel: null,
      };
    case "idle":
      return {
        detail:
          state.message ??
          (state.checkedAt
            ? "You have the latest desktop version."
            : "Check for AIMEE desktop updates."),
        action: "check",
        actionLabel: "Check for updates",
        activeLabel: null,
      };
  }
}

export function DesktopUpdateSettings({ update }: { update?: AimeeDesktopUpdate }) {
  const updater = update ?? desktopBridge()?.update;
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [bridgeError, setBridgeError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!updater) return;
    try {
      setState(await updater.state());
      setBridgeError(null);
    } catch {
      setBridgeError("Desktop update status is unavailable. Try again.");
    }
  }, [updater]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!updater) return;
    const timer = window.setInterval(() => void refresh(), desktopUpdatePollInterval(state));
    return () => window.clearInterval(timer);
  }, [refresh, state, updater]);

  if (!updater) return null;
  const activeUpdater = updater;

  async function run(action: UpdateAction) {
    setBusy(true);
    setBridgeError(null);
    setState((current) =>
      current === null ? current : pendingDesktopUpdateState(current, action),
    );
    try {
      const next = await activeUpdater[action]();
      setState(next);
    } catch {
      setBridgeError("The desktop update action could not be completed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const view = state === null ? null : desktopUpdateView(state);
  return (
    <section
      data-testid="desktop-update-settings"
      className="mt-5 rounded-[14px] border border-[#26262A] bg-[#101012] px-4 py-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-[15px] font-medium text-[#ECECEE]">Desktop app</h3>
          {state ? (
            <p className="mt-1 text-[12.5px] text-[#6C6C70]">
              Installed version {state.currentVersion}
            </p>
          ) : null}
        </div>
        {state?.phase === "idle" && state.checkedAt && !state.message ? (
          <SuccessPop label="Up to date" />
        ) : null}
      </div>

      {view?.activeLabel ? (
        <div className="mt-4 text-[#A8A8AD]">
          <LoadingState label={view.activeLabel} />
        </div>
      ) : null}
      {state?.phase === "downloading" ? (
        <div
          role="progressbar"
          aria-label="Desktop update download"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={state.percent ?? undefined}
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#242429]"
        >
          <div
            className="h-full rounded-full bg-[#7785ff] transition-[width]"
            style={{ width: `${state.percent ?? 0}%` }}
          />
        </div>
      ) : null}
      {view ? <p className="mt-3 text-[13px] text-[#8A8A90]">{view.detail}</p> : null}
      {bridgeError ? (
        <p role="alert" className="mt-3 text-[12.5px] text-[#F1A8A8]">
          {bridgeError}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {state === null ? (
          <LoadingState label="Loading desktop version" />
        ) : view?.action && view.actionLabel ? (
          <BuiButton
            disabled={busy}
            tone={view.action === "install" ? "accent" : "neutral"}
            onClick={() => void run(view.action!)}
          >
            {busy ? "Working..." : view.actionLabel}
          </BuiButton>
        ) : null}
      </div>
    </section>
  );
}
