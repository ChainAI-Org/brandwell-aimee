import type { DesktopSetup } from "@rakazo/contracts";
import { normalizeServerUrl, parseSetupInput } from "./setup-config.js";

export interface DesktopSetupPolicy {
  serverChooserEnabled: boolean;
  managedServerUrl: string;
}

/** Installed builds are always pinned to the managed service. */
export function isServerChooserEnabled(isPackaged: boolean): boolean {
  return !isPackaged;
}

/**
 * Applies the main-process server policy to an untrusted setup-window payload.
 * This is deliberately separate from renderer state so a modified setup page
 * cannot make an installed build connect to a client-selected server.
 */
export function parseSetupIpcPayload(
  value: unknown,
  policy: DesktopSetupPolicy,
): DesktopSetup | null {
  const setup = parseSetupInput(value);
  if (setup === null) return null;
  if (policy.serverChooserEnabled) return setup;

  const managedServerUrl = normalizeServerUrl(policy.managedServerUrl);
  if (
    managedServerUrl === null ||
    setup.mode !== "existing" ||
    setup.serverUrl !== managedServerUrl
  ) {
    return null;
  }
  return { mode: "existing", serverUrl: managedServerUrl };
}

/** Applies the same policy before a setup-window health probe leaves the app. */
export function parseSetupProbeUrl(value: unknown, policy: DesktopSetupPolicy): string | null {
  if (typeof value !== "string") return null;
  const serverUrl = normalizeServerUrl(value);
  if (serverUrl === null) return null;
  if (policy.serverChooserEnabled) return serverUrl;

  const managedServerUrl = normalizeServerUrl(policy.managedServerUrl);
  return managedServerUrl !== null && serverUrl === managedServerUrl ? managedServerUrl : null;
}
