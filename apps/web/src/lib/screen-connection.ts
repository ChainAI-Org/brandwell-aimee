export const AIMEE_SCREEN_STATE_MESSAGE = "aimee-screen-state";

export type ScreenConnectionState = "idle" | "connecting" | "connected" | "disconnected";

export type AimeeScreenStateMessage = {
  type: typeof AIMEE_SCREEN_STATE_MESSAGE;
  state: Exclude<ScreenConnectionState, "idle">;
};

export function readAimeeScreenStateMessage(value: unknown): AimeeScreenStateMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as { type?: unknown; state?: unknown };
  if (message.type !== AIMEE_SCREEN_STATE_MESSAGE) return null;
  if (
    message.state !== "connecting" &&
    message.state !== "connected" &&
    message.state !== "disconnected"
  ) {
    return null;
  }
  return {
    type: AIMEE_SCREEN_STATE_MESSAGE,
    state: message.state,
  };
}
