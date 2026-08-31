import { BRANDWELL_BRAND } from "@brandwell/aimee";
import type { AppEnv } from "./env.js";

export const BRANDWELL_MANAGED_ORIGINS = [
  BRANDWELL_BRAND.apiUrl,
  "https://staging-ai.brandwell.ai",
] as const;

const managedOrigins = new Set<string>(BRANDWELL_MANAGED_ORIGINS);

export function isTrustedOrigin(
  origin: string,
  env: Pick<AppEnv, "webOrigin" | "apiUrl" | "authUrl">,
) {
  if (!origin) return true;
  if (
    origin === env.webOrigin ||
    origin === env.apiUrl ||
    origin === env.authUrl ||
    managedOrigins.has(origin)
  ) {
    return true;
  }
  if (origin.startsWith("aimee://") || origin.startsWith("exp://")) {
    return true;
  }
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}
