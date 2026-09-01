import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

const LEGACY_USER_DATA_DIRECTORY = "BrandWell's AIMEE";

export function managedUserDataDirectory(appDataDirectory: string): string {
  return path.join(appDataDirectory, "BrandWell", "AIMEE");
}

export function legacyUserDataDirectory(appDataDirectory: string): string {
  return path.join(appDataDirectory, LEGACY_USER_DATA_DIRECTORY);
}

/**
 * Preserve the authenticated Electron profile when the visible product name changes.
 * The legacy directory remains as a recoverable backup after a successful copy.
 */
export function prepareManagedUserData(
  appDataDirectory: string,
  migrationId = String(process.pid),
): string {
  const destination = managedUserDataDirectory(appDataDirectory);
  const legacy = legacyUserDataDirectory(appDataDirectory);
  if (existsSync(destination) || !existsSync(legacy)) return destination;

  mkdirSync(path.dirname(destination), { recursive: true });
  const safeMigrationId = migrationId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const candidate = `${destination}.migrating-${safeMigrationId}`;
  try {
    cpSync(legacy, candidate, { recursive: true, force: false, errorOnExist: true });
    renameSync(candidate, destination);
    return destination;
  } catch {
    rmSync(candidate, { recursive: true, force: true });
    return legacy;
  }
}
