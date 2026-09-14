import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { extraDisplayLayout } from "./extra-displays.js";
import {
  ensurePrimaryControlScreenCommand,
  PRIMARY_CONTROL_PORT,
  PRIMARY_CONTROL_VNC_PORT,
  stopPrimaryControlScreenCommand,
} from "./primary-control-screen.js";

const python = ["python3", "python"].find(
  (binary) => spawnSync(binary, ["--version"], { timeout: 5_000, windowsHide: true }).status === 0,
);

describe("primary control commands", () => {
  it("reserves independent ports outside all passive, vendor, and extra screens", () => {
    const reserved = new Set([6080, 6081, 5900, 5901]);
    for (let index = 1; index < 8; index += 1) {
      const layout = extraDisplayLayout(index, ":0");
      for (const port of [
        layout.viewPort,
        layout.controlPort,
        layout.viewVncPort,
        layout.controlVncPort,
      ]) {
        reserved.add(port);
      }
    }
    expect(reserved.has(PRIMARY_CONTROL_PORT)).toBe(false);
    expect(reserved.has(PRIMARY_CONTROL_VNC_PORT)).toBe(false);
  });

  it("requires a valid token and keeps control VNC authenticated and local", () => {
    expect(() => ensurePrimaryControlScreenCommand(":0", "", "password-1")).toThrow();
    expect(() => stopPrimaryControlScreenCommand("lease'; unexpected")).toThrow();
    expect(() =>
      ensurePrimaryControlScreenCommand(":0; unexpected", "lease-1", "password-1"),
    ).toThrow();
    const command = ensurePrimaryControlScreenCommand(":0", "lease-1", "password-1");
    expect(command).toContain("'-rfbauth', auth_file, '-listen', '127.0.0.1'");
    expect(command).not.toContain("-nopw");
    expect(command).not.toContain("pkill");
    expect(command).not.toContain("Xvfb");
    expect(command).toContain(
      "current[0] == data['started'] and current[1][-len(expected):] == expected",
    );
  });
});

describe.skipIf(!python)("primary control lifecycle execution", () => {
  it("denies a delayed start when the lease was released before any process started", () => {
    const results = lifecycle([
      stopPrimaryControlScreenCommand("lease-old"),
      ensurePrimaryControlScreenCommand(":0", "lease-old", "password-1"),
    ]);
    expect(results[1]).toMatchObject({
      code: 1,
      output: "AIMEE_PRIMARY_CONTROL_UNAVAILABLE\n",
      active: [],
      launches: 0,
      stops: 0,
    });
  });

  it("denies a replaced token's late start without stopping the newer lease", () => {
    const results = lifecycle([
      ensurePrimaryControlScreenCommand(":0", "lease-old", "password-1"),
      ensurePrimaryControlScreenCommand(":0", "lease-new", "password-2"),
      ensurePrimaryControlScreenCommand(":0", "lease-old", "password-3"),
    ]);
    expect(results[2]).toMatchObject({
      code: 1,
      output: "AIMEE_PRIMARY_CONTROL_UNAVAILABLE\n",
      active: ["proxy", "vnc"],
      launches: 4,
      stops: 2,
      token: "lease-new",
    });
  });

  it("fails closed on malformed revocation state without resetting its history", () => {
    const results = lifecycle(
      [
        ensurePrimaryControlScreenCommand(":0", "lease-old", "password-1"),
        ensurePrimaryControlScreenCommand(":0", "lease-new", "password-2"),
      ],
      "revocation-corrupt",
    );
    expect(results[1]).toMatchObject({
      code: 1,
      output: "AIMEE_PRIMARY_CONTROL_UNAVAILABLE\n",
      active: [],
      launches: 2,
      stops: 2,
    });
  });

  it("reuses the actual password without restarting healthy processes for the same lease", () => {
    const results = lifecycle([
      ensurePrimaryControlScreenCommand(":0", "lease-1", "password-1"),
      ensurePrimaryControlScreenCommand(":0", "lease-1", "password-2"),
    ]);
    expect(results[1]).toMatchObject({
      code: 0,
      output: "RAKAZO_SCREEN_PASSWORD=password-1\n",
      launches: 2,
      stops: 0,
    });
  });

  it("ignores an old token after a new lease starts and then stops the current lease", () => {
    const results = lifecycle([
      ensurePrimaryControlScreenCommand(":0", "lease-old", "password-1"),
      ensurePrimaryControlScreenCommand(":0", "lease-new", "password-2"),
      stopPrimaryControlScreenCommand("lease-old"),
      stopPrimaryControlScreenCommand("lease-new"),
    ]);
    expect(results[2]).toMatchObject({
      code: 0,
      output: "AIMEE_PRIMARY_CONTROL_STALE\n",
      active: ["proxy", "vnc"],
      launches: 4,
      stops: 2,
    });
    expect(results[3]).toMatchObject({
      code: 0,
      output: "AIMEE_PRIMARY_CONTROL_STOPPED\n",
      active: [],
      launches: 4,
      stops: 4,
      token: null,
    });
  });

  it("refuses unowned port collisions without issuing credentials or launching processes", () => {
    expect(
      lifecycle([ensurePrimaryControlScreenCommand(":0", "lease-1", "password-1")], "occupied")[0],
    ).toMatchObject({
      code: 1,
      output: "AIMEE_PRIMARY_CONTROL_UNAVAILABLE\n",
      launches: 0,
      stops: 0,
      active: [],
    });
  });

  it("cleans up only its started VNC when proxy startup fails", () => {
    expect(
      lifecycle(
        [ensurePrimaryControlScreenCommand(":0", "lease-1", "password-1")],
        "proxy-fails",
      )[0],
    ).toMatchObject({
      code: 1,
      output: "AIMEE_PRIMARY_CONTROL_UNAVAILABLE\n",
      launches: 1,
      stops: 1,
      active: [],
    });
  });
});

