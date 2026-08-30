import type { ConfigContext, ExpoConfig } from "expo/config";

const OFFICIAL_API_URL = "https://ai.brandwell.ai";

export default ({ config }: ConfigContext): ExpoConfig => {
  if (process.env.EAS_BUILD_PROFILE === "production") {
    const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? OFFICIAL_API_URL;

    let parsed: URL;
    try {
      parsed = new URL(apiUrl);
    } catch {
      throw new Error("EXPO_PUBLIC_API_URL must be a valid URL.");
    }
    if (parsed.protocol !== "https:") {
      throw new Error("EXPO_PUBLIC_API_URL must use HTTPS for production builds.");
    }
  }

  return {
    ...config,
    extra: {
      ...config.extra,
      officialApiUrl: OFFICIAL_API_URL,
    },
  } as ExpoConfig;
};
