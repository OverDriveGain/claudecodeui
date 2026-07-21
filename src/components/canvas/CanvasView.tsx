import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import type { Project } from '../../types/app';
import { api } from '../../utils/api';
import { canvasStore, useCanvasState } from '../../stores/useCanvasStore';

import { SOURCE_META } from './dataSources';
import type { BldrManifest } from './types';
import ImagePane from './panes/ImagePane';
import CostTablePane from './panes/CostTablePane';
import LocationPane from './panes/LocationPane';
import PaneErrorBoundary from './panes/PaneErrorBoundary';

interface CanvasViewProps {
  selectedProject?: Project | null;
}

// One retrievable past project in the visitor's gallery (see server/bldr/gallery.js).
type PastProject = {
  id: string;
  name: string;
  savedAt: number | null;
  thumb: string | null;
  thumbRev: number;
};

/**
 * bldr project Canvas — a grid of panes, one per data source. Each pane renders
 * by the source's TYPE. Seeded from the on-disk manifest (so panes show on load
 * and survive refresh) and then mutated live by the agent's update_canvas calls.
 */
export default function CanvasView({ selectedProject }: CanvasViewProps) {
  const conversationId = selectedProject?.projectId;
  const canvas = useCanvasState(conversationId);
  const [proposalState, setProposalState] = useState<'idle' | 'working' | 'error'>('idle');
  const [genEnabled, setGenEnabled] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [genState, setGenState] = useState<'idle' | 'working' | 'error'>('idle');
  const [genProgress, setGenProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [brief, setBrief] = useState('');
  const [pastProjects, setPastProjects] = useState<PastProject[]>([]);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  // The visitor's retrievable past projects (server keeps at most 5).
  async function refreshProjects() {
    try {
      const res = await api.bldr.projects();
      if (!res.ok) return;
      const data = (await res.json()) as { projects?: PastProject[] };
      setPastProjects(data.projects ?? []);
    } catch {
      /* transient */
    }
  }

  // Swap a past project back in as the current one, then repaint the panes.
  async function handleRestore(id: string) {
    if (restoringId) return;
    setRestoringId(id);
    try {
      const res = await api.bldr.restoreProject(id);
      if (res.ok) {
        const data = (await res.json()) as { projects?: PastProject[] };
        setPastProjects(data.projects ?? []);
        await refreshManifest();
        setGalleryOpen(false);
      }
    } catch {
      /* leave the gallery open so the user can retry */
    } finally {
      setRestoringId(null);
    }
  }

  // Re-read the manifest and apply it to the panes (used on load + after generate).
  async function refreshManifest() {
    if (!conversationId) return;
    try {
      const res = await api.bldr.manifest();
      if (!res.ok) return;
      const manifest = (await res.json()) as BldrManifest;
      canvasStore.applyManifest(conversationId, manifest);
    } catch {
      /* transient */
    }
  }

  // Route B: kick off async per-pane generation via bti-bldr-gpt, then poll the
  // job — refreshing the panes live as each one is produced.
  async function handleGenerate() {
    if (genState === 'working') return;
    setGenState('working');
    setGenProgress({ done: 0, total: 0 });
    try {
      const res = await api.bldr.generate(brief);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      // Poll the job every 3s until it stops running; refresh panes each tick.
      for (;;) {
        await new Promise((r) => setTimeout(r, 3000));
        let job: { running?: boolean; panes?: Record<string, string> } = {};
        try {
          const jr = await api.bldr.generateJob();
          if (jr.ok) job = await jr.json();
        } catch { /* transient */ }
        const states = Object.values(job.panes || {});
        const done = states.filter((s) => s === 'done' || s === 'failed').length;
        setGenProgress({ done, total: states.length });
        await refreshManifest();
        if (!job.running) break;
      }
      setGenState('idle');
      void refreshProjects(); // the previous design was archived when this run started
    } catch {
      setGenState('error');
      setTimeout(() => setGenState('idle'), 4000);
    }
  }

  // "Proceed with the project" — fetch the generated BTI proposal PDF and save it.
  async function handleProceed() {
    if (proposalState === 'working') return;
    setProposalState('working');
    try {
      const res = await fetch(api.bldr.proposalUrl());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'BTI-Proposal.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setProposalState('idle');
    } catch {
      setProposalState('error');
      setTimeout(() => setProposalState('idle'), 4000);
    }
  }

  // Seed from the project manifest on load / project change.
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.bldr.manifest();
        if (!res.ok) return;
        const manifest = (await res.json()) as BldrManifest;
        if (!cancelled) canvasStore.applyManifest(conversationId, manifest);
      } catch {
        // transient — panes just stay empty until the next seed/update
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // Is the design agent (bti-bldr-gpt) reachable over A2A yet? Gates the control.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.bldr.generateStatus();
        if (!res.ok) return;
        const { enabled } = await res.json();
        if (!cancelled) setGenEnabled(!!enabled);
      } catch {
        /* leave disabled */
      }
    })();
    (async () => {
      try {
        const res = await api.bldr.admin.me();
        const data = res.ok ? await res.json() : null;
        if (!cancelled) setIsAdmin(Boolean(data?.admin));
      } catch {
        /* not admin */
      }
    })();
    void refreshProjects();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden p-3">
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-auto sm:grid-cols-2 lg:grid-cols-3">
        {SOURCE_META.map((meta) => {
          const source = canvas.sources[meta.id];
          return (
            <div key={meta.id} className="min-h-[180px]">
              <PaneErrorBoundary title={meta.title}>
                {meta.type === 'image' && <ImagePane title={meta.title} source={source} />}
                {meta.type === 'cost-table' && <CostTablePane title={meta.title} source={source} />}
                {meta.type === 'map-cesium' && <LocationPane title={meta.title} source={source} />}
              </PaneErrorBoundary>
            </div>
          );
        })}
      </div>
      <div className="relative mt-3 flex shrink-0 flex-wrap items-center justify-between gap-3">
        {galleryOpen && pastProjects.length > 0 && (
          <div className="absolute bottom-full left-0 z-20 mb-2 w-full max-w-2xl rounded-lg border border-border bg-background p-3 shadow-xl">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold">My projects</span>
              <button
                type="button"
                onClick={() => setGalleryOpen(false)}
                className="rounded px-2 text-sm text-muted-foreground hover:bg-accent"
              >
                ✕
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              {pastProjects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleRestore(p.id)}
                  disabled={restoringId !== null}
                  title={p.name}
                  className="group flex flex-col overflow-hidden rounded-md border border-border text-left transition hover:border-primary disabled:opacity-60"
                >
                  <div className="flex h-20 w-full items-center justify-center overflow-hidden bg-accent/40">
                    {p.thumb ? (
                      <img
                        src={api.bldr.assetUrl(p.thumb, p.thumbRev) ?? undefined}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="text-2xl">🏠</span>
                    )}
                  </div>
                  <div className="p-2">
                    <div className="truncate text-xs font-medium">{p.name}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {restoringId === p.id
                        ? 'Opening…'
                        : p.savedAt
                          ? new Date(p.savedAt).toLocaleDateString()
                          : ''}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
        {pastProjects.length > 0 && (
          <button
            type="button"
            onClick={() => setGalleryOpen((v) => !v)}
            title="Reopen one of your past projects"
            className="shrink-0 rounded-md border border-border px-3 py-2.5 text-sm text-muted-foreground transition hover:bg-accent"
          >
            ▤ My projects ({pastProjects.length})
          </button>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {genEnabled ? (
            <>
              <input
                type="text"
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleGenerate(); }}
                placeholder="Describe the build — e.g. 3-bed villa, 200 m², JVC Dubai, full fit-out"
                disabled={genState === 'working'}
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-60"
              />
              <button
                type="button"
                onClick={handleGenerate}
                disabled={genState === 'working'}
                className="inline-flex shrink-0 items-center gap-2 rounded-md border border-primary px-4 py-2 text-sm font-semibold text-primary transition hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {genState === 'working' ? (
                  <>
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    {genProgress.total ? `Designing… ${genProgress.done}/${genProgress.total}` : 'Designing…'}
                  </>
                ) : genState === 'error' ? (
                  'Retry ✦ Generate'
                ) : (
                  '✦ Generate with AI'
                )}
              </button>
            </>
          ) : (
            <div className="text-xs text-muted-foreground">
              {proposalState === 'working'
                ? 'Preparing your BTI proposal…'
                : proposalState === 'error'
                  ? 'Could not generate the proposal — please try again.'
                  : 'Ready — download your BTI proposal for this design.'}
            </div>
          )}
        </div>
        {isAdmin && (
          <Link
            to="/admin"
            title="Pane endpoints (admin)"
            className="shrink-0 rounded-md border border-border px-3 py-2.5 text-sm text-muted-foreground transition hover:bg-accent"
          >
            ⚙ Admin
          </Link>
        )}
        <button
          type="button"
          onClick={handleProceed}
          disabled={proposalState === 'working'}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {proposalState === 'working' ? (
            <>
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              Generating…
            </>
          ) : (
            <>Proceed with the project · Download PDF</>
          )}
        </button>
      </div>
    </div>
  );
}
