import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../utils/api';

/**
 * BLDR admin — the pane→endpoint chain, systematically.
 *
 * Each generated pane (Top view / Section / Elevations / Front view / Costs)
 * is produced by one configurable endpoint: a fleet agent over A2A (GPT) or any
 * OpenAI-compatible model server (Google Flash via the LiteLLM router, …).
 * This page shows the whole chain, lets an admin re-point any pane (preset or
 * custom), and test-runs a single pane end-to-end. Changes apply to the next
 * generation — no restart.
 */

type Endpoint = {
  backend: 'a2a' | 'openai';
  provider?: string;
  skill?: string;
  mode?: string;
  baseUrl?: string;
  model?: string;
  apiKeyEnv?: string;
  enabled?: boolean;
  label?: string;
};

type Preset = { id: string; label: string; endpoint: Endpoint };
type Availability = { ok: boolean; reason?: string };

// Same sheet names/codes the app panes show — one drawing set, one language.
const PANE_NAMES: Record<string, string> = {
  top_view: 'Floor plan · A-101',
  section: 'Section · A-201',
  elevations: 'Elevations · A-301',
  front_view: 'Exterior render · R-401',
  costs: 'Cost estimate · C-501',
};

type TraceEntry = {
  state?: string;
  endpoint?: string;
  startedAt?: number;
  finishedAt?: number;
  ms?: number;
  error?: string;
  prompt?: string;
  reply?: string;
};

type JobInfo = {
  workspace: string;
  running: boolean;
  brief: string;
  panes: Record<string, string>;
  trace?: Record<string, TraceEntry>;
  endpoints?: Record<string, string>;
  startedAt: number;
  finishedAt: number | null;
};

