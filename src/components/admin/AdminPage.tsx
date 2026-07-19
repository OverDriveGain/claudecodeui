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

const PANE_NAMES: Record<string, string> = {
  top_view: 'Top view',
  section: 'Section',
  elevations: 'Elevations',
  front_view: 'Front view',
  costs: 'Costs',
};

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
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
