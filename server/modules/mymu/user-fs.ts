// user-fs.ts — cross-user disk access for the one-MyMu-per-host model (phase 2).
//
// One instance per host serves EVERY mapped linux user, but runs as a single
// unix user and cannot read the others' homes. This layer bridges that with
// narrow `sudo -n -u <user>` calls: reads, writes, directory trees, and the
// per-user ~/.claude/sessions registries all execute AS the linux user that
// owns them. The account→linux-user mapping (users.linux_user) decides who is
// reachable; a path is only ever escalated to the user whose /home/<user>/
// prefix it carries, and only when that user is actually mapped in auth.db —
// there is NO path by which a request escalates to root or an unmapped user.
//
// Deployment prerequisite (only on hosts with foreign mapped users, e.g. box):
//   /etc/sudoers.d/ccui-<service-user>-multiuser
//   <service-user> ALL=(<user1>,<user2>,…) NOPASSWD: ALL
// Hosts where every mapped user IS the service user (berlin, thinkpad) never
// invoke sudo — everything short-circuits to plain fs.

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { userDb } from '@/modules/database/index.js';

import { getUserSecret } from './session-secrets.js';

const MAX_READ_BYTES = 256 * 1024 * 1024;

export const SERVICE_USER = os.userInfo().username;

// Same names the JS walker skips — keep in sync with IGNORED_DIRS in index.js.
const IGNORED_DIR_NAMES = [
  'node_modules', 'dist', 'build', '.next', '.nuxt', '.cache', '.parcel-cache',
  '.git', '.svn', '.hg',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', 'venv', '.venv',
  'target', 'vendor',
  '.gradle', '.idea', 'coverage', '.nyc_output',
];

/** Usernames must be shell-safe before they touch a sudo command line. */
const SAFE_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

let mappedCache: { at: number; users: string[] } | null = null;

/**
 * Linux users (≠ service user) that accounts on this instance map to AND that
 * exist on this host. Cached briefly; drives both path-ownership checks and the
 * multi-user session-registry scan.
 */
export function mappedForeignUsers(): string[] {
  const now = Date.now();
  if (mappedCache && now - mappedCache.at < 30_000) return mappedCache.users;
  let users: string[] = [];
  try {
    users = [...new Set(
      userDb.listLinuxUserMappings()
        .map((m) => (m.linux_user ?? m.username ?? '').trim())
        .filter((u) => u && u !== SERVICE_USER && SAFE_USER_RE.test(u))
        .filter((u) => fs.existsSync(`/home/${u}`)),
    )];
  } catch {
    users = [];
  }
  mappedCache = { at: now, users };
  return users;
}

/**
 * The mapped foreign linux user whose home a path lives in, or null when the
 * path is the service user's own territory (plain fs handles it).
 */
export function ownerForPath(p: string | null | undefined): string | null {
  if (!p) return null;
  const m = /^\/home\/([^/]+)(\/|$)/.exec(path.resolve(p));
  if (!m) return null;
  const candidate = m[1];
  if (candidate === SERVICE_USER) return null;
  return mappedForeignUsers().includes(candidate) ? candidate : null;
}

function sudoArgs(user: string, argv: string[]): string[] {
  if (!SAFE_USER_RE.test(user)) throw new Error(`unsafe user: ${user}`);
  return ['-n', '-u', user, '--', ...argv];
}

// --- Password-auth ("model b") cross-user runner --------------------------
//
// When a live in-memory secret exists for the target user (they logged in with
// their LINUX password), we become them with `su` instead of `sudo` — no root
// seam required. `su` insists on a controlling terminal for the password, but a
// PTY mangles binary output, so this helper gives `su` a PTY *only* for the
// password (echo off) while the command's stdout goes to a SEPARATE clean pipe.
// util-linux `su` does not reliably forward positional args to `-c`, so the
// program is passed as ONE shlex-quoted command string. Exit 0 = ok; 111 = auth
// failure (or the command itself failed and no output was produced).
//
// Invoked as: python3 -c SU_RUN_SRC <user> -- <argv...>   (password on stdin,
// first line). Works identically under execFile (async) and execFileSync (sync).
const SU_RUN_SRC = `
import os, sys, pty, termios, select, fcntl, shlex
user = sys.argv[1]
sep = sys.argv.index('--')
prog_argv = sys.argv[sep + 1:]
password = sys.stdin.buffer.readline().rstrip(b'\\n')
cmd = ' '.join(shlex.quote(a) for a in prog_argv)
su_argv = ['su', '-l', '-s', '/bin/sh', user, '-c', cmd]
master, slave = pty.openpty()
attrs = termios.tcgetattr(slave)
attrs[3] &= ~termios.ECHO
termios.tcsetattr(slave, termios.TCSANOW, attrs)
out_r, out_w = os.pipe()
pid = os.fork()
if pid == 0:
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    os.dup2(slave, 0)
    os.dup2(out_w, 1)
    os.dup2(slave, 2)
    for fd in (master, slave, out_r, out_w):
        try:
            os.close(fd)
        except OSError:
            pass
    os.execvp('su', su_argv)
    os._exit(127)
os.close(slave)
os.close(out_w)
sent = False
buf = b''
prompt = b''
watch = {master, out_r}
while watch:
    try:
        r, _, _ = select.select(list(watch), [], [], 15)
    except select.error:
        break
    if not r:
        break
    for fd in r:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            chunk = b''
        if not chunk:
            watch.discard(fd)
            continue
        if fd == master:
            prompt += chunk
            if not sent and b'assword' in prompt.lower():
                os.write(master, password + b'\\n')
                sent = True
        else:
            buf += chunk
    if out_r not in watch:
        break
_, status = os.waitpid(pid, 0)
code = os.waitstatus_to_exitcode(status)
sys.stdout.buffer.write(buf)
sys.stdout.buffer.flush()
sys.exit(0 if code == 0 else (111 if (not sent or b'failure' in prompt.lower()) else code))
`;

