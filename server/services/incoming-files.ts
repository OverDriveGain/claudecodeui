// incoming-files.ts — land composer attachments on the AGENT'S host as real files.
//
// The old path folded attachments into the relay message as content blocks
// (base64 image/document blocks, decoded text). That capped what could be sent
// (arbitrary binaries unsupported) and put files in the agent's *context*, not
// on its disk. The product decision (Manar, 2026-07-25) is the opposite: an
// uploaded file LANDS somewhere on the host the agent runs on, and the message
// just REFERS the agent to that path — the agent reads it from disk like any
// other file (Claude Code reads images/PDFs natively).
//
// Landing is LOCAL-HOST ONLY (cross-host landing was built 2026-07-25 and
// reverted the same day — Manar wants a different cross-host paradigm, TBD):
//   - session on THIS host (per ~/.claude/sessions) → write locally
//   - anything else → null; the caller falls back to the old content-block
//     embedding so cross-host sends keep working meanwhile.
//
// Writes are jailed to a fixed per-session uploads dir under the CCUI user's
// home — the caller never controls the directory, only a sanitized basename.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveLocalSession } from './local-sessions.js';
import { writeFileAsUser } from './user-fs.js';

/** Per-file cap. Attachments travel base64 over the chat WS; keep it sane. */
export const MAX_INCOMING_FILE_BYTES = 64 * 1024 * 1024;

export interface LandedFile {
  name: string;
  path: string; // absolute path ON THE AGENT'S HOST
}

export interface IncomingAttachment {
  name?: string;
  data?: string; // data:<mime>;base64,<b64> (upload-images shape)
}

/** Relay ids share a suffix across `session_`/`cse_` prefixes — stable dir key. */
function sessionSuffix(id: string): string {
  const underscore = id.indexOf('_');
  return underscore >= 0 ? id.slice(underscore + 1) : id;
}

/** Keep the extension, drop directories and anything shell/path-hostile. */
function sanitizeName(name: string): string {
  const base = path.basename(name || 'file').replace(/[^\w.\-()+ ]+/g, '_').trim();
  return base.length > 0 && base !== '.' && base !== '..' ? base.slice(0, 128) : 'file';
}

function uploadsDirFor(sessionId: string): string {
  return path.join(os.homedir(), '.claudecodeui', 'uploads', sessionSuffix(sessionId));
}

/**
 * Write one attachment's bytes into this host's uploads dir for the session.
 * Collision-suffixes rather than overwriting (two sends of "photo.jpg" must not
 * clobber a file the agent may still be reading). Returns the absolute path.
 */
export async function saveIncomingFile(sessionId: string, name: string, buffer: Buffer): Promise<string> {
  if (buffer.length > MAX_INCOMING_FILE_BYTES) {
    throw new Error(`File too large (${buffer.length} bytes; max ${MAX_INCOMING_FILE_BYTES})`);
  }
  const dir = uploadsDirFor(sessionId);
  await fs.mkdir(dir, { recursive: true });
  const safe = sanitizeName(name);
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  let target = path.join(dir, safe);
  for (let i = 2; ; i++) {
    try {
      await fs.writeFile(target, buffer, { flag: 'wx' }); // fail if exists
      return target;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      target = path.join(dir, `${stem}-${i}${ext}`);
    }
  }
}

function decodeDataUrl(att: IncomingAttachment): { name: string; buffer: Buffer } | null {
  const m = /^data:[^;]*;base64,(.+)$/.exec(att?.data || '');
  if (!m) return null;
  try {
    return { name: att?.name || 'file', buffer: Buffer.from(m[1], 'base64') };
  } catch {
    return null;
  }
}

/**
 * Land every attachment on the session's host and return the landed paths, or
 * null when landing isn't possible (unknown host / a write failed) — all or
 * nothing, so the caller either refers the agent to complete files or falls
 * back to embedding for the whole batch. Never throws.
 */
export async function landAttachments(
  sessionId: string,
  attachments: IncomingAttachment[] | undefined,
): Promise<LandedFile[] | null> {
  const list = Array.isArray(attachments) ? attachments : [];
  const decoded = list.map(decodeDataUrl).filter((d): d is { name: string; buffer: Buffer } => d !== null);
  if (decoded.length === 0) return null;

  try {
    // Same host only: write straight to disk. A session owned elsewhere returns
    // null and the caller embeds content blocks instead (cross-host paradigm TBD).
    const local = resolveLocalSession(sessionId);
    if (local) {
      // One-instance-per-host: an agent run by a mapped FOREIGN linux user gets
      // the file in ITS home (written as that user), so the referred path is
      // readable by the agent process.
      if (local.owner) {
        const dir = path.join('/home', local.owner, '.claudecodeui', 'uploads', sessionSuffix(sessionId));
        const out: LandedFile[] = [];
        for (const d of decoded) {
          if (d.buffer.length > MAX_INCOMING_FILE_BYTES) return null;
          out.push({ name: d.name, path: await writeFileAsUser(local.owner, dir, sanitizeName(d.name), d.buffer) });
        }
        return out;
      }
      const out: LandedFile[] = [];
      for (const d of decoded) {
        out.push({ name: d.name, path: await saveIncomingFile(sessionId, d.name, d.buffer) });
      }
      return out;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The referral appended to the user's message in place of embedded content:
 * plain absolute paths the agent can Read directly.
 */
export function fileReferralText(landed: LandedFile[]): string {
  const lines = landed.map((f) => `- ${f.path}`).join('\n');
  return `[The user attached ${landed.length === 1 ? 'a file' : `${landed.length} files`} — saved on this machine, read from disk:]\n${lines}`;
}
