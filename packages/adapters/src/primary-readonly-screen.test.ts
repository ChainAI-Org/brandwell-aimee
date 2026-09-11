import { describe, expect, it } from "vitest";
import { extraDisplayLayout } from "./extra-displays.js";
import {
  ensurePrimaryReadonlyScreenCommand,
  PRIMARY_READONLY_PORT,
  PRIMARY_READONLY_VNC_PORT,
  stopPrimaryReadonlyScreenCommand,
} from "./primary-readonly-screen.js";

describe("primary passive screen lifecycle", () => {
  it("uses ports outside the vendor desktop and every extra display", () => {
    expect(PRIMARY_READONLY_PORT).toBe(6081);
    expect(PRIMARY_READONLY_VNC_PORT).toBe(5900);
    const allocated = new Set([6080, 5901]);
    for (let index = 1; index < 8; index += 1) {
      const layout = extraDisplayLayout(index, ":0");
      for (const port of [
        layout.viewPort,
        layout.controlPort,
        layout.viewVncPort,
        layout.controlVncPort,
      ]) {
        allocated.add(port);
      }
    }
    expect(allocated.has(PRIMARY_READONLY_PORT)).toBe(false);
    expect(allocated.has(PRIMARY_READONLY_VNC_PORT)).toBe(false);
  });

  it("rejects display and password text that could escape command construction", () => {
    for (const display of ["0", ":0; touch /tmp/unexpected", ":0\n", ":0.0"]) {
      expect(() => ensurePrimaryReadonlyScreenCommand(display, "viewer-secret")).toThrow();
    }
    for (const password of ["short", "x".repeat(65), "viewer'password", "viewer\npassword"]) {
      expect(() => ensurePrimaryReadonlyScreenCommand(":0", password)).toThrow();
    }
    expect(ensurePrimaryReadonlyScreenCommand(":99", "viewer-secret")).toContain('display = ":99"');
  });

  it("makes the VNC server enforce passive access on the existing display", () => {
    const command = ensurePrimaryReadonlyScreenCommand(":0", "viewer-secret");
    expect(command).toContain("'-forever', '-shared', '-viewonly'");
    expect(command).toContain("'-rfbauth', auth_file, '-listen', '127.0.0.1'");
    expect(command).toContain("'127.0.0.1:' + str(vnc_port)");
    expect(command).not.toContain("Xvfb");
    expect(command).not.toContain("pkill");
    expect(command).not.toContain("-nopw");
  });

  it("serializes setup and reuses only owned healthy processes and their password", () => {
    const command = ensurePrimaryReadonlyScreenCommand(":0", "viewer-secret");
    expect(command).toContain("fcntl.flock(lock, fcntl.LOCK_EX)");
    expect(command).toContain(
      "owned('vnc') and owned('proxy') and listening(vnc_port) and listening(view_port)",
    );
    expect(command).toContain("password = password_file.read_text()");
    expect(command).toContain("os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600");
    expect(command).toContain("os.chmod(auth_file, 0o600)");
    expect(command).toContain("close_fds=True");
  });

  it("refuses occupied ports before starting a viewer or returning credentials", () => {
    const command = ensurePrimaryReadonlyScreenCommand(":0", "viewer-secret");
    const collisionGuard = command.indexOf(
      "if not available(vnc_port) or not available(view_port):",
    );
    expect(collisionGuard).toBeGreaterThan(0);
    expect(collisionGuard).toBeLessThan(command.indexOf("launch('vnc'"));
    expect(command).toContain("raise RuntimeError('primary read-only port is already occupied')");
    expect(command).toContain("if not owned('vnc') or not owned('proxy'):");
    expect(command).toContain("print('AIMEE_PRIMARY_READONLY_UNAVAILABLE')");
    expect(command).not.toContain("print(password)");
  });

  it("checks both process start identity and argv before stopping a recorded PID", () => {
    const command = stopPrimaryReadonlyScreenCommand();
    expect(command).toContain('action = "stop"');
    expect(command).toContain(
      "current[0] == data['started'] and current[1][-len(expected):] == expected",
    );
    expect(command).toContain("data = owned(name)\n    if data:");
    expect(command).toContain(
      "if owned(name):\n                os.kill(data['pid'], signal.SIGKILL)",
    );
    expect(command).toContain("print('AIMEE_PRIMARY_READONLY_STOPPED')");
    expect(command).not.toContain("pkill");
    expect(command.indexOf("if action == 'stop':")).toBeLessThan(
      command.indexOf("password_file = root / 'password'"),
    );
  });
});