function suRunArgs(user: string, argv: string[]): string[] {
  if (!SAFE_USER_RE.test(user)) throw new Error(`unsafe user: ${user}`);
  return ['-c', SU_RUN_SRC, user, '--', ...argv];
}

/** execFile that captures stdout as a Buffer and optionally feeds stdin. */
function execCapture(
  command: string,
  args: string[],
  opts: { input?: Buffer | string; maxBuffer?: number } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { maxBuffer: opts.maxBuffer ?? MAX_READ_BYTES, encoding: 'buffer' as never },
      (err, stdout) => (err ? reject(err) : resolve(stdout as unknown as Buffer)),
    );
    child.stdin?.end(opts.input ?? '');
  });
}

/**
 * Run argv AS the owning user, choosing the mechanism by whether a live login
 * secret exists: password-based `su` (model b) when it does, else the classic
 * passwordless `sudo -n -u` (box). Callers are identical for both.
 */
async function runAsUser(user: string, argv: string[], opts: { maxBuffer?: number } = {}): Promise<Buffer> {
  const secret = getUserSecret(user);
  if (secret != null) {
    return execCapture('python3', suRunArgs(user, argv), { input: secret + '\n', maxBuffer: opts.maxBuffer });
  }
  return execCapture('sudo', sudoArgs(user, argv), { maxBuffer: opts.maxBuffer });
}

/** Synchronous sibling of runAsUser (hot-path registry readers). */
function runAsUserSync(user: string, argv: string[], opts: { maxBuffer?: number; timeout?: number } = {}): Buffer {
  const secret = getUserSecret(user);
  if (secret != null) {
    return execFileSync('python3', suRunArgs(user, argv), {
      input: secret + '\n',
      maxBuffer: opts.maxBuffer ?? MAX_READ_BYTES,
      timeout: opts.timeout,
    }) as Buffer;
  }
  return execFileSync('sudo', sudoArgs(user, argv), {
    maxBuffer: opts.maxBuffer ?? MAX_READ_BYTES,
    timeout: opts.timeout,
  }) as Buffer;
}

/**
 * Verify a linux user's password without changing anything (runs `true` as the
 * user via `su`). Used by the auth login path for PAM-authenticated accounts.
 */
export async function verifyLinuxPassword(user: string, password: string): Promise<boolean> {
  if (!SAFE_USER_RE.test(user) || typeof password !== 'string' || password === '') return false;
  try {
    await execCapture('python3', ['-c', SU_RUN_SRC, user, '--', 'true'], {
      input: password + '\n',
      maxBuffer: 4096,
    });
    return true;
  } catch {
    return false;
  }
}

