/**
 * Per-pane generation ENDPOINT registry — the systematic way to see and change
 * which backend produces each pane's data.
 *
 * Each of the 5 generated panes maps to one endpoint:
 *   { backend: 'a2a',    provider, skill, mode }              — a fleet agent over A2A
 *   { backend: 'openai', baseUrl, model, apiKeyEnv? }         — any OpenAI-compatible
 *     chat-completions server (LiteLLM router, OpenAI, etc.). The key is named by
 *     env var, NEVER stored in the config file.
 * Plus per-pane: { enabled, label }.
 *
 * Config lives OUTSIDE the repo (survives git ops) and is edited from the admin
 * page (/admin → PUT /api/bldr/admin/endpoints). Read fresh on every use, so
 * changes take effect without a restart.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { hasGrant } from './a2a.js';

export const ENDPOINTS_FILE =
  process.env.BLDR_ENDPOINTS_FILE ||
  path.join(os.homedir(), '.config', 'bti-webapp-ccui', 'bldr-endpoints.json');

export const PANE_IDS = ['top_view', 'section', 'elevations', 'front_view', 'costs'];

// The two backends we run today, offered as one-click presets in the admin UI.
export const PRESETS = [
  {
    id: 'gpt-a2a',
    label: 'GPT (bti-bldr-gpt via A2A)',
    endpoint: { backend: 'a2a', provider: 'bti-bldr-gpt', skill: 'general_query', mode: 'spawn' },
  },
  {
    id: 'gpt-a2a-image',
    label: 'GPT image render (bti-bldr-gpt generate_image)',
    endpoint: { backend: 'a2a', provider: 'bti-bldr-gpt', skill: 'generate_image', mode: 'exec' },
  },
  {
    id: 'google-flash',
    label: 'Google Flash (gemini-flash via LiteLLM)',
    endpoint: { backend: 'openai', baseUrl: 'http://10.10.0.2:19081/v1', model: 'gemini-flash' },
  },
];

// Default chain: GPT for all panes — the four drawing panes through the IMAGE
// endpoint (real rendered drawings, not text-drawn SVG); costs runs on Google
// Flash (fast, cheap, text/JSON — the pane best suited to it).
const DEFAULTS = {
  version: 1,
  endpoints: {
    top_view: { backend: 'a2a', provider: 'bti-bldr-gpt', skill: 'generate_image', mode: 'exec', enabled: true, label: 'GPT render (A2A)' },
    section: { backend: 'a2a', provider: 'bti-bldr-gpt', skill: 'generate_image', mode: 'exec', enabled: true, label: 'GPT render (A2A)' },
    elevations: { backend: 'a2a', provider: 'bti-bldr-gpt', skill: 'generate_image', mode: 'exec', enabled: true, label: 'GPT render (A2A)' },
    front_view: { backend: 'a2a', provider: 'bti-bldr-gpt', skill: 'generate_image', mode: 'exec', enabled: true, label: 'GPT render (A2A)' },
    costs: { backend: 'openai', baseUrl: 'http://10.10.0.2:19081/v1', model: 'gemini-flash', enabled: true, label: 'Google Flash' },
  },
};

function sanitizeEndpoint(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const enabled = raw.enabled !== false;
  const label = typeof raw.label === 'string' ? raw.label.slice(0, 80) : '';
  if (raw.backend === 'a2a') {
    if (typeof raw.provider !== 'string' || !raw.provider) return null;
    const skill = typeof raw.skill === 'string' && raw.skill ? raw.skill : 'general_query';
    const mode = ['spawn', 'inject', 'exec'].includes(raw.mode) ? raw.mode : 'spawn';
    return { backend: 'a2a', provider: raw.provider, skill, mode, enabled, label };
  }
  if (raw.backend === 'openai') {
    if (typeof raw.baseUrl !== 'string' || !/^https?:\/\//.test(raw.baseUrl)) return null;
    if (typeof raw.model !== 'string' || !raw.model) return null;
    const out = { backend: 'openai', baseUrl: raw.baseUrl.replace(/\/$/, ''), model: raw.model, enabled, label };
    // Key by env-var NAME only — the value never touches the config file.
    if (typeof raw.apiKeyEnv === 'string' && /^[A-Z0-9_]{1,64}$/.test(raw.apiKeyEnv)) out.apiKeyEnv = raw.apiKeyEnv;
    return out;
  }
  return null;
}

/** Read the registry (defaults merged in; file created on first read). */
export function loadEndpoints() {
  let stored = null;
  try {
    stored = JSON.parse(fs.readFileSync(ENDPOINTS_FILE, 'utf8'));
  } catch {
    /* absent or corrupt → defaults */
  }
  const endpoints = {};
  for (const id of PANE_IDS) {
    endpoints[id] = sanitizeEndpoint(stored?.endpoints?.[id]) || { ...DEFAULTS.endpoints[id] };
  }
  const cfg = { version: 1, endpoints };
  if (!stored) {
    try { saveEndpoints(cfg); } catch { /* read-only fs — run on in-memory defaults */ }
  }
  return cfg;
}

/** Validate + persist a full or partial registry. Returns the stored config. */
export function saveEndpoints(next) {
  const current = fs.existsSync(ENDPOINTS_FILE) ? loadEndpoints() : { version: 1, endpoints: { ...DEFAULTS.endpoints } };
  const endpoints = {};
  for (const id of PANE_IDS) {
    const candidate = next?.endpoints?.[id];
    endpoints[id] = (candidate ? sanitizeEndpoint(candidate) : null) || current.endpoints[id] || { ...DEFAULTS.endpoints[id] };
  }
  const cfg = { version: 1, endpoints };
  fs.mkdirSync(path.dirname(ENDPOINTS_FILE), { recursive: true });
  fs.writeFileSync(ENDPOINTS_FILE, JSON.stringify(cfg, null, 2));
  return cfg;
}

/** Can this endpoint be called right now? Returns { ok, reason? }. */
export function endpointAvailability(ep) {
  if (!ep) return { ok: false, reason: 'not configured' };
  if (ep.enabled === false) return { ok: false, reason: 'disabled' };
  if (ep.backend === 'a2a') {
    return hasGrant(ep.provider, ep.skill)
      ? { ok: true }
      : { ok: false, reason: `no A2A grant for ${ep.provider}/${ep.skill}` };
  }
  if (ep.backend === 'openai') {
    if (ep.apiKeyEnv && !process.env[ep.apiKeyEnv]) return { ok: false, reason: `env ${ep.apiKeyEnv} not set` };
    return { ok: true };
  }
  return { ok: false, reason: 'unknown backend' };
}