interface LifecycleResult {
  code: number;
  output: string;
  active: string[];
  launches: number;
  stops: number;
  token: string | null;
}

function lifecycle(commands: string[], scenario = "normal"): LifecycleResult[] {
  const result = spawnSync(python!, ["-c", lifecycleHarness], {
    input: JSON.stringify({ commands, scenario }),
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  expect(result.status, result.stderr || String(result.error ?? "")).toBe(0);
  return JSON.parse(result.stdout) as LifecycleResult[];
}

// Execute the generated Python lifecycle while replacing only process and port effects.
const lifecycleHarness = String.raw`
import contextlib, io, json, pathlib, sys, tempfile, types
spec = json.load(sys.stdin)
sys.modules['fcntl'] = types.SimpleNamespace(LOCK_EX=1, flock=lambda *args: None)
active = {}
launches = []
stops = []
results = []
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    for command in spec['commands']:
        if spec['scenario'] == 'revocation-corrupt' and len(results) == 1:
            (root / 'revoked').write_text('invalid fixture history')
        source = command.split('\n', 1)[1].rsplit('\nAIMEE_PRIMARY_CONTROL', 1)[0]
        source = source.replace("pathlib.Path('/tmp/rakazo/primary-control')", 'pathlib.Path(' + repr(directory) + ')')
        source = source.replace("pathlib.Path('/usr/share/novnc/core/rfb.js').is_file()", 'True')
        prefix, body = source.split('\ntry:\n    current_token', 1)
        namespace = {}
        exec(prefix, namespace)
        def stop(name):
            if name in active:
                stops.append(name)
                del active[name]
        def launch(name, argv):
            if spec['scenario'] == 'proxy-fails' and name == 'proxy':
                raise RuntimeError('fixture proxy failure')
            active[name] = argv
            launches.append(name)
        def run(argv, **kwargs):
            pathlib.Path(argv[-1]).write_text('fixture-auth')
        namespace.update({
            'owned': lambda name: active.get(name),
            'stop': stop,
            'launch': launch,
            'listening': lambda port: bool(active.get('vnc' if port == 5916 else 'proxy')),
            'available': lambda port: spec['scenario'] != 'occupied',
            'subprocess': types.SimpleNamespace(run=run, DEVNULL=None),
            'shutil': types.SimpleNamespace(which=lambda name: '/usr/bin/' + name),
        })
        output = io.StringIO()
        code = None
        with contextlib.redirect_stdout(output):
            try:
                exec('try:\n    current_token' + body, namespace)
            except SystemExit as error:
                code = error.code
        token_file = root / 'token'
        if spec['scenario'] == 'revocation-corrupt' and len(results) == 1:
            assert (root / 'revoked').read_text() == 'invalid fixture history'
        results.append({'code': code, 'output': output.getvalue(), 'active': sorted(active),
                        'launches': len(launches), 'stops': len(stops),
                        'token': token_file.read_text() if token_file.exists() else None})
        namespace['lock'].close()
print(json.dumps(results))
`;
