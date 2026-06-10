/**
 * Remote-Control client — a PROXY to Anthropic's CCR v2 relay (their "bridge").
 *
 * This module lets claudecodeui act as a *driver* of `claude --remote-control`
 * agents, exactly the role the claude.ai/code website plays. It does NOT host any
 * relay of its own: it just talks to Anthropic's cloud over the operator's own
 * OAuth, lists the live agents, and (later) streams/sends to them. Pure middleman.
 *
 * "remote-control" is named after the CLI flag the agent is launched with, so the
 * naming says what it is — not "bridge" (that is Anthropic's word for THEIR relay).
 *
 * This file holds the READ side only (auth + asking the server for things):
 *   - getRemoteAuth / isRemoteControlConfigured  — operator OAuth + org uuid
 *   - listConnectedAgents()                      — the live `--remote-control` fleet
 *   - getSessionEvents()                         — a session's full history
 * The drive side (attach WS, send, permissions, stop) is added in a later step.
 *
 * Anthropic endpoints used here (all against api.anthropic.com):
 *   GET /v1/code/sessions                  the connected interactive agent sessions
 *   GET /v1/sessions/{id}/events           a session's event history (paginated)
 */

import { readFileSync } from 'fs';
import os from 'os';

const BASE = process.env.RC_BASE_URL || 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
// Anthropic's beta tag for the remote-control session/event API.
const BETA_CCR = 'ccr-byoc-2025-07-29';

/**
 * Read the operator's claude.ai OAuth token + org uuid. These are the SAME
 * credentials the claude.ai/code website uses to prove it may drive your agents.
 * Env overrides win so a deployment can inject them without the dotfiles.
 *   RC_OAUTH_TOKEN  overrides ~/.claude/.credentials.json → claudeAiOauth.accessToken
 *   RC_ORG_UUID     overrides ~/.claude.json            → oauthAccount.organizationUuid
 */
export function getRemoteAuth() {
  const token =
    process.env.RC_OAUTH_TOKEN ||
    (() => {
      try {
        return JSON.parse(readFileSync(`${os.homedir()}/.claude/.credentials.json`, 'utf8'))
          .claudeAiOauth?.accessToken;
      } catch {
        return undefined;
      }
    })();
  const orgUuid =
    process.env.RC_ORG_UUID ||
    (() => {
      try {
        return JSON.parse(readFileSync(`${os.homedir()}/.claude.json`, 'utf8'))
          .oauthAccount?.organizationUuid;
      } catch {
        return undefined;
      }
    })();
  return { token, orgUuid };
}

/** Build request headers for the Anthropic API. */
function headers({ beta, org } = {}) {
  const { token, orgUuid } = getRemoteAuth();
  const h = {
    Authorization: `Bearer ${token}`,
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
  };
  if (beta) h['anthropic-beta'] = beta;
  if (org) h['x-organization-uuid'] = orgUuid;
  return h;
}

/** True when a usable OAuth token + org uuid are present (else the proxy is off). */
export function isRemoteControlConfigured() {
  const { token, orgUuid } = getRemoteAuth();
  return Boolean(token && orgUuid);
}

/**
 * Ask Anthropic for the CONNECTED interactive agent sessions — every live
 * `claude --remote-control` session (your fleet) currently attached to the relay.
 * These appear as `cse_*` code sessions with connection_status='connected' and no
 * environment_id; each is directly driveable (attach + send to the existing one).
 */
export async function listConnectedAgents() {
  const r = await fetch(`${BASE}/v1/code/sessions`, { headers: headers() });
  if (!r.ok) throw new Error(`listConnectedAgents ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return (j.data || [])
    .filter((s) => s.connection_status === 'connected' && !s.environment_id)
    .map((s) => ({
      id: s.id,
      title: (s.title || '').split('\n')[0].trim(),
      createdAt: s.created_at,
    }));
}

/**
 * Fetch a session's full event history (raw SDK transcript records). Same record
 * shape as a local JSONL transcript ({type, message, uuid, …}) so the caller can
 * normalize them with the standard normalizeMessage path. Returns [] on error.
 *
 * The events API returns a page at a time (oldest-first) with has_more + last_id;
 * we page forward via after_id so the GUI gets the WHOLE conversation, not page 1.
 */
export async function getSessionEvents(sessionId, { maxPages = 60 } = {}) {
  const all = [];
  let after = null;
  for (let i = 0; i < maxPages; i++) {
    const url = `${BASE}/v1/sessions/${sessionId}/events?limit=100`
      + (after ? `&after_id=${encodeURIComponent(after)}` : '');
    const r = await fetch(url, { headers: headers({ beta: BETA_CCR, org: true }) });
    if (!r.ok) break;
    const j = await r.json();
    const batch = Array.isArray(j.data) ? j.data : [];
    all.push(...batch);
    if (!j.has_more || !batch.length || !j.last_id) break;
    after = j.last_id;
  }
  return all;
}
