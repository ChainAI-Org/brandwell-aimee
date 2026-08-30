export type PushDestination =
  | "/"
  | "/integrations"
  | { pathname: "/computer"; params: { botId: string } }
  | { pathname: "/thread"; params: { botId: string } };

export function pushNotificationDestination(data: Record<string, unknown>): PushDestination {
  const botId = typeof data.botId === "string" ? data.botId.trim() : "";
  const target = typeof data.actionTarget === "string" ? data.actionTarget.trim() : "";
  if (target.startsWith("/computer") && botId) {
    return { pathname: "/computer", params: { botId } };
  }
  if (target.startsWith("/integrations")) return "/integrations";
  if (botId) return { pathname: "/thread", params: { botId } };
  return "/";
}
