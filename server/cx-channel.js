// cx-channel.js — dispatcher adapter for live Codex agent sessions.
//
// Sibling of oc-channel.js: same call shape, same frontend contract, different
// engine. Where oc-channel drives a tenant's `opencode serve` server, this
// adapter drives a tenant's `codex app-server` via
// server/remote-control/cx-client.js. Session ids are `cxs_<agent>_<threadId>`
// — the server root muxes between the adapters on that prefix, so the
// frontend stays byte-identical.

import {
  driveCxSession,
  attachCxSession,
  abortCxSession,
  resolveCxPermission,
  isActiveCxSession,
  isCxSessionId,
} from './remote-control/cx-client.js';
import { isAgentCaptureAllowed } from './services/rc.service.js';
import { landAttachments, fileReferralText } from './services/incoming-files.js';
import { createNormalizedMessage } from './shared/utils.js';

export { isCxSessionId };

export function isCxSession(sessionId) {
  return isCxSessionId(sessionId) || isActiveCxSession(sessionId);
}

/** Run one live-agent chat turn against the agent's codex app-server. */
export async function queryCxChannel(command, options, writer) {
  const opts = options || {};
  const sessionId = opts.remoteControl;
  if (!sessionId || !(await isAgentCaptureAllowed(sessionId))) {
    console.warn('[cx-channel] refused out-of-scope drive', { sessionId: sessionId || null });
    if (sessionId && writer) {
      writer.send(createNormalizedMessage({
        kind: 'error',
        content: 'Message not delivered: this server is not allowed to drive this agent.',
        sessionId,
        provider: 'codex',
      }));
      writer.send(createNormalizedMessage({ kind: 'complete', exitCode: 1, sessionId, provider: 'codex' }));
    }
    return;
  }
  // Attachments land as REAL FILES on the agent's host (registration file gives
  // owner + host) and the message refers the agent to the saved paths — same
  // model as claude/opencode agents. If landing fails, say so LOUDLY.
  let outCommand = command;
  const verified = Array.isArray(opts.attachments) ? opts.attachments : [];
  const legacyInline = (Array.isArray(opts.images) ? opts.images : []).filter(
    (att) => att && typeof att.data === 'string' && !att.path,
  );
  const landed = await landAttachments(sessionId, [...verified, ...legacyInline]);
  if (landed && landed.length > 0) {
    outCommand = [command || '', fileReferralText(landed)].filter(Boolean).join('\n\n');
  } else if ((verified.length > 0 || legacyInline.length > 0) && writer) {
    const n = verified.length + legacyInline.length;
    writer.send(createNormalizedMessage({
      kind: 'error',
      content: `Couldn't attach ${n === 1 ? 'the file' : `${n} files`} to this agent — the write to its host failed. Your message was sent without ${n === 1 ? 'it' : 'them'}.`,
      sessionId,
      provider: 'codex',
    }));
  }
  return driveCxSession({ ws: writer, sessionId, command: outCommand });
}

/** Read-only live mirror of an agent session (GUI opened the conversation). */
export async function subscribeCxChannel(sessionId, writer) {
  if (!sessionId || !(await isAgentCaptureAllowed(sessionId))) return;
  try {
    await attachCxSession(sessionId, writer);
  } catch {
    // server unreachable — history still renders from the MyMu-side cache;
    // the live mirror resumes on the next open or send.
  }
}

export { abortCxSession, resolveCxPermission };
