/**
 * Minimal outbound A2A client for the bldr server (Route B).
 *
 * Lets THIS app call another fleet agent (e.g. bti-bldr-gpt) to produce pane
 * values, using the same JSON-RPC `tasks/send` transport and the same
 * credentials file the agent's a2a_call MCP tool uses. Grants are read fresh on
 * every call, so adding a grant takes effect with no restart.
 *
 * Credentials file shape (per provider):
 *   { "<provider>": { url, token, allowed_skills:[...], allowed_modes:[...] } }
 *
 * The token is a secret — it is read and sent as a Bearer header, never logged.
 */
import fs from 'fs';

const CREDS_FILE =
  process.env.A2A_CREDS_FILE || '/home/bti/kaxtus-agents/bti-webapp/a2a-credentials.json';

export class A2AError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'A2AError';
    this.code = code;
  }
}

/** Read the grant entry for a provider, or null if the file/grant is absent. */
export function loadGrant(provider) {
  try {
    const data = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    return data?.[provider] || null;
  } catch {
    return null;
  }
}

/** True if this app currently holds a usable grant for `provider`+`skill`. */
export function hasGrant(provider, skill = 'general_query') {
  const e = loadGrant(provider);
  return !!(e && (e.allowed_skills || []).includes(skill));
}

/**
 * Make an A2A call and return the provider's reply text (the first artifact's
 * concatenated text parts). Throws A2AError on any failure (no grant, transport,
 * non-completed task).
 */
export async function a2aCall({
  provider,
  skill = 'general_query',
  message,
  mode = 'spawn',
  params = {},
  timeoutMs = 180000,
}) {
  const entry = loadGrant(provider);
  if (!entry) {
    throw new A2AError(`No A2A grant for provider '${provider}'.`, 'NO_GRANT');
  }
  if (!(entry.allowed_skills || []).includes(skill)) {
    throw new A2AError(`Skill '${skill}' not granted on '${provider}'.`, 'SKILL_NOT_GRANTED');
  }
  if (!(entry.allowed_modes || ['spawn']).includes(mode)) {
    throw new A2AError(`Mode '${mode}' not allowed for '${provider}'.`, 'MODE_NOT_ALLOWED');
  }
  if (mode !== 'exec' && !message) {
    throw new A2AError('message is required (except in exec mode).', 'MESSAGE_REQUIRED');
  }

  const payload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tasks/send',
    params: {
      id: `${skill}-${Math.floor(performance.now())}-${Math.round(Math.random() * 1e6)}`,
      message: { role: 'user', parts: [{ text: message || '' }] },
      metadata: { mode, skill, ...(params && Object.keys(params).length ? { skill_params: params } : {}) },
    },
  };
  const url = String(entry.url).replace(/\/$/, '') + '/';

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${entry.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new A2AError(`Provider '${provider}' unreachable: ${err?.message || err}`, 'UNREACHABLE');
  }
  if (!res.ok) {
    throw new A2AError(`Provider '${provider}' returned HTTP ${res.status}.`, 'HTTP_ERROR');
  }

  const body = await res.json().catch(() => null);
  if (!body) throw new A2AError(`Provider '${provider}' returned non-JSON.`, 'BAD_RESPONSE');
  if (body.error) throw new A2AError(`Provider '${provider}' error: ${JSON.stringify(body.error)}`, 'PROVIDER_ERROR');

  const result = body.result || {};
  const state = result.status?.state;
  if (state !== 'completed') {
    throw new A2AError(`Provider '${provider}' task ended in state '${state}'.`, 'NOT_COMPLETED');
  }
  const parts = result.artifacts?.[0]?.parts || [];
  return parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text || '')
    .join('\n')
    .trim();
}
