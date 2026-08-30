import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targets = [
  "apps/desktop/package.json",
  "apps/desktop/src/setup.html",
  "apps/desktop/src/setup.js",
  "apps/mobile/app.json",
  "apps/mobile/app",
  "apps/web/index.html",
  "apps/web/public/site.webmanifest",
  "apps/web/scripts",
  "apps/web/src/components",
  "apps/web/src/locales",
  "apps/web/src/pages",
  "infra/sandboxes/computer/embed.html",
  "infra/sandboxes/computer/fluxbox.menu",
  "packages/brandwell/src/brand-config.ts",
];
const textExtensions = new Set([".html", ".js", ".json", ".menu", ".po", ".ts", ".tsx"]);
const forbiddenBrand = /\b(?:Rakazo|Razako|RAZAKO)\b/;

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
    if (forbiddenBrand.test(line)) {
      matches.push(`${path.relative(root, file)}:${index + 1}: ${line.trim()}`);
    }
  });
}

if (matches.length) {
  console.error("Forbidden upstream branding remains in an AIMEE customer surface:");
  console.error(matches.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`AIMEE branding check passed across ${files.length} customer-surface files.`);
}
