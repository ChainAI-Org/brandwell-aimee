import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aimee-update-feed-"));
  temporaryDirectories.push(directory);
  await mkdir(directory, { recursive: true });
  return directory;
}

async function asset(directory: string, name: string, contents: string) {
  const bytes = Buffer.from(contents);
  await writeFile(path.join(directory, name), bytes);
  return {
    name,
    size: bytes.length,
    sha512: createHash("sha512").update(bytes).digest("base64"),
  };
}

function feed(
  version: string,
  files: Array<{ name: string; size: number; sha512: string }>,
  primary = files[0],
) {
  if (!primary) throw new Error("A feed fixture needs a primary asset.");
  return [
    `version: ${version}`,
    "files:",
    ...files.flatMap((file) => [
      `  - url: ${encodeURIComponent(file.name)}`,
      `    sha512: ${file.sha512}`,
      `    size: ${file.size}`,
    ]),
    `path: ${encodeURIComponent(primary.name)}`,
    `sha512: ${primary.sha512}`,
    'releaseDate: "2026-08-30T00:00:00.000Z"',
    "",
  ].join("\n");
}

describe("desktop update feed verifier", () => {
  it("validates Windows, macOS, and Linux metadata against every merged artifact", async () => {
    const directory = await fixture();
    const windows = await asset(directory, "BrandWell AIMEE Setup.exe", "windows-installer");
    const macZip = await asset(directory, "BrandWell AIMEE.zip", "mac-update");
    const macDmg = await asset(directory, "BrandWell AIMEE.dmg", "mac-installer");
    const linux = await asset(directory, "BrandWell AIMEE.AppImage", "linux-appimage");
    await writeFile(path.join(directory, "latest.yml"), feed("0.2.0", [windows]));
    await writeFile(
      path.join(directory, "latest-mac.yml"),
      feed("0.2.0", [macZip, macDmg], macZip),
    );
    await writeFile(path.join(directory, "latest-linux.yml"), feed("0.2.0", [linux]));

    const { verifyDesktopUpdateFeeds } = await import(
      "../../../scripts/verify-desktop-update-feeds.mjs"
    );
    await expect(verifyDesktopUpdateFeeds(directory, "0.2.0")).resolves.toBeUndefined();
  });

  it("fails closed when a feed digest does not match its asset", async () => {
    const directory = await fixture();
    const windows = await asset(directory, "AIMEE.exe", "windows-installer");
    const mac = await asset(directory, "AIMEE.zip", "mac-update");
    const linux = await asset(directory, "AIMEE.AppImage", "linux-appimage");
    await writeFile(path.join(directory, "latest.yml"), feed("0.2.0", [windows]));
    await writeFile(path.join(directory, "latest-mac.yml"), feed("0.2.0", [mac]));
    await writeFile(path.join(directory, "latest-linux.yml"), feed("0.2.0", [linux]));
    await writeFile(path.join(directory, windows.name), "tampered");

    const { verifyDesktopUpdateFeeds } = await import(
      "../../../scripts/verify-desktop-update-feeds.mjs"
    );
    await expect(verifyDesktopUpdateFeeds(directory, "0.2.0")).rejects.toThrow("wrong size");
  });
});
