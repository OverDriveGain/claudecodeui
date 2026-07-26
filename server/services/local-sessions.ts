// local-sessions.ts — resolve a live agent's working directory on THIS host.
//
// Claude Code keeps a per-host registry of its live sessions at
// `~/.claude/sessions/<pid>.json`, each holding the agent's `cwd`, `name`,
// `status`, and — crucially — `bridgeSessionId`, the same relay session id
// (`session_…` / `cse_…`) the Remote Control API exposes.
//
// The relay itself reports `session_context.cwd` as empty for bridge sessions,
// so this local registry is how a CCUI instance points its file browser at an
// agent that runs on the SAME host. Cross-host resolution (an agent on another
// machine) is layered on top via the CCUI peer mesh — this module only ever
// answers for sessions local to this host.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { mappedForeignUsers, sessionRegistryForUserSync } from './user-fs.js';

// Claude's live-session registry. `CLAUDE_SESSIONS_DIR` overrides the default
// for relocated ~/.claude layouts (and lets a test instance point at an empty
// dir to force cross-host federation).
function sessionsDir(): string {
  const override = process.env.CLAUDE_SESSIONS_DIR;
  return override && override.length > 0 ? override : path.join(os.homedir(), '.claude', 'sessions');
}

// Reading + parsing every session file on each request is wasteful for an
// interactive file browser; the registry changes slowly, so cache the parsed
// suffix→record map for a short window.
const CACHE_TTL_MS = 3000;

export interface LocalSession {
  sessionId: string; // bridgeSessionId as stored (session_… / cse_…)
  cwd: string;
  name?: string;
  status?: string;
  pid?: number;
  /** Linux user whose registry claimed this session (one-instance-per-host). */
  owner?: string;
}

type Cache = { at: number; map: Map<string, LocalSession> };
let cache: Cache | null = null;

/** Relay ids share a suffix across the `session_`/`cse_` prefixes — match on it. */
function sessionSuffix(id: string): string {
  const underscore = id.indexOf('_');
  return underscore >= 0 ? id.slice(underscore + 1) : id;
}

/** Build (or reuse) the suffix→session map from `~/.claude/sessions/*.json`. */
function loadLocalSessions(): Map<string, LocalSession> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return cache.map;
  }

  const dir = sessionsDir();
  const map = new Map<string, LocalSession>();
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    // No sessions dir (claude never ran here) — empty map, cached briefly.
    cache = { at: now, map };
    return map;
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8');
      const parsed = JSON.parse(raw) as {
        bridgeSessionId?: unknown;
        cwd?: unknown;
        name?: unknown;
        status?: unknown;
        pid?: unknown;
      };
      const bsid = parsed.bridgeSessionId;
      const cwd = parsed.cwd;
      if (typeof bsid === 'string' && bsid && typeof cwd === 'string' && cwd) {
        map.set(sessionSuffix(bsid), {
          sessionId: bsid,
          cwd,
          name: typeof parsed.name === 'string' ? parsed.name : undefined,
          status: typeof parsed.status === 'string' ? parsed.status : undefined,
          pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
        });
      }
    } catch {
      // Skip half-written / unreadable session files.
    }
  }

  // One-instance-per-host: fold in every mapped FOREIGN linux user's registry
  // (read via sudo as that user), so agents run by other users on this host
  // resolve too — that's what lights up their files/projects for their CCUI
  // accounts. Cached longer than our own dir (sudo+python per user is ~100ms).
  for (const [suffix, session] of loadForeignSessions()) {
    if (!map.has(suffix)) map.set(suffix, session);
  }

  cache = { at: now, map };
  return map;
}

const FOREIGN_CACHE_TTL_MS = 15_000;
let foreignCache: Cache | null = null;

function loadForeignSessions(): Map<string, LocalSession> {
  const now = Date.now();
  if (foreignCache && now - foreignCache.at < FOREIGN_CACHE_TTL_MS) {
    return foreignCache.map;
  }
  const map = new Map<string, LocalSession>();
  for (const user of mappedForeignUsers()) {
    for (const raw of sessionRegistryForUserSync(user)) {
      const parsed = raw as { bridgeSessionId?: unknown; cwd?: unknown; name?: unknown; status?: unknown; pid?: unknown };
      const bsid = parsed.bridgeSessionId;
      const cwd = parsed.cwd;
      if (typeof bsid === 'string' && bsid && typeof cwd === 'string' && cwd) {
        map.set(sessionSuffix(bsid), {
          sessionId: bsid,
          cwd,
          name: typeof parsed.name === 'string' ? parsed.name : undefined,
          status: typeof parsed.status === 'string' ? parsed.status : undefined,
          pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
          owner: user,
        });
      }
    }
  }
  foreignCache = { at: now, map };
  return map;
}

/** The full local record for a relay session id, or null if not on this host. */
export function resolveLocalSession(sessionId: string): LocalSession | null {
  if (!sessionId) return null;
  return loadLocalSessions().get(sessionSuffix(sessionId)) ?? null;
}

/** The working directory of a relay session running on THIS host, or null. */
export function resolveLocalSessionCwd(sessionId: string): string | null {
  return resolveLocalSession(sessionId)?.cwd ?? null;
}
