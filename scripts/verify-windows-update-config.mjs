import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), "..");

function loadYaml(contents) {
  const desktopRequire = createRequire(path.join(root, "apps/desktop/package.json"));
  const electronBuilderRequire = createRequire(
    desktopRequire.resolve("electron-builder/package.json"),
  );
  const appBuilderRequire = createRequire(
    electronBuilderRequire.resolve("app-builder-lib/package.json"),
  );
  const { load } = appBuilderRequire("js-yaml");
  return load(contents);
}

export async function verifyWindowsUpdateConfig(configPath, expectedPublisher) {
  if (typeof expectedPublisher !== "string" || expectedPublisher.trim() === "") {
    throw new Error("The expected Windows publisher is not configured.");
  }

  const config = loadYaml(await readFile(configPath, "utf8"));
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error("Windows update config is not a YAML object.");
  }

  const expectedChannel = {
    provider: "github",
    owner: "ChainAI-Org",
    repo: "brandwell-aimee",
  };
  for (const [key, expected] of Object.entries(expectedChannel)) {
    if (config[key] !== expected) {
      throw new Error(`Windows update config has an unexpected ${key}.`);
    }
  }

  const publisherNames = config.publisherName;
  if (
    !Array.isArray(publisherNames) ||
    publisherNames.length !== 1 ||
    publisherNames[0] !== expectedPublisher
  ) {
    throw new Error(
      "Windows update config publisherName does not exactly match the expected signing certificate subject.",
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const [, , configPath, expectedPublisher] = process.argv;
  if (!configPath) throw new Error("Usage: verify-windows-update-config <config> <publisher>");
  await verifyWindowsUpdateConfig(configPath, expectedPublisher);
}
