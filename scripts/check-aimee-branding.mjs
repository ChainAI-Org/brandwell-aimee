import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targets = [
  ".github/ISSUE_TEMPLATE",
  ".github/workflows",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "SETUP_PROMPT.md",
  "apps/api/src",
  "apps/desktop/package.json",
  "apps/desktop/src",
  "apps/mobile/app.json",
  "apps/mobile/app",
  "apps/web/index.html",
  "apps/web/public/site.webmanifest",
  "apps/web/scripts",
  "apps/web/src/components",
  "apps/web/src/locales",
  "apps/web/src/pages",
  "apps/www/astro.config.mjs",
  "apps/www/middleware.ts",
  "apps/www/package.json",
  "apps/www/public",
  "apps/www/src",
  "docs",
  "infra/compose/backup-prod.sh",
  "infra/compose/docker-compose.prod.yml",
  "infra/compose/harden-host.sh",
  "infra/sandboxes/computer/embed.html",
  "infra/sandboxes/computer/fluxbox.menu",
  "infra/systemd",
  "packages/brandwell/src/brand-config.ts",
  "packages/core/src/compose-update.ts",
  "packages/core/src/self-update.ts",
  "packages/testkit/src/playwright-report-dashboard.ts",
  "packages/ui-web/src/styles.css",
];
const textExtensions = new Set([
  ".astro",
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".menu",
  ".mjs",
  ".po",
  ".service",
  ".sh",
  ".svg",
  ".timer",
  ".ts",
  ".tsx",
  ".txt",
  ".webmanifest",
  ".yaml",
  ".yml",
]);
const forbiddenBrand = /\b(?:Rakazo|Razako|RAZAKO)\b/;
const forbiddenApiBrand = /\b(?:rakazo|razako)\b/i;
const forbiddenReleaseIdentity = [
  /(?:https?:\/\/(?:api\.)?github\.com\/(?:repos\/)?|ghcr\.io\/)[^\s)"']*\/rakazo(?:[/.?#\s"']|$)/i,
  /(?:https?:\/\/)?(?:www\.)?rakazo\.com\b/i,
  /\b(?:hello|security)@rakazo\.com\b/i,
  /\brepo:\s*rakazo\b/i,
  /"repo"\s*:\s*"rakazo"/i,
];
const classifiedLegacyIdentifiers = [
  {
    path: /^LICENSE$/,
    line: /^Copyright 2026 Rakazo contributors$/,
    classification: "legal attribution",
  },
  {
    path: /^apps\/api\/src\//,
    line: /["']@rakazo\//,
    classification: "workspace package namespace",
  },
  {
    path: /^apps\/api\/src\/app\.ts$/,
    line: /["']rakazo:\/\//,
    classification: "desktop protocol compatibility",
  },
  {
    path: /^apps\/api\/src\/env\.test\.ts$/,
    line: /postgres:\/\/rakazo:rakazo@[^\s"']*\/rakazo/,
    classification: "test fixture identifier",
  },
  {
    path: /^apps\/api\/src\/router\.test\.ts$/,
    line: /(?:@rakazo\.test|\/tmp\/rakazo-router-test)/,
    classification: "test fixture identifier",
  },
];

function portablePath(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function legacyIdentifierClassification(relativePath, line) {
  return classifiedLegacyIdentifiers.find(
    (entry) => entry.path.test(relativePath) && entry.line.test(line),
  )?.classification;
}

async function textFiles(target) {
  const absolute = path.join(root, target);
  const targetStat = await stat(absolute);
  if (targetStat.isFile()) return [absolute];
  const files = [];
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const child = path.join(absolute, entry.name);
    if (entry.isDirectory()) files.push(...(await textFiles(path.relative(root, child))));
    else if (entry.isFile() && textExtensions.has(path.extname(entry.name))) files.push(child);
  }
  return files;
}

const files = (await Promise.all(targets.map(textFiles))).flat();
const matches = [];
const classified = [];
for (const file of files) {
  const relativePath = portablePath(file);
  const lines = (await readFile(file, "utf8")).split(/\r?\n/);
  lines.forEach((line, index) => {
    const hasLegacyBrand =
      forbiddenBrand.test(line) ||
      forbiddenReleaseIdentity.some((pattern) => pattern.test(line)) ||
      (relativePath.startsWith("apps/api/src/") && forbiddenApiBrand.test(line));
    if (hasLegacyBrand) {
      const classification = legacyIdentifierClassification(relativePath, line);
      if (classification) {
        classified.push(`${relativePath}:${index + 1}: ${classification}`);
      } else {
        matches.push(`${relativePath}:${index + 1}: ${line.trim()}`);
      }
    }
  });
}

if (matches.length) {
  console.error("Forbidden legacy branding remains in an AIMEE public or customer surface:");
  console.error(matches.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `AIMEE branding check passed across ${files.length} customer-surface files; preserved ${classified.length} classified legal or internal compatibility identifiers.`,
  );
}
