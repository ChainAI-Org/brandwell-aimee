// Vendor and extra-display ports remain reserved for their existing owners.
export const PRIMARY_CONTROL_PORT = 6096;
export const PRIMARY_CONTROL_VNC_PORT = 5916;

export function ensurePrimaryControlScreenCommand(
  display: string,
  token: string,
  password: string,
): string {
  if (!/^:\d+$/.test(display)) throw new Error("Invalid primary X display");
  validateControlToken(token);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(password)) throw new Error("Invalid control password");
  return primaryControlCommand("start", display, token, password);
}

export function stopPrimaryControlScreenCommand(token?: string): string {
  if (token !== undefined) validateControlToken(token);
  return primaryControlCommand("stop", ":0", token ?? null, "");
}

function validateControlToken(token: string) {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(token)) throw new Error("Invalid control token");
}

function primaryControlCommand(
  action: "start" | "stop",
  display: string,
  token: string | null,
  password: string,
) {
  return `python3 - <<'AIMEE_PRIMARY_CONTROL'
import fcntl, hashlib, json, os, pathlib, signal, shutil, socket, subprocess, sys, time

root = pathlib.Path('/tmp/rakazo/primary-control')
root.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(root, 0o700)
lock = open(root / 'lock', 'a')
fcntl.flock(lock, fcntl.LOCK_EX)
action = ${JSON.stringify(action)}
display = ${JSON.stringify(display)}
control_token = ${token === null ? "None" : JSON.stringify(token)}
supplied_password = ${JSON.stringify(password)}
view_port = ${PRIMARY_CONTROL_PORT}
vnc_port = ${PRIMARY_CONTROL_VNC_PORT}

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
        try:
            connection.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            connection.bind(('0.0.0.0', port))
            return True
        except OSError:
            return False

def read_private(name):
    try:
        return (root / name).read_text()
    except FileNotFoundError:
        return None

def write_private(name, value):
    descriptor = os.open(root / name, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        os.fchmod(output.fileno(), 0o600)
        output.write(value)

def revoked_tokens():
    value = read_private('revoked')
    if value is None:
        return set()
    values = json.loads(value)
    if not isinstance(values, list) or any(not isinstance(item, str) or len(item) != 64 or any(char not in '0123456789abcdef' for char in item) for item in values):
        raise RuntimeError('invalid control revocations')
    return set(values)

def token_key(value):
    return hashlib.sha256(value.encode()).hexdigest()

def revoke(value, revoked):
    if value is None:
        return
    revoked.add(token_key(value))
    write_private('revoked.next', json.dumps(sorted(revoked)))
    with open(root / 'revoked.next', 'r+') as pending:
        os.fsync(pending.fileno())
    os.replace(root / 'revoked.next', root / 'revoked')
    if hasattr(os, 'O_DIRECTORY'):
        descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

def launch(name, argv):
    with open(root / (name + '.log'), 'ab') as log:
        child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log,
                                 stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
    current = identity(child.pid)
    if not current:
        raise RuntimeError('control process did not start')
    (root / (name + '.json')).write_text(json.dumps({'pid': child.pid, 'started': current[0], 'argv': argv}))

started_here = False
try:
    current_token = read_private('token')
    try:
        revoked = revoked_tokens()
    except Exception:
        stop('proxy')
        stop('vnc')
        raise
    if action == 'stop':
        revoke(control_token if control_token is not None else current_token, revoked)
        if control_token is not None and current_token != control_token:
            print('AIMEE_PRIMARY_CONTROL_STALE')
            sys.exit(0)
        stop('proxy')
        stop('vnc')
        for name in ['token', 'password', 'auth']:
            (root / name).unlink(missing_ok=True)
        print('AIMEE_PRIMARY_CONTROL_STOPPED')
        sys.exit(0)
    if token_key(control_token) in revoked:
        raise RuntimeError('control token was revoked')
    password = read_private('password') if current_token == control_token else supplied_password
    if not password or len(password) < 8 or not all(char.isalnum() or char in '_-' for char in password):
        raise RuntimeError('primary control password is invalid')
    if current_token == control_token and owned('vnc') and owned('proxy') and listening(vnc_port) and listening(view_port):
        print('RAKAZO_SCREEN_PASSWORD=' + password)
        sys.exit(0)
    if current_token != control_token:
        revoke(current_token, revoked)
    stop('proxy')
    stop('vnc')
    if not available(vnc_port) or not available(view_port):
        raise RuntimeError('primary control port is already occupied')
    x11vnc = shutil.which('x11vnc')
    websockify = shutil.which('websockify')
    if not x11vnc or not websockify or not pathlib.Path('/usr/share/novnc/core/rfb.js').is_file():
        raise RuntimeError('primary control dependencies unavailable')
    write_private('token', control_token)
    write_private('password', password)
    auth_file = str(root / 'auth')
    subprocess.run([x11vnc, '-storepasswd', password, auth_file], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.chmod(auth_file, 0o600)
    started_here = True
    launch('vnc', [x11vnc, '-display', display, '-forever', '-shared',
                   '-rfbauth', auth_file, '-listen', '127.0.0.1', '-rfbport', str(vnc_port), '-xkb', '-ncache', '0'])
    launch('proxy', [websockify, '--web=/usr/share/novnc', '0.0.0.0:' + str(view_port), '127.0.0.1:' + str(vnc_port)])
    for _ in range(100):
        if not owned('vnc') or not owned('proxy'):
            raise RuntimeError('primary control process exited')
        if listening(vnc_port) and listening(view_port):
            print('RAKAZO_SCREEN_PASSWORD=' + password)
            sys.exit(0)
        time.sleep(0.1)
    raise RuntimeError('primary control screen timed out')
except Exception:
    if started_here:
        stop('proxy')
        stop('vnc')
    print('AIMEE_PRIMARY_CONTROL_UNAVAILABLE')
    sys.exit(1)
AIMEE_PRIMARY_CONTROL`;
}
