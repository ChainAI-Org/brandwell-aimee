import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targets = [
  ".github/ISSUE_TEMPLATE",
  ".github/workflows",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "README.md",
  "SECURITY.md",
  "SETUP_PROMPT.md",
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
const forbiddenReleaseIdentity = [
  /(?:https?:\/\/(?:api\.)?github\.com\/(?:repos\/)?|ghcr\.io\/)[^\s)"']*\/rakazo(?:[/.?#\s"']|$)/i,
  /(?:https?:\/\/)?(?:www\.)?rakazo\.com\b/i,
  /\b(?:hello|security)@rakazo\.com\b/i,
  /\brepo:\s*rakazo\b/i,
  /"repo"\s*:\s*"rakazo"/i,
];

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
for (const file of files) {
  const lines = (await readFile(file, "utf8")).split(/\r?\n/);
  lines.forEach((line, index) => {
    if (
      forbiddenBrand.test(line) ||
      forbiddenReleaseIdentity.some((pattern) => pattern.test(line))
    ) {
      matches.push(`${path.relative(root, file)}:${index + 1}: ${line.trim()}`);
    }
  });
}

if (matches.length) {
  console.error("Forbidden legacy branding remains in an AIMEE public or customer surface:");
  console.error(matches.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`AIMEE branding check passed across ${files.length} customer-surface files.`);
}
