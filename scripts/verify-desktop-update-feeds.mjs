import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const FEED_NAMES = ["latest.yml", "latest-mac.yml", "latest-linux.yml"];

function scalar(raw, feedName, lineNumber) {
  const value = raw.trim();
  if (value === "") throw new Error(`${feedName}:${lineNumber} has an empty value.`);
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(`${feedName}:${lineNumber} has an invalid quoted value.`);
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) {
      throw new Error(`${feedName}:${lineNumber} has an invalid quoted value.`);
    }
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

export function parseDesktopUpdateFeed(contents, feedName) {
  const feed = { version: null, path: null, sha512: null, files: [] };
  let inFiles = false;
  let currentFile = null;
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (indent === 0 && trimmed === "files:") {
      inFiles = true;
      currentFile = null;
      continue;
    }
    if (indent === 0) {
      inFiles = false;
      currentFile = null;
      const match = /^([A-Za-z][\w-]*):\s*(.+)$/.exec(trimmed);
      if (!match) continue;
      const [, key = "", raw = ""] = match;
      if (key === "version" || key === "path" || key === "sha512") {
        feed[key] = scalar(raw, feedName, lineNumber);
      }
      continue;
    }
    if (!inFiles) continue;
    const urlMatch = /^-\s+url:\s*(.+)$/.exec(trimmed);
    if (urlMatch) {
      currentFile = {
        url: scalar(urlMatch[1] ?? "", feedName, lineNumber),
        sha512: null,
        size: null,
      };
      feed.files.push(currentFile);
      continue;
    }
    const property = /^(sha512|size):\s*(.+)$/.exec(trimmed);
    if (property && currentFile) {
      const [, key = "", raw = ""] = property;
      currentFile[key] = scalar(raw, feedName, lineNumber);
    }
  }
  return feed;
}

function localAssetName(value, feedName) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error(`${feedName} contains an invalid encoded asset path.`);
  }
  if (
    decoded === "" ||
    decoded === "." ||
    decoded === ".." ||
    decoded.includes("/") ||
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(decoded)
  ) {
    throw new Error(`${feedName} contains a non-local asset path.`);
  }
  return decoded;
}

async function verifyAsset(directory, feedName, entry) {
  if (!entry.url || !entry.sha512) {
    throw new Error(`${feedName} has a file entry without a URL and SHA-512 digest.`);
  }
  const assetName = localAssetName(entry.url, feedName);
  const assetPath = path.join(directory, assetName);
  let metadata;
  try {
    metadata = await stat(assetPath);
  } catch {
    throw new Error(`${feedName} references missing asset ${assetName}.`);
  }
  if (!metadata.isFile()) throw new Error(`${feedName} references non-file asset ${assetName}.`);
  if (entry.size !== null) {
    const expectedSize = Number(entry.size);
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || metadata.size !== expectedSize) {
      throw new Error(`${feedName} has the wrong size for ${assetName}.`);
    }
  }
  const digest = createHash("sha512")
    .update(await readFile(assetPath))
    .digest("base64");
  if (digest !== entry.sha512) {
    throw new Error(`${feedName} has the wrong SHA-512 digest for ${assetName}.`);
  }
  return assetName;
}

export async function verifyDesktopUpdateFeeds(directory, expectedVersion) {
  for (const feedName of FEED_NAMES) {
    const feed = parseDesktopUpdateFeed(
      await readFile(path.join(directory, feedName), "utf8"),
      feedName,
    );
    if (feed.version !== expectedVersion) {
      throw new Error(`${feedName} does not describe version ${expectedVersion}.`);
    }
    if (feed.files.length === 0) throw new Error(`${feedName} has no downloadable files.`);
    const seen = new Set();
    for (const entry of feed.files) {
      const assetName = await verifyAsset(directory, feedName, entry);
      if (seen.has(assetName)) throw new Error(`${feedName} repeats asset ${assetName}.`);
      seen.add(assetName);
    }
    if (!feed.path || !feed.sha512) {
      throw new Error(`${feedName} has no primary path and SHA-512 digest.`);
    }
    const primaryName = localAssetName(feed.path, feedName);
    if (!seen.has(primaryName)) {
      throw new Error(`${feedName} primary asset ${primaryName} is absent from files.`);
    }
    await verifyAsset(directory, feedName, {
      url: feed.path,
      sha512: feed.sha512,
      size: null,
    });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const [directory, expectedVersion] = process.argv.slice(2);
  if (!directory || !expectedVersion) {
    console.error("Usage: node scripts/verify-desktop-update-feeds.mjs <directory> <version>");
    process.exitCode = 2;
  } else {
    try {
      await verifyDesktopUpdateFeeds(path.resolve(directory), expectedVersion);
      console.log(`Verified desktop update feeds for ${expectedVersion}.`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