// Stage bytes to a short-lived temp file the target user can read, for the `su`
// write path (its stdin is consumed by the password). Caller unlinks it.
function stageTempForUser(data: Buffer): string {
  const tmp = path.join(
    os.tmpdir(),
    `ccui-xfer-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.writeFileSync(tmp, data, { mode: 0o644 });
  return tmp;
}

// Collision-safe writer that reads its bytes from a FILE arg (su write path).
const COLLISION_WRITER_FROMFILE = `
import os, sys
target_dir, name, src = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(target_dir, exist_ok=True)
stem, ext = os.path.splitext(name)
data = open(src, 'rb').read()
i = 1
while True:
    candidate = os.path.join(target_dir, name if i == 1 else f'{stem}-{i}{ext}')
    try:
        with open(candidate, 'xb') as f:
            f.write(data)
        print(candidate)
        break
    except FileExistsError:
        i += 1
`;

/** Read a file's bytes as the owning user. */
export async function readFileAsUser(user: string, filePath: string): Promise<Buffer> {
  return runAsUser(user, ['cat', '--', filePath]);
}

/** Does the path exist for the owning user? */
export async function existsAsUser(user: string, filePath: string): Promise<boolean> {
  try {
    await runAsUser(user, ['test', '-e', filePath]);
    return true;
  } catch {
    return false;
  }
}

/** Is the path a directory for the owning user? */
export async function isDirAsUser(user: string, filePath: string): Promise<boolean> {
  try {
    await runAsUser(user, ['test', '-d', filePath]);
    return true;
  } catch {
    return false;
  }
}

/** mkdir -p as the owning user. */
export async function mkdirAsUser(user: string, dirPath: string): Promise<void> {
  await runAsUser(user, ['mkdir', '-p', '--', dirPath]);
}

/**
 * Canonicalize a path as the owning user (`readlink -m`: resolves symlinks in
 * every existing component, tolerates missing trailing components — the shape
 * project creation needs, where the leaf may not exist yet).
 */
export async function resolvePathAsUser(user: string, p: string): Promise<string> {
  const out = String(await runAsUser(user, ['readlink', '-m', '--', p])).trim();
  if (!out) throw new Error('cross-user path resolution returned nothing');
  return out;
}

// Python walker producing EXACTLY the shape of getFileTree in index.js:
// [{name, path, type, size, modified, permissions, permissionsRwx, isSymlink?,
//   truncated?, mount?, children?}] — sorted dirs-first then by name, depth
// cutoff marks truncated, mount boundaries never walked.
const TREE_WALKER = `
import json, os, stat, sys
root, max_depth = sys.argv[1], int(sys.argv[2])
ignored = set(json.loads(sys.argv[3]))
def rwx(bits):
    return ('r' if bits & 4 else '-') + ('w' if bits & 2 else '-') + ('x' if bits & 1 else '-')
def walk(d, depth, parent_dev):
    try:
        names = os.listdir(d)
    except OSError:
        return []
    items = []
    for name in names:
        p = os.path.join(d, name)
        try:
            st = os.lstat(p)
        except OSError:
            st = None
        is_dir = st is not None and stat.S_ISDIR(st.st_mode)
        if is_dir and name in ignored:
            continue
        item = {'name': name, 'path': p, 'type': 'directory' if is_dir else 'file'}
        if st is not None:
            item['size'] = st.st_size
            from datetime import datetime, timezone
            item['modified'] = datetime.fromtimestamp(st.st_mtime, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.') + ('%03dZ' % (st.st_mtime % 1 * 1000))
            if stat.S_ISLNK(st.st_mode):
                item['isSymlink'] = True
            mode = st.st_mode
            o, g, w = (mode >> 6) & 7, (mode >> 3) & 7, mode & 7
            item['permissions'] = f'{o}{g}{w}'
            item['permissionsRwx'] = rwx(o) + rwx(g) + rwx(w)
        else:
            item['size'] = 0
            item['modified'] = None
            item['permissions'] = '000'
            item['permissionsRwx'] = '---------'
        if is_dir:
            crosses = parent_dev is not None and st is not None and st.st_dev != parent_dev
            if crosses:
                item['truncated'] = True
                item['mount'] = True
            elif depth < max_depth:
                item['children'] = walk(p, depth + 1, st.st_dev if st else parent_dev)
            else:
                item['truncated'] = True
        items.append(item)
    items.sort(key=lambda i: (0 if i['type'] == 'directory' else 1, i['name']))
    return items
try:
    dev = os.lstat(root).st_dev
except OSError:
    dev = None
print(json.dumps(walk(root, 1, dev)))
`;

/** Directory tree as the owning user — same JSON shape as the local walker. */
export async function treeAsUser(user: string, root: string, maxDepth: number): Promise<unknown[]> {
  const stdout = await runAsUser(
    user,
    ['python3', '-c', TREE_WALKER, root, String(maxDepth), JSON.stringify(IGNORED_DIR_NAMES)],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(String(stdout));
}

// Collision-safe writer (wx semantics — never clobbers), bytes on stdin,
// prints the final absolute path. Mirrors saveIncomingFile's local behavior.
const COLLISION_WRITER = `
import os, sys
target_dir, name = sys.argv[1], sys.argv[2]
os.makedirs(target_dir, exist_ok=True)
stem, ext = os.path.splitext(name)
data = sys.stdin.buffer.read()
i = 1
while True:
    candidate = os.path.join(target_dir, name if i == 1 else f'{stem}-{i}{ext}')
    try:
        with open(candidate, 'xb') as f:
            f.write(data)
        print(candidate)
        break
    except FileExistsError:
        i += 1
`;

/** Write bytes into a directory as the owning user (collision-suffixed). Returns the path. */
export async function writeFileAsUser(user: string, targetDir: string, name: string, data: Buffer): Promise<string> {
  // su path: stdin carries the password, so stage the bytes to a temp file the
  // user reads from. sudo path keeps the original bytes-on-stdin behavior.
  if (getUserSecret(user) != null) {
    const tmp = stageTempForUser(data);
    try {
      const out = String(
        await runAsUser(user, ['python3', '-c', COLLISION_WRITER_FROMFILE, targetDir, name, tmp], {
          maxBuffer: 1024 * 1024,
        }),
      ).trim();
      if (!out) throw new Error('cross-user write returned no path');
      return out;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  return await new Promise<string>((resolve, reject) => {
    const child = execFile(
      'sudo',
      sudoArgs(user, ['python3', '-c', COLLISION_WRITER, targetDir, name]),
      { maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        const out = String(stdout).trim();
        if (!out) return reject(new Error('cross-user write returned no path'));
        resolve(out);
      },
    );
    child.stdin?.end(data);
  });
}

/** Overwrite one file's content as the owning user (save-from-editor path). */
export async function overwriteFileAsUser(user: string, filePath: string, content: string): Promise<void> {
  if (getUserSecret(user) != null) {
    const tmp = stageTempForUser(Buffer.from(content, 'utf8'));
    try {
      await runAsUser(user, [
        'python3', '-c', 'import sys\nopen(sys.argv[1], "wb").write(open(sys.argv[2], "rb").read())', filePath, tmp,
      ], { maxBuffer: 1024 * 1024 });
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      'sudo',
      sudoArgs(user, ['python3', '-c', 'import sys\nopen(sys.argv[1], "wb").write(sys.stdin.buffer.read())', filePath]),
      { maxBuffer: 1024 * 1024 },
      (err) => (err ? reject(err) : resolve()),
    );
    child.stdin?.end(Buffer.from(content, 'utf8'));
  });
}

/**
 * Move/rename a path as the owning user. The caller MUST jail both ends to the
 * project root and confirm the destination is free (`mv` would clobber).
 */
export async function renameAsUser(user: string, oldPath: string, newPath: string): Promise<void> {
  await runAsUser(user, ['mv', '--', oldPath, newPath]);
}

/**
 * Recursively remove a path as the owning user. The caller MUST jail it to the
 * project root and never pass the root itself (`rm -rf` is unforgiving).
 */
export async function removeAsUser(user: string, targetPath: string): Promise<void> {
  await runAsUser(user, ['rm', '-rf', '--', targetPath]);
}

/** Directory entry names as the owning user (flat, like fs.readdir). */
export async function listDirNamesAsUser(user: string, dir: string): Promise<string[]> {
  const stdout = await runAsUser(
    user,
    ['python3', '-c', 'import json,os,sys; print(json.dumps(os.listdir(sys.argv[1])))', dir],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  const parsed = JSON.parse(String(stdout));
  return Array.isArray(parsed) ? parsed : [];
}

// ~/.claude/sessions/*.json of a foreign user, as one JSON array. SYNC because
// local-sessions' resolver is sync and on hot paths; results are cached there.
const SESSIONS_READER = `
import glob, json, os
out = []
for f in glob.glob(os.path.expanduser('~/.claude/sessions/*.json')):
    try:
        out.append(json.load(open(f)))
    except Exception:
        pass
print(json.dumps(out))
`;

/** A foreign user's live-session registry entries (raw parsed JSON objects). */
export function sessionRegistryForUserSync(user: string): unknown[] {
  try {
    const stdout = runAsUserSync(user, ['python3', '-c', SESSIONS_READER], {
      timeout: 4000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const parsed = JSON.parse(String(stdout));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ~/.cloudcli/<subdir>/*.json of a foreign user, as one JSON array. Used by the
// codex + opencode registry readers so a box tenant's own agents surface, not
// just the service user's. SYNC to match the registry readers' hot paths (they
// cache the merged result themselves).
const CLOUDCLI_READER = `
import glob, json, os, sys
sub = sys.argv[1]
out = []
for f in glob.glob(os.path.expanduser('~/.cloudcli/' + sub + '/*.json')):
    try:
        out.append(json.load(open(f)))
    except Exception:
        pass
print(json.dumps(out))
`;

/** A foreign user's ~/.cloudcli/<subdir> registration files (raw parsed JSON). */
export function cloudcliRegistryForUserSync(user: string, subdir: string): unknown[] {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(subdir)) return [];
  try {
    const stdout = runAsUserSync(user, ['python3', '-c', CLOUDCLI_READER, subdir], {
      timeout: 4000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const parsed = JSON.parse(String(stdout));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
