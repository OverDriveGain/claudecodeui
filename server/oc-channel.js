// oc-channel.js — dispatcher adapter for live OpenCode agent sessions.
//
// Sibling of rc-channel.js: same call shape, same frontend contract, different
// engine. Where rc-channel drives Anthropic's cloud relay, this adapter drives
// a tenant's own `opencode serve` server via server/remote-control/oc-client.js.
// Session ids are `ocs_<agent>_<ses_…>` — the server root muxes between the two
// adapters on that prefix, so the frontend stays byte-identical.

import {
  driveOcSession,
  attachOcSession,
  abortOcSession,
  resolveOcPermission,
  isActiveOcSession,
  emitOutstandingOcPermission,
  isOcSessionId,
} from './remote-control/oc-client.js';
import { isAgentCaptureAllowed } from './services/rc.service.js';
import { landAttachments, fileReferralText } from './services/incoming-files.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerRegistry } from './modules/providers/provider.registry.js';
import { createNormalizedMessage } from './shared/utils.js';

// Live SSE frames arrive as one { info, part } pair; render them through the
// SAME normalizer local OpenCode sessions use (normalizeApiMessages), so a live
// agent and a local opencode conversation are visually indistinguishable.
const normalizeOpenCode = (rawFrame, sessionId) => {
  const provider = providerRegistry.resolveProvider('opencode').sessions;
  const info = rawFrame?.info;
  const part = rawFrame?.part;
  return provider.normalizeApiMessages(
    [{ info: info ?? { id: part?.messageID ?? 'msg_live', role: 'assistant' }, parts: part ? [part] : [] }],
    sessionId,
  );
};

export { isOcSessionId };

export function isOcSession(sessionId) {
  return isOcSessionId(sessionId) || isActiveOcSession(sessionId);
}

/** A composer pick counts only when the user chose something concrete —
 *  'default'/empty means "leave the agent's own setting alone". */
const pickOption = (value) =>
  typeof value === 'string' && value.trim() && value.trim() !== 'default' ? value.trim() : null;

/** Run one live-agent chat turn against the agent's opencode server. */
export async function queryOcChannel(command, options, writer) {
  const opts = options || {};
  const sessionId = opts.remoteControl;
  if (!sessionId || !(await isAgentCaptureAllowed(sessionId))) {
    console.warn('[oc-channel] refused out-of-scope drive', { sessionId: sessionId || null });
    if (sessionId && writer) {
      writer.send(createNormalizedMessage({
        kind: 'error',
        content: 'Message not delivered: this server is not allowed to drive this agent.',
        sessionId,
        provider: 'opencode',
      }));
      writer.send(createNormalizedMessage({ kind: 'complete', exitCode: 1, sessionId, provider: 'opencode' }));
    }
    return;
  }
  // Attachments land as REAL FILES on the agent's host (registration file gives
  // owner + host) and the message refers the agent to the saved paths — same
  // model as claude agents. If landing fails, say so LOUDLY; the text still goes.
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
      provider: 'opencode',
    }));
  }
  return driveOcSession({
    ws: writer,
    sessionId,
    command: outCommand,
    normalize: normalizeOpenCode,
    // Composer picks → prompt_async body (model:{providerID,modelID}, variant).
    model: pickOption(opts.model),
    effort: pickOption(opts.effort),
  });
}

/** Read-only live mirror of an agent session (GUI opened the conversation). */
export async function subscribeOcChannel(sessionId, writer) {
  if (!sessionId || !(await isAgentCaptureAllowed(sessionId))) return;
  try {
    await attachOcSession(sessionId, writer, normalizeOpenCode);
    await emitOutstandingOcPermission(sessionId, writer);
  } catch {
    // server unreachable — history still renders from the MyMu-side cache;
    // the live mirror resumes on the next open or send.
  }
}

export { abortOcSession, resolveOcPermission };
