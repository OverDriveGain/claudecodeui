// tenant-exec.ts — run a configured command AS a tenant's linux user.
//
// The generic primitive behind "click an offline agent → it comes online": a
// per-tenant shell command (users.agent_start_cmd, e.g. `spawn-agents {name}`)
// executed as that account's linux_user. On hosts where the account's linux_user
// IS the service user (berlin, thinkpad) this runs directly; where it is a
// foreign mapped user (box) it goes through the same `sudo -n -u <user>` path as
// user-fs, backed by the `mymu-users` NOPASSWD sudoers group.
//
// SECURITY: the command TEMPLATE is server-side config the tenant sets for their
// OWN account (and it runs as their OWN linux user — no privilege escalation
// beyond what they already hold on the host). The client only names an agent;
// `{name}` is strict-validated before substitution and the resolved command is
// handed to `bash -lc` as a single argv element (no client string reaches a
// shell unchecked).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

import { userDb } from '@/modules/database/index.js';

const execFileAsync = promisify(execFile);

const SERVICE_USER = os.userInfo().username;

/** linux usernames must be shell-safe before they touch a sudo command line. */
const SAFE_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

/** Agent names allowed into the `{name}` slot — no shell metacharacters. */
const SAFE_AGENT_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

const EXEC_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export type TenantExecResult = {
  ok: boolean;
  code: number | null;
  command: string;
  user: string;
  stdout: string;
  stderr: string;
};

export class TenantExecError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'TenantExecError';
    this.statusCode = statusCode;
  }
}

/**
 * Resolve a tenant's start-command template + run-as user for a given agent.
 * Throws TenantExecError (400) when the feature is unconfigured or inputs are
 * unsafe. Returns the concrete command string and the linux user to run it as.
 */
export function resolveStartCommand(userId: number, agentName: string): { command: string; user: string } {
  const name = typeof agentName === 'string' ? agentName.trim() : '';
  if (!SAFE_AGENT_NAME_RE.test(name)) {
    throw new TenantExecError('Invalid agent name', 400);
  }
  const cfg = userDb.getAgentStartConfig(userId);
  const template = cfg?.agent_start_cmd?.trim();
  if (!template) {
    throw new TenantExecError('No start command configured for this account (Settings → Agents).', 400);
  }
  // linux_user NULL means "same as the account username"; fall back to service
  // user only when nothing maps (single-user berlin/thinkpad default).
  const user = (cfg?.linux_user?.trim()) || SERVICE_USER;
  if (!SAFE_USER_RE.test(user)) {
    throw new TenantExecError('Invalid linux user mapping for this account', 400);
  }
  const command = template.split('{name}').join(name);
  return { command, user };
}

/**
 * Run `command` as linux `user` via `bash -lc`, through sudo only when the
 * target differs from the service user. Never throws on a non-zero exit — the
 * caller inspects `ok`/`code`; only spawn failures reject.
 */
export async function runAsTenant(user: string, command: string): Promise<TenantExecResult> {
  if (!SAFE_USER_RE.test(user)) {
    throw new TenantExecError('Invalid linux user', 400);
  }
  const bashArgv = ['bash', '-lc', command];
  const [file, argv] = user === SERVICE_USER
    ? [bashArgv[0], bashArgv.slice(1)]
    : ['sudo', ['-n', '-u', user, '--', ...bashArgv]];

  try {
    const { stdout, stderr } = await execFileAsync(file, argv, {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: { ...process.env },
    });
    return { ok: true, code: 0, command, user, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
    // execFile rejects on non-zero exit — surface it as a structured result,
    // not an exception, so the UI can show the tool's own error output.
    if (typeof e.code === 'number' || e.killed) {
      return {
        ok: false,
        code: typeof e.code === 'number' ? e.code : null,
        command,
        user,
        stdout: String(e.stdout ?? ''),
        stderr: String(e.stderr ?? (e.killed ? 'command timed out' : e.message)),
      };
    }
    // Spawn-level failure (sudo missing, ENOENT) — genuinely exceptional.
    throw new TenantExecError(`Failed to run start command: ${e.message}`, 500);
  }
}

/** Convenience: resolve + run a tenant's offline-agent start command. */
export async function startAgentForTenant(userId: number, agentName: string): Promise<TenantExecResult> {
  const { command, user } = resolveStartCommand(userId, agentName);
  return runAsTenant(user, command);
}
