import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  legacyUserDataDirectory,
  managedUserDataDirectory,
  prepareManagedUserData,
} from "./user-data-profile.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryAppData() {
  const root = mkdtempSync(path.join(tmpdir(), "aimee-user-data-"));
  roots.push(root);
  return root;
}

describe("managed AIMEE user data", () => {
  it("uses a neutral BrandWell directory for new installations", () => {
    const appData = temporaryAppData();
    expect(prepareManagedUserData(appData, "new")).toBe(path.join(appData, "BrandWell", "AIMEE"));
  });

  it("copies the authenticated legacy profile without deleting its backup", () => {
    const appData = temporaryAppData();
    const legacy = legacyUserDataDirectory(appData);
    mkdirSync(path.join(legacy, "Partitions", "brandwell"), { recursive: true });
    writeFileSync(path.join(legacy, "Partitions", "brandwell", "Cookies"), "session");

    const destination = prepareManagedUserData(appData, "migration");

    expect(destination).toBe(managedUserDataDirectory(appData));
    expect(readFileSync(path.join(destination, "Partitions", "brandwell", "Cookies"), "utf8")).toBe(
      "session",
    );
    expect(existsSync(path.join(legacy, "Partitions", "brandwell", "Cookies"))).toBe(true);
  });

  it("does not overwrite a managed profile that already exists", () => {
    const appData = temporaryAppData();
    const destination = managedUserDataDirectory(appData);
    const legacy = legacyUserDataDirectory(appData);
    mkdirSync(destination, { recursive: true });
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(destination, "Cookies"), "managed");
    writeFileSync(path.join(legacy, "Cookies"), "legacy");

    expect(prepareManagedUserData(appData, "existing")).toBe(destination);
    expect(readFileSync(path.join(destination, "Cookies"), "utf8")).toBe("managed");
  });
});
