import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyWindowsUpdateConfig } from "../../../scripts/verify-windows-update-config.mjs";

const EXPECTED_PUBLISHER = "CN=BrandWell, O=BrandWell, L=Phoenix, S=Arizona, C=US";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function updateConfig(publisherNames: string[]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aimee-windows-update-config-"));
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, "app-update.yml");
  await writeFile(
    configPath,
    [
      "provider: github",
      "owner: ChainAI-Org",
      "repo: brandwell-aimee",
      "publisherName:",
      ...publisherNames.map((publisher) => `  - ${JSON.stringify(publisher)}`),
      "",
    ].join("\n"),
  );
  return configPath;
}

describe("Windows desktop update config", () => {
  it("accepts one publisher equal to the full expected certificate subject", async () => {
    const configPath = await updateConfig([EXPECTED_PUBLISHER]);
    await expect(
      verifyWindowsUpdateConfig(configPath, EXPECTED_PUBLISHER),
    ).resolves.toBeUndefined();
  });

  it("rejects a CN-only publisher even when it is part of the expected subject", async () => {
    const configPath = await updateConfig(["BrandWell"]);
    await expect(verifyWindowsUpdateConfig(configPath, EXPECTED_PUBLISHER)).rejects.toThrow(
      "does not exactly match",
    );
  });

  it("rejects fallback publishers alongside the expected identity", async () => {
    const configPath = await updateConfig([EXPECTED_PUBLISHER, "BrandWell"]);
    await expect(verifyWindowsUpdateConfig(configPath, EXPECTED_PUBLISHER)).rejects.toThrow(
      "does not exactly match",
    );
  });

  it("rejects a publisher-bound feed outside the official channel", async () => {
    const configPath = await updateConfig([EXPECTED_PUBLISHER]);
    await writeFile(
      configPath,
      [
        "provider: github",
        "owner: other-org",
        "repo: brandwell-aimee",
        "publisherName:",
        `  - ${JSON.stringify(EXPECTED_PUBLISHER)}`,
        "",
      ].join("\n"),
    );
    await expect(verifyWindowsUpdateConfig(configPath, EXPECTED_PUBLISHER)).rejects.toThrow(
      "unexpected owner",
    );
  });
});
