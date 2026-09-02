import { describe, expect, it } from "vitest";
import { ComputerScreenUnavailableError } from "./computer-screens.js";
import {
  allocateExtraDisplayCommand,
  ensureExtraDisplayCommand,
  extraDisplayControlStartCommand,
  extraDisplayLayout,
  extraDisplayObservationImagePath,
  observeExtraDisplayCommand,
  parseAllocatedExtraDisplay,
  parseExtraDisplayObservation,
  parseExtraDisplayViewPassword,
  parseReleasedExtraDisplay,
  releaseExtraDisplayCommand,
} from "./extra-displays.js";

describe("extra display ports", () => {
  it("keeps the vendor primary on index 0 and shifts extra screens by two", () => {
    expect(extraDisplayLayout(0, ":0")).toMatchObject({
      display: ":0",
      viewPort: 6080,
      controlPort: 6081,
      isPrimary: true,
    });
    expect(extraDisplayLayout(1, ":0")).toMatchObject({
      display: ":2",
      viewPort: 6082,
      controlPort: 6083,
      isPrimary: false,
    });
    expect(extraDisplayLayout(1, ":99")).toMatchObject({
      display: ":2",
      viewPort: 6082,
      controlPort: 6083,
    });
  });

  it("uses a locked sandbox registry for cross-process screen assignment", () => {
    const allocate = allocateExtraDisplayCommand("writer", "run-2:2");
    const release = releaseExtraDisplayCommand("writer", "run-2:2");
    expect(allocate).toContain("flock 9");
    expect(allocate).not.toContain("writer");
    expect(release).toContain("RAKAZO_SCREEN_RELEASE=stale");
    expect(release.indexOf("pkill -f")).toBeLessThan(release.indexOf('rm -f "$slot"'));
    expect(parseAllocatedExtraDisplay("RAKAZO_SCREEN_INDEX=3\n")).toBe(3);
    expect(parseReleasedExtraDisplay("RAKAZO_SCREEN_RELEASE=3\n")).toBe(3);
    expect(parseReleasedExtraDisplay("RAKAZO_SCREEN_RELEASE=stale\n")).toBeUndefined();
  });

  it("requires an authenticated password for view-only VNC", () => {
    expect(parseExtraDisplayViewPassword("RAKAZO_SCREEN_PASSWORD=sandbox_secret-1\n")).toBe(
      "sandbox_secret-1",
    );
    expect(() => parseExtraDisplayViewPassword("no password\n")).toThrow(
      ComputerScreenUnavailableError,
    );
  });

  it("lets Daytona download extra-display screenshots without command-output truncation", () => {
    const layout = extraDisplayLayout(1, ":0");
    const command = observeExtraDisplayCommand(layout, false);
    const image = new Uint8Array([137, 80, 78, 71]);

    expect(extraDisplayObservationImagePath(layout)).toBe("/tmp/rakazo/observe-2.png");
    expect(command).not.toContain("base64");
    expect(command).toContain("CURSOR");
    expect(parseExtraDisplayObservation("CURSOR X=12 Y=34", image)).toEqual({
      image,
      cursor: { x: 12, y: 34 },
    });
  });

  it("allows slow Daytona display services to become ready and reports their failure stage", () => {
    const layout = extraDisplayLayout(1, ":0");
    const view = ensureExtraDisplayCommand(
      layout,
      {
        homeDir: "/home/daytona",
        browserProfilesDir: "/home/daytona/aimee-home/.browser-profiles",
      },
      "view-password",
    );
    const control = extraDisplayControlStartCommand(layout, "control-token", "control-password");

    expect(view).toContain("AIMEE_SCREEN_FAILURE_STAGE");
    expect(view).toContain("exit_code=$?");
    expect(view.match(/flock -u 8/g)).toHaveLength(3);
    expect(view).toContain("exec 8>&-");
    expect(view).toContain("/bin/bash -c 'echo >/dev/tcp/127.0.0.1/5902'");
    expect(view).not.toContain("(echo >/dev/tcp");
    expect(view).toContain("seq 1 200");
    expect(control).toContain("/bin/bash -c 'echo >/dev/tcp/127.0.0.1/5903'");
    expect(control).not.toContain("(echo >/dev/tcp");
    expect(control.match(/seq 1 200/g)).toHaveLength(3);
  });
});
