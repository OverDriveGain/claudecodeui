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
  const [isAdmin, setIsAdmin] = useState(false);
  const [genJob, setGenJob] = useState<{ running: boolean; panes: Record<string, string> } | null>(null);
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

  // Generation is driven from the CHAT (the assistant's generate_design tool).
  // The canvas just watches the workspace job and repaints panes as they land.
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    let wasRunning = false;
    const tick = async () => {
      try {
        const res = await api.bldr.generateJob();
        if (!res.ok || cancelled) return;
        const job = (await res.json()) as { running?: boolean; panes?: Record<string, string> };
        setGenJob({ running: Boolean(job.running), panes: job.panes ?? {} });
        if (job.running) {
          wasRunning = true;
          await refreshManifest();
        } else if (wasRunning) {
          wasRunning = false;
          await refreshManifest();
          void refreshProjects(); // the previous design was archived when the run started
        }
      } catch {
        /* transient */
      }
    };
    void tick();
    const interval = setInterval(tick, 4000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

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

  useEffect(() => {
    let cancelled = false;
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
                {meta.type === 'image' && <ImagePane title={meta.title} code={meta.code} source={source} />}
                {meta.type === 'cost-table' && <CostTablePane title={meta.title} code={meta.code} source={source} />}
                {meta.type === 'map-cesium' && <LocationPane title={meta.title} code={meta.code} source={source} />}
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
          {genJob?.running ? (
            (() => {
              const states = Object.values(genJob.panes);
              const done = states.filter((s) => s === 'done' || s === 'failed').length;
              return (
                <div className="inline-flex items-center gap-2 text-sm text-primary">
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  Designing your building… {done}/{states.length} panes
                </div>
              );
            })()
          ) : (
            <div className="text-xs text-muted-foreground">
              {proposalState === 'working'
                ? 'Preparing your BTI proposal…'
                : proposalState === 'error'
                  ? 'Could not generate the proposal — please try again.'
                  : 'Describe your building in the chat below — the design appears here.'}
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
