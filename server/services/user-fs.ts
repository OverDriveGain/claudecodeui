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
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { userDb } from '@/modules/database/index.js';

const execFileAsync = promisify(execFile);

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

/** Read a file's bytes as the owning user. */
export async function readFileAsUser(user: string, filePath: string): Promise<Buffer> {
  const { stdout } = await execFileAsync('sudo', sudoArgs(user, ['cat', '--', filePath]), {
    maxBuffer: MAX_READ_BYTES,
    encoding: 'buffer' as never,
  });
  return stdout as unknown as Buffer;
}

/** Does the path exist for the owning user? */
export async function existsAsUser(user: string, filePath: string): Promise<boolean> {
  try {
    await execFileAsync('sudo', sudoArgs(user, ['test', '-e', filePath]));
    return true;
  } catch {
    return false;
  }
}

/** Is the path a directory for the owning user? */
export async function isDirAsUser(user: string, filePath: string): Promise<boolean> {
  try {
    await execFileAsync('sudo', sudoArgs(user, ['test', '-d', filePath]));
    return true;
  } catch {
    return false;
  }
}

/** mkdir -p as the owning user. */
export async function mkdirAsUser(user: string, dirPath: string): Promise<void> {
  await execFileAsync('sudo', sudoArgs(user, ['mkdir', '-p', '--', dirPath]));
}

/**
 * Canonicalize a path as the owning user (`readlink -m`: resolves symlinks in
 * every existing component, tolerates missing trailing components — the shape
 * project creation needs, where the leaf may not exist yet).
 */
export async function resolvePathAsUser(user: string, p: string): Promise<string> {
  const { stdout } = await execFileAsync('sudo', sudoArgs(user, ['readlink', '-m', '--', p]));
  const out = String(stdout).trim();
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
  const { stdout } = await execFileAsync(
    'sudo',
    sudoArgs(user, ['python3', '-c', TREE_WALKER, root, String(maxDepth), JSON.stringify(IGNORED_DIR_NAMES)]),
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

/** Directory entry names as the owning user (flat, like fs.readdir). */
export async function listDirNamesAsUser(user: string, dir: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'sudo',
    sudoArgs(user, ['python3', '-c', 'import json,os,sys; print(json.dumps(os.listdir(sys.argv[1])))', dir]),
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
    const stdout = execFileSync('sudo', sudoArgs(user, ['python3', '-c', SESSIONS_READER]), {
      timeout: 4000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const parsed = JSON.parse(String(stdout));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
