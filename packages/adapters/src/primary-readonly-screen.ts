// Daytona owns 6080/5901. Extra displays use 6082/5902 and above.
export const PRIMARY_READONLY_PORT = 6081;
export const PRIMARY_READONLY_VNC_PORT = 5900;

export function ensurePrimaryReadonlyScreenCommand(display: string, password: string): string {
  if (!/^:\d+$/.test(display)) throw new Error("Invalid primary X display");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(password)) throw new Error("Invalid viewer password");
  return primaryReadonlyCommand("start", display, password);
}

export function stopPrimaryReadonlyScreenCommand(): string {
  return primaryReadonlyCommand("stop", ":0", "");
}

function primaryReadonlyCommand(action: "start" | "stop", display: string, password: string) {
  return `python3 - <<'AIMEE_PRIMARY_READONLY'
import fcntl, json, os, pathlib, shutil, signal, socket, subprocess, sys, time

root = pathlib.Path('/tmp/rakazo/primary-readonly')
root.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(root, 0o700)
lock = open(root / 'lock', 'a')
fcntl.flock(lock, fcntl.LOCK_EX)
action = ${JSON.stringify(action)}
display = ${JSON.stringify(display)}
supplied_password = ${JSON.stringify(password)}
view_port = ${PRIMARY_READONLY_PORT}
vnc_port = ${PRIMARY_READONLY_VNC_PORT}

def identity(pid):
    try:
        stat = pathlib.Path('/proc', str(pid), 'stat').read_text()
        started = stat[stat.rfind(')') + 2:].split()[19]
        argv = pathlib.Path('/proc', str(pid), 'cmdline').read_bytes().split(b'\\0')
        return started, [arg.decode() for arg in argv if arg]
    except (OSError, ValueError, UnicodeError):
        return None

def owned(name):
    try:
        data = json.loads((root / (name + '.json')).read_text())
        current = identity(data['pid'])
        expected = data['argv']
        if current and current[0] == data['started'] and current[1][-len(expected):] == expected:
            return data
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return None

def stop(name):
    data = owned(name)
    if data:
        try:
            os.kill(data['pid'], signal.SIGTERM)
            for _ in range(30):
                if not owned(name):
                    break
                time.sleep(0.1)
            if owned(name):
                os.kill(data['pid'], signal.SIGKILL)
        except ProcessLookupError:
            pass
    (root / (name + '.json')).unlink(missing_ok=True)

def listening(port):
    with socket.socket() as connection:
        connection.settimeout(0.2)
        return connection.connect_ex(('127.0.0.1', port)) == 0

def available(port):
    with socket.socket() as connection:
        connection.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            connection.bind(('0.0.0.0', port))
            return True
        except OSError:
            return False

def launch(name, argv):
    with open(root / (name + '.log'), 'ab') as log:
        child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log,
                                 stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
    current = identity(child.pid)
    if not current:
        raise RuntimeError('viewer process did not start')
    (root / (name + '.json')).write_text(json.dumps({'pid': child.pid, 'started': current[0], 'argv': argv}))

try:
    if action == 'stop':
        stop('proxy')
        stop('vnc')
        print('AIMEE_PRIMARY_READONLY_STOPPED')
        sys.exit(0)
    password_file = root / 'password'
    if owned('vnc') and owned('proxy') and listening(vnc_port) and listening(view_port):
        password = password_file.read_text()
        print('RAKAZO_SCREEN_PASSWORD=' + password)
        sys.exit(0)
    stop('proxy')
    stop('vnc')
    if not available(vnc_port) or not available(view_port):
        raise RuntimeError('primary read-only port is already occupied')
    x11vnc = shutil.which('x11vnc')
    websockify = shutil.which('websockify')
    if not x11vnc or not websockify or not pathlib.Path('/usr/share/novnc/core/rfb.js').is_file():
        raise RuntimeError('primary read-only dependencies unavailable')
    if not password_file.exists():
        descriptor = os.open(password_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as output:
            output.write(supplied_password)
    password = password_file.read_text()
    if len(password) < 8 or not all(char.isalnum() or char in '_-' for char in password):
        raise RuntimeError('primary read-only password is invalid')
    auth_file = str(root / 'auth')
    subprocess.run([x11vnc, '-storepasswd', password, auth_file], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.chmod(auth_file, 0o600)
    launch('vnc', [x11vnc, '-display', display, '-forever', '-shared', '-viewonly',
                   '-rfbauth', auth_file, '-listen', '127.0.0.1', '-rfbport', str(vnc_port), '-xkb', '-ncache', '0'])
    launch('proxy', [websockify, '--web=/usr/share/novnc', '0.0.0.0:' + str(view_port), '127.0.0.1:' + str(vnc_port)])
    for _ in range(100):
        if not owned('vnc') or not owned('proxy'):
            raise RuntimeError('primary read-only process exited')
        if listening(vnc_port) and listening(view_port):
            print('RAKAZO_SCREEN_PASSWORD=' + password)
            sys.exit(0)
        time.sleep(0.1)
    raise RuntimeError('primary read-only screen timed out')
except Exception:
    stop('proxy')
    stop('vnc')
    print('AIMEE_PRIMARY_READONLY_UNAVAILABLE')
    sys.exit(1)
AIMEE_PRIMARY_READONLY`;
}
