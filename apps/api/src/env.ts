import { resolveDeploymentModel } from "@rakazo/adapters";
import { resolveAuthSecret, resolveEncryptionKey, resolveSupervisorToken } from "@rakazo/core";

export interface AppEnv {
  databaseUrl: string;
  realtimeDatabaseUrl: string;
  authSecret: string;
  authUrl: string;
  webOrigin: string;
  apiUrl: string;
  signupsEnabled: string | undefined;
  signupAllowlist: string | undefined;
  encryptionKey: string;
  dataDir: string;
  sandboxSupervisorUrl: string;
  sandboxSupervisorToken: string;
  sandboxProvider: string;
  agentRuntime: string;
  deploymentModelKey: string | undefined;
  e2bApiKey: string | undefined;
  daytonaApiKey: string | undefined;
  daytonaApiUrl: string | undefined;
  daytonaTarget: string | undefined;
  daytonaSnapshot: string | undefined;
  daytonaAutoStopInterval: number | undefined;
  daytonaAutoArchiveInterval: number | undefined;
  daytonaAutoDeleteInterval: number | undefined;
  daytonaVncResolution: string | undefined;
  daytonaLocale: string | undefined;
  daytonaTimezone: string | undefined;
  boxApiKey: string | undefined;
  boxApiUrl: string | undefined;
  composioApiKey: string | undefined;
  pipedreamClientId: string | undefined;
  pipedreamClientSecret: string | undefined;
  pipedreamProjectId: string | undefined;
  pipedreamEnvironment: "development" | "production";
  defaultProvider: string;
  defaultModel: string;
  wakeupDriver: string;
  mcpStdioEnabled: boolean;
  mcpStdioAllowedCommands: string[];
  port: number;
  gitSha: string | undefined;
  brandwellManagementApiToken: string | undefined;
  brandwellSystemUserId: string | undefined;
  openRouterManagementKey: string | undefined;
  brandwellOpenRouterMonthlyLimitUsd: number;
  brandwellOpenRouterWarningLimitUsd: number;
  brandwellOpenRouterDailyLimitUsd: number | undefined;
  brandwellComputerModel: string | undefined;
  brandwellLightweightModel: string | undefined;
  brandwellReasoningModel: string | undefined;
  brandwellFallbackModels: string[];
  brandwellRetentionDays: number;
  brandwellDeleteAfterRetention: boolean;
  brandwellPlatformApiUrl: string | undefined;
  brandwellPlatformServiceToken: string | undefined;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const authSecret = resolveAuthSecret(source);
  const deploymentModel = resolveDeploymentModel(source);
  const brandwellManagementApiToken = optional(source.BRANDWELL_MANAGEMENT_API_TOKEN);
  if (brandwellManagementApiToken && brandwellManagementApiToken.length < 32) {
    throw new Error("BRANDWELL_MANAGEMENT_API_TOKEN must be at least 32 characters");
  }
  const brandwellPlatformApiUrl = optional(source.BRANDWELL_PLATFORM_API_URL);
  const brandwellPlatformServiceToken = optional(source.BRANDWELL_PLATFORM_SERVICE_TOKEN);
  if (Boolean(brandwellPlatformApiUrl) !== Boolean(brandwellPlatformServiceToken)) {
    throw new Error(
      "BRANDWELL_PLATFORM_API_URL and BRANDWELL_PLATFORM_SERVICE_TOKEN must be configured together",
    );
  }
  if (brandwellPlatformServiceToken && brandwellPlatformServiceToken.length < 32) {
    throw new Error("BRANDWELL_PLATFORM_SERVICE_TOKEN must be at least 32 characters");
  }
  return {
    databaseUrl: required(source, "DATABASE_URL"),
    realtimeDatabaseUrl: source.REALTIME_DATABASE_URL ?? required(source, "DATABASE_URL"),
    authSecret,
    authUrl: source.BETTER_AUTH_URL ?? source.WEB_ORIGIN ?? "http://127.0.0.1:5173",
    webOrigin: source.WEB_ORIGIN ?? "http://127.0.0.1:5173",
    apiUrl: source.API_URL ?? "http://127.0.0.1:3100",
    signupsEnabled: source.SIGNUPS_ENABLED,
    signupAllowlist: source.SIGNUP_ALLOWLIST,
    encryptionKey: resolveEncryptionKey(source),
    dataDir: source.DATA_DIR ?? "./data",
    sandboxSupervisorUrl: source.SANDBOX_SUPERVISOR_URL ?? "http://127.0.0.1:7091",
    sandboxSupervisorToken: resolveSupervisorToken(source),
    sandboxProvider: source.SANDBOX_PROVIDER ?? "docker",
    agentRuntime: source.AGENT_RUNTIME ?? "pi",
    // Provider, model and key resolve together: see resolveDeploymentModel.
    deploymentModelKey: deploymentModel.key,
    e2bApiKey: source.E2B_API_KEY,
    daytonaApiKey: source.DAYTONA_API_KEY,
    daytonaApiUrl: source.DAYTONA_API_URL,
    daytonaTarget: source.DAYTONA_TARGET,
    daytonaSnapshot: optional(source.DAYTONA_SNAPSHOT),
    daytonaAutoStopInterval: optionalInteger(
      source.DAYTONA_AUTO_STOP_INTERVAL,
      "DAYTONA_AUTO_STOP_INTERVAL",
      0,
    ),
    daytonaAutoArchiveInterval: optionalInteger(
      source.DAYTONA_AUTO_ARCHIVE_INTERVAL,
      "DAYTONA_AUTO_ARCHIVE_INTERVAL",
      0,
    ),
    daytonaAutoDeleteInterval: optionalInteger(
      source.DAYTONA_AUTO_DELETE_INTERVAL,
      "DAYTONA_AUTO_DELETE_INTERVAL",
      -1,
    ),
    daytonaVncResolution: optionalResolution(
      source.DAYTONA_VNC_RESOLUTION,
      "DAYTONA_VNC_RESOLUTION",
    ),
    daytonaLocale: optional(source.DAYTONA_LOCALE),
    daytonaTimezone: optional(source.DAYTONA_TIMEZONE),
    boxApiKey: source.BOX_API_KEY,
    boxApiUrl: source.BOX_API_URL ?? source.BOX_BASE_URL,
    composioApiKey: source.COMPOSIO_API_KEY,
    pipedreamClientId: optional(source.PIPEDREAM_CLIENT_ID),
    pipedreamClientSecret: optional(source.PIPEDREAM_CLIENT_SECRET),
    pipedreamProjectId: optional(source.PIPEDREAM_PROJECT_ID),
    pipedreamEnvironment:
      source.PIPEDREAM_ENVIRONMENT === "production" ? "production" : "development",
    defaultProvider: deploymentModel.provider,
    defaultModel: deploymentModel.model,
    wakeupDriver: source.WAKEUP_DRIVER ?? "graphile",
    mcpStdioEnabled: source.MCP_STDIO_ENABLED === "true",
    mcpStdioAllowedCommands: (source.MCP_STDIO_ALLOWED_COMMANDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    port: Number(source.API_PORT ?? 3100),
    gitSha: optional(source.GIT_SHA) ?? optional(source.RAKAZO_GIT_SHA),
    brandwellManagementApiToken,
    brandwellSystemUserId: optional(source.BRANDWELL_SYSTEM_USER_ID),
    openRouterManagementKey: optional(source.OPENROUTER_MANAGEMENT_KEY),
    brandwellOpenRouterMonthlyLimitUsd: positiveNumber(
      source.BRANDWELL_OPENROUTER_MONTHLY_LIMIT_USD,
      200,
      "BRANDWELL_OPENROUTER_MONTHLY_LIMIT_USD",
    ),
    brandwellOpenRouterWarningLimitUsd: positiveNumber(
      source.BRANDWELL_OPENROUTER_WARNING_LIMIT_USD,
      150,
      "BRANDWELL_OPENROUTER_WARNING_LIMIT_USD",
    ),
    brandwellOpenRouterDailyLimitUsd: optionalPositiveNumber(
      source.BRANDWELL_OPENROUTER_DAILY_LIMIT_USD,
      "BRANDWELL_OPENROUTER_DAILY_LIMIT_USD",
    ),
    brandwellComputerModel: optional(source.BRANDWELL_COMPUTER_MODEL),
    brandwellLightweightModel: optional(source.BRANDWELL_LIGHTWEIGHT_MODEL),
    brandwellReasoningModel: optional(source.BRANDWELL_REASONING_MODEL),
    brandwellFallbackModels: (source.BRANDWELL_FALLBACK_MODELS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    brandwellRetentionDays: nonNegativeInteger(
      source.BRANDWELL_RETENTION_DAYS,
      30,
      "BRANDWELL_RETENTION_DAYS",
    ),
    brandwellDeleteAfterRetention: source.BRANDWELL_DELETE_AFTER_RETENTION !== "false",
    brandwellPlatformApiUrl,
    brandwellPlatformServiceToken,
  };
}

function required(source: NodeJS.ProcessEnv, key: string): string {
  const value = source[key];
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

function optionalInteger(value: string | undefined, key: string, minimum: number) {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${key} must be an integer greater than or equal to ${minimum}`);
  }
  return parsed;
}

function optionalResolution(value: string | undefined, key: string) {
  const normalized = optional(value);
  if (!normalized) return undefined;
  if (!/^\d{3,5}x\d{3,5}$/.test(normalized)) {
    throw new Error(`${key} must use WIDTHxHEIGHT format`);
  }
  return normalized;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function positiveNumber(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || !value.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function optionalPositiveNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined || !value.trim()) return undefined;
  return positiveNumber(value, 1, name);
}

function nonNegativeInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || !value.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}