const fmtDur = (ms?: number) => (ms == null ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`);
const fmtTime = (t?: number | null) => (t ? new Date(t).toLocaleTimeString() : '');

const STATE_BADGE: Record<string, string> = {
  pending: 'text-muted-foreground',
  working: 'text-amber-500',
  done: 'text-green-500',
  failed: 'text-red-500',
  skipped: 'text-muted-foreground',
};

type ArchitectCfg = { persona: string; knowledge: string; greeting: string };

const ARCHITECT_FIELDS: { key: keyof ArchitectCfg; label: string; hint: string }[] = [
  {
    key: 'persona',
    label: 'Persona — who the AI Architect is',
    hint: 'Identity, voice, forbidden vocabulary. The customer-facing character.',
  },
  {
    key: 'knowledge',
    label: 'BTI knowledge — what it knows about the company',
    hint: 'Company facts, rates, reference projects it may relate briefs to. Later fed by mnemosyne; curated here until then.',
  },
  {
    key: 'greeting',
    label: 'First contact — how it opens the conversation',
    hint: 'The greeting protocol: introduce, brief the saved selections back, relate to a reference project, make details optional.',
  },
];

/** Admin editor for the AI Architect briefing (injected every customer turn). */
function ArchitectSection() {
  const [cfg, setCfg] = useState<ArchitectCfg | null>(null);
  const [defaults, setDefaults] = useState<ArchitectCfg | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.bldr.admin.architect();
        if (!res.ok) return;
        const data = await res.json();
        setCfg(data.architect);
        setDefaults(data.defaults);
      } catch {
        /* section stays hidden */
      }
    })();
  }, []);

  if (!cfg) return null;

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.bldr.admin.saveArchitect(cfg);
      const data = res.ok ? await res.json() : null;
      if (data?.ok) {
        setCfg(data.architect);
        setDirty(false);
        setNotice('Saved — applies to each customer’s next chat message.');
      } else {
        setNotice('Save failed.');
      }
    } catch {
      setNotice('Save failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mb-8">
      <h2 className="mb-1 text-base font-semibold">AI Architect</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        Who the customer-facing assistant is: persona, BTI knowledge, and how it opens the chat. Injected into every
        customer message (with their saved form selections), so edits apply immediately — no restart. The chat brain is
        the bldr assistant; the drawing/costs endpoints are configured per pane below.
      </p>
      <button onClick={() => setOpen((v) => !v)} className="mb-2 text-sm text-muted-foreground underline-offset-2 hover:underline">
        {open ? '▾ Hide editor' : '▸ Edit persona, knowledge & greeting'}
      </button>
      {open && (
        <div className="space-y-4 rounded-lg border border-border bg-card p-4">
          {ARCHITECT_FIELDS.map(({ key, label, hint }) => (
            <label key={key} className="block text-sm">
              <span className="font-medium">{label}</span>
              <span className="block text-xs text-muted-foreground">{hint}</span>
              <textarea
                value={cfg[key]}
                onChange={(e) => {
                  setCfg({ ...cfg, [key]: e.target.value });
                  setDirty(true);
                  setNotice('');
                }}
                rows={8}
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs"
              />
            </label>
          ))}
          <div className="flex items-center gap-3">
            <button
              onClick={save}
              disabled={!dirty || saving}
              className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save AI Architect'}
            </button>
            {defaults && (
              <button
                onClick={() => {
                  setCfg(defaults);
                  setDirty(true);
                  setNotice('Defaults loaded — Save to apply.');
                }}
                className="rounded-md border border-border px-3 py-2 text-sm hover:bg-accent"
              >
                Reset to defaults
              </button>
            )}
            {notice && <span className="text-sm text-muted-foreground">{notice}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/** One generation run — per-pane state, endpoint, timing, and error text. */
function JobCard({ job, now }: { job: JobInfo; now: number }) {
  const elapsed = (job.finishedAt ?? now) - job.startedAt;
  const states = Object.values(job.panes);
  const done = states.filter((s) => s === 'done').length;
  const failed = states.filter((s) => s === 'failed' || s === 'skipped').length;
  return (
    <div className="rounded-lg border border-border bg-card p-3 text-sm">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {job.running && (
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        )}
        <span className="font-mono text-xs text-muted-foreground">{job.workspace}</span>
        <span className="truncate font-medium" title={job.brief}>
          {job.brief || '(no brief)'}
        </span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {fmtTime(job.startedAt)} · {fmtDur(elapsed)} ·{' '}
          {job.running ? `${done}/${states.length} done` : failed ? `${done}/${states.length} done, ${failed} failed` : 'completed'}
        </span>
      </div>
      <div className="space-y-1">
        {Object.entries(job.panes).map(([id, state]) => {
          const t = job.trace?.[id] ?? {};
          const running = state === 'working';
          const dur = running && t.startedAt ? now - t.startedAt : t.ms;
          return (
            <div key={id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
              <span className="w-40 shrink-0">{PANE_NAMES[id] || id}</span>
              <span className={`w-16 shrink-0 font-semibold ${STATE_BADGE[state] || ''}`}>{state}</span>
              <span className="w-14 shrink-0 tabular-nums text-muted-foreground">{fmtDur(dur)}</span>
              <span className="truncate text-muted-foreground">{t.endpoint || job.endpoints?.[id] || ''}</span>
              {t.error && <span className="basis-full pl-40 text-red-500">↳ {t.error}</span>}
              {(t.prompt || t.reply) && (
                <details className="basis-full pl-40 text-muted-foreground">
                  <summary className="cursor-pointer select-none">prompt & reply</summary>
                  {t.prompt && (
                    <div className="mt-1 whitespace-pre-wrap break-words border-l-2 border-border pl-2">→ {t.prompt}</div>
                  )}
                  {t.reply && (
                    <div className="mt-1 whitespace-pre-wrap break-words border-l-2 border-border pl-2">← {t.reply}</div>
                  )}
                </details>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const sameEndpoint = (a: Endpoint, b: Endpoint) =>
  a.backend === b.backend &&
  (a.backend === 'a2a'
    ? a.provider === b.provider && a.skill === b.skill && a.mode === b.mode
    : a.baseUrl === b.baseUrl && a.model === b.model);

const describe = (ep: Endpoint) =>
  ep.label || (ep.backend === 'a2a' ? `${ep.provider}/${ep.skill}` : `${ep.model}`);

export default function AdminPage() {
  const [admin, setAdmin] = useState<boolean | null>(null);
  const [panes, setPanes] = useState<string[]>([]);
  const [endpoints, setEndpoints] = useState<Record<string, Endpoint>>({});
  const [availability, setAvailability] = useState<Record<string, Availability>>({});
  const [presets, setPresets] = useState<Preset[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [job, setJob] = useState<any>(null);
  const [activity, setActivity] = useState<{ active: JobInfo[]; recent: JobInfo[] }>({ active: [], recent: [] });
  const [showRecent, setShowRecent] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Live activity: what's generating right now (all visitors) + recent runs.
  useEffect(() => {
    if (!admin) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await api.bldr.admin.jobs();
        if (!res.ok || cancelled) return;
        setActivity(await res.json());
        setNow(Date.now());
      } catch {
        /* transient */
      }
    };
    void tick();
    const interval = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [admin]);

  const load = useCallback(async () => {
    const meRes = await api.bldr.admin.me();
    const me = meRes.ok ? await meRes.json() : { admin: false };
    setAdmin(Boolean(me.admin));
    if (!me.admin) return;
    const res = await api.bldr.admin.endpoints();
    if (!res.ok) return;
    const data = await res.json();
    setPanes(data.panes || []);
    setEndpoints(data.endpoints || {});
    setAvailability(data.availability || {});
    setPresets(data.presets || []);
  }, []);

  useEffect(() => {
    load().catch(() => setAdmin(false));
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [load]);

  const update = (pane: string, patch: Partial<Endpoint>) => {
    setEndpoints((prev) => ({ ...prev, [pane]: { ...prev[pane], ...patch } }));
    setDirty(true);
    setNotice('');
  };

  const applyPreset = (pane: string, presetId: string) => {
    const preset = presets.find((p) => p.id === presetId);
    if (!preset) return;
    setEndpoints((prev) => ({
      ...prev,
      [pane]: { ...preset.endpoint, enabled: prev[pane]?.enabled !== false, label: preset.label },
    }));
    setDirty(true);
    setNotice('');
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.bldr.admin.saveEndpoints(endpoints);
      const data = res.ok ? await res.json() : null;
      if (data?.ok) {
        setEndpoints(data.endpoints);
        setAvailability(data.availability || {});
        setDirty(false);
        setNotice('Saved — applies to the next generation.');
      } else {
        setNotice('Save failed.');
      }
    } catch {
      setNotice('Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const startPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res = await api.bldr.generateJob();
        const j = res.ok ? await res.json() : null;
        setJob(j);
        if (j && !j.running && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } catch {
        /* keep polling */
      }
    }, 3000);
  };

  const testPane = async (pane: string) => {
    setNotice(dirty ? 'Testing the SAVED chain (unsaved edits not included).' : '');
    const res = await api.bldr.generate('', [pane]);
    if (res.ok) {
      setJob((await res.json()).job);
      startPolling();
    } else {
      setNotice('Test failed to start.');
    }
  };

  if (admin === null) {
    return <div className="flex h-full items-center justify-center text-muted-foreground">Loading…</div>;
  }
  if (!admin) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <div className="text-lg font-semibold">Admin only</div>
        <Link to="/" className="text-primary underline">Back to BLDR</Link>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">BLDR admin — pane endpoints</h1>
            <p className="text-sm text-muted-foreground">
              Who generates each pane. Change an endpoint, save, and the next generation uses it.
            </p>
          </div>
          <Link to="/" className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent">
            ← App
          </Link>
        </div>

        <div className="mb-8">
          <h2 className="mb-1 text-base font-semibold">Live activity</h2>
          <p className="mb-3 text-sm text-muted-foreground">
            Every generation across all visitors — per pane: state, endpoint, duration, and the error when one fails.
            Updates every 3s.
          </p>
          {activity.active.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
              Nothing generating right now.
            </div>
          ) : (
            <div className="space-y-3">
              {activity.active.map((j) => (
                <JobCard key={`${j.workspace}-${j.startedAt}`} job={j} now={now} />
              ))}
            </div>
          )}
          {activity.recent.length > 0 && (
            <div className="mt-3">
              <button
                onClick={() => setShowRecent((v) => !v)}
                className="text-sm text-muted-foreground underline-offset-2 hover:underline"
              >
                {showRecent ? '▾' : '▸'} Recent runs ({activity.recent.length}, since last restart)
              </button>
              {showRecent && (
                <div className="mt-2 space-y-3">
                  {activity.recent.map((j) => (
                    <JobCard key={`${j.workspace}-${j.startedAt}`} job={j} now={now} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <ArchitectSection />

        <h2 className="mb-3 text-base font-semibold">Pane endpoints</h2>
        <div className="space-y-4">
          {panes.map((pane) => {
            const ep = endpoints[pane];
            if (!ep) return null;
            const avail = availability[pane];
            const presetId = presets.find((p) => sameEndpoint(p.endpoint, ep))?.id || 'custom';
            const paneJob = job?.panes?.[pane];
            return (
              <div key={pane} className="rounded-lg border border-border bg-card p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="font-semibold">{PANE_NAMES[pane] || pane}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        avail?.ok ? 'bg-green-500/15 text-green-500' : 'bg-red-500/15 text-red-500'
                      }`}
                      title={avail?.reason || ''}
                    >
                      {avail?.ok ? 'reachable' : avail?.reason || 'unavailable'}
                    </span>
                    {paneJob && (
                      <span className="text-xs text-muted-foreground">
                        test: {paneJob}
                        {job?.endpoints?.[pane] ? ` · via ${job.endpoints[pane]}` : ''}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={ep.enabled !== false}
                        onChange={(e) => update(pane, { enabled: e.target.checked })}
                      />
                      enabled
                    </label>
                    <button
                      onClick={() => testPane(pane)}
                      disabled={Boolean(job?.running)}
                      className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-50"
                    >
                      Test
                    </button>
                  </div>
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="text-xs text-muted-foreground">
                    Endpoint
                    <select
                      className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                      value={presetId}
                      onChange={(e) => e.target.value !== 'custom' && applyPreset(pane, e.target.value)}
                    >
                      {presets.map((p) => (
                        <option key={p.id} value={p.id}>{p.label}</option>
                      ))}
                      <option value="custom">Custom…</option>
                    </select>
                  </label>
                  <div className="text-xs text-muted-foreground">
                    Now
                    <div className="mt-1 rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm">
                      {describe(ep)}
                    </div>
                  </div>

                  {presetId === 'custom' && (
                    <>
                      <label className="text-xs text-muted-foreground">
                        Backend
                        <select
                          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                          value={ep.backend}
                          onChange={(e) =>
                            update(
                              pane,
                              e.target.value === 'a2a'
                                ? { backend: 'a2a', provider: ep.provider || 'bti-bldr-gpt', skill: ep.skill || 'general_query', mode: ep.mode || 'spawn', label: '' }
                                : { backend: 'openai', baseUrl: ep.baseUrl || 'http://10.10.0.2:19081/v1', model: ep.model || 'gemini-flash', label: '' }
                            )
                          }
                        >
                          <option value="a2a">Fleet agent (A2A)</option>
                          <option value="openai">OpenAI-compatible model</option>
                        </select>
                      </label>
                      {ep.backend === 'a2a' ? (
                        <>
                          <label className="text-xs text-muted-foreground">
                            Provider
                            <input
                              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                              value={ep.provider || ''}
                              onChange={(e) => update(pane, { provider: e.target.value, label: '' })}
                            />
                          </label>
                          <label className="text-xs text-muted-foreground">
                            Skill
                            <input
                              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                              value={ep.skill || ''}
                              onChange={(e) => update(pane, { skill: e.target.value, label: '' })}
                            />
                          </label>
                          <label className="text-xs text-muted-foreground">
                            Mode
                            <select
                              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                              value={ep.mode || 'spawn'}
                              onChange={(e) => update(pane, { mode: e.target.value, label: '' })}
                            >
                              <option value="spawn">spawn</option>
                              <option value="exec">exec</option>
                              <option value="inject">inject</option>
                            </select>
                          </label>
                        </>
                      ) : (
                        <>
                          <label className="text-xs text-muted-foreground">
                            Base URL
                            <input
                              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                              value={ep.baseUrl || ''}
                              onChange={(e) => update(pane, { baseUrl: e.target.value, label: '' })}
                            />
                          </label>
                          <label className="text-xs text-muted-foreground">
                            Model
                            <input
                              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                              value={ep.model || ''}
                              onChange={(e) => update(pane, { model: e.target.value, label: '' })}
                            />
                          </label>
                          <label className="text-xs text-muted-foreground">
                            API-key env var (optional — name only, never the key)
                            <input
                              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                              value={ep.apiKeyEnv || ''}
                              placeholder="e.g. BLDR_LLM_API_KEY"
                              onChange={(e) => update(pane, { apiKeyEnv: e.target.value || undefined, label: '' })}
                            />
                          </label>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-6 flex items-center gap-3">
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save chain'}
          </button>
          {notice && <span className="text-sm text-muted-foreground">{notice}</span>}
        </div>
      </div>
    </div>
  );
}
