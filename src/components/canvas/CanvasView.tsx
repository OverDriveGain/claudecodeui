import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { Project } from '../../types/app';
import { api } from '../../utils/api';
import { canvasStore, useCanvasState } from '../../stores/useCanvasStore';

import { SOURCE_META } from './dataSources';
import DesignWizard, { type WizardParams } from './DesignWizard';
import { consumeIncomingBrief } from '../../utils/incomingBrief';
import type { BldrManifest } from './types';
import ImagePane from './panes/ImagePane';
import CostTablePane from './panes/CostTablePane';
import LocationPane from './panes/LocationPane';
import PaneErrorBoundary from './panes/PaneErrorBoundary';

interface CanvasViewProps {
  selectedProject?: Project | null;
}

// The wizard fronts the funnel once per page load (like the website's /design
// steps) — module-level so in-app navigation doesn't re-trigger it, a real
// refresh does.
let wizardShownThisLoad = false;

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
  const { t, i18n } = useTranslation('bldr');
  // Localized pane title (Floor plan / Section / …); falls back to the English
  // registry title if a key is missing.
  const paneTitle = (id: string, fallback: string) => t(`panes.${id}`, { defaultValue: fallback });

  // Keep the server's copy of the customer's language in sync (it drives the AI
  // Architect's reply language). Fires on load and whenever the language
  // changes — including a ?lang= handoff from the website, which resolves after
  // this mounts.
  useEffect(() => {
    const sync = () => void api.bldr.setLanguage?.(i18n.language).catch(() => {});
    sync();
    i18n.on('languageChanged', sync);
    return () => i18n.off('languageChanged', sync);
  }, [i18n]);
  const conversationId = selectedProject?.projectId;
  const canvas = useCanvasState(conversationId);
  const [proposalState, setProposalState] = useState<'idle' | 'working' | 'error'>('idle');
  const [isAdmin, setIsAdmin] = useState(false);
  const [genJob, setGenJob] = useState<{ running: boolean; panes: Record<string, string> } | null>(null);
  const [pastProjects, setPastProjects] = useState<PastProject[]>([]);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  // The design wizard fronts every page load (Skip reveals the current design).
  // A ?brief= handoff from the website replaces it — those visitors already
  // went through the website's steps.
  const [wizardOpen, setWizardOpen] = useState(false);
  useEffect(() => {
    if (wizardShownThisLoad) return;
    try {
      if (sessionStorage.getItem('bldr-incoming-brief')) return;
    } catch {
      /* private mode */
    }
    wizardShownThisLoad = true;
    setWizardOpen(true);
  }, []);
  // The saved selections banner: shows the injected brief, makes "add details"
  // clearly optional. Cleared on dismiss or when a generation starts.
  const [savedBrief, setSavedBrief] = useState<string | null>(null);
  const [wizardBusy, setWizardBusy] = useState(false);

  const closeWizard = () => setWizardOpen(false);

  // Complete = fresh start: blank the sheets, then inject the selections into
  // the assistant's briefing (NOT the chat) — the customer talks details after.
  const completeWizard = async (params: WizardParams) => {
    if (wizardBusy) return;
    setWizardBusy(true);
    // Each step is best-effort: whatever happens, the visitor must land in the
    // chat — a dead button is the worst outcome. Failures surface in the banner.
    try {
      const resNew = await api.bldr.newProject?.();
      if (resNew?.ok) {
        const data = (await resNew.json()) as { projects?: PastProject[] };
        setPastProjects(data.projects ?? []);
      }
    } catch {
      /* keep going */
    }
    try {
      const resParams = await api.bldr.saveParams?.(params);
      if (resParams?.ok) {
        const data = (await resParams.json()) as { brief?: string };
        setSavedBrief(data.brief ?? null);
        // Let the proactive chat greeting refresh with the new selections.
        window.dispatchEvent(new CustomEvent('bldr:paramsSaved'));
      } else {
        setSavedBrief(`${params.type}, ${params.area} m², ${params.style} style, ${params.finish} — (not saved yet: tell the AI these in the chat)`);
      }
    } catch {
      setSavedBrief(`${params.type}, ${params.area} m², ${params.style} style, ${params.finish} — (not saved yet: tell the AI these in the chat)`);
    }
    try {
      await refreshManifest();
    } catch {
      /* transient */
    }
    setWizardOpen(false);
    setWizardBusy(false);
  };

  // Website handoff (?brief=): same flow, choices made on the website page.
  useEffect(() => {
    const brief = consumeIncomingBrief();
    if (!brief) return;
    (async () => {
      try {
        await api.bldr.newProject();
        const res = await api.bldr.saveParams({ brief });
        if (res.ok) setSavedBrief(((await res.json()) as { brief?: string }).brief ?? brief);
        window.dispatchEvent(new CustomEvent('bldr:paramsSaved'));
        await refreshManifest();
        void refreshProjects();
      } catch {
        /* transient */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  const [justFinished, setJustFinished] = useState(false);
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    let wasRunning = false;
    let flashTimer: ReturnType<typeof setTimeout> | null = null;
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
          setJustFinished(true); // "your design is ready" moment
          flashTimer = setTimeout(() => !cancelled && setJustFinished(false), 10000);
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
      if (flashTimer) clearTimeout(flashTimer);
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
      {wizardOpen && <DesignWizard onComplete={completeWizard} onClose={closeWizard} busy={wizardBusy} />}
      {genJob?.running && (() => {
        const states = Object.values(genJob.panes);
        const settled = states.filter((s) => s === 'done' || s === 'failed' || s === 'skipped').length;
        return (
          <div className="mb-2 h-1 w-full shrink-0 overflow-hidden rounded-full bg-border">
            <div
              className="h-full rounded-full bg-primary transition-all duration-700"
              style={{ width: `${Math.max(6, (settled / Math.max(1, states.length)) * 100)}%` }}
            />
          </div>
        );
      })()}
      <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-1 gap-3 overflow-auto sm:grid-cols-2 lg:grid-cols-3">
        {SOURCE_META.map((meta) => {
          const source = canvas.sources[meta.id];
          // Live per-sheet state while a generation runs (undefined for the map
          // pane and when idle) — each sheet narrates its own progress.
          const paneState = genJob?.running ? genJob.panes[meta.id] : undefined;
          const title = paneTitle(meta.id, meta.title);
          return (
            // Give each sheet a drawing-friendly aspect + a tall minimum so the
            // high-res drawings read large (they were being squashed into ~120px).
            <div key={meta.id} className="relative min-h-[250px] aspect-[4/3] sm:aspect-auto">
              <PaneErrorBoundary title={title}>
                {meta.type === 'image' && <ImagePane title={title} code={meta.code} source={source} />}
                {meta.type === 'cost-table' && <CostTablePane title={title} code={meta.code} source={source} />}
                {meta.type === 'map-cesium' && <LocationPane title={title} code={meta.code} source={source} />}
              </PaneErrorBoundary>
              {paneState === 'working' && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-lg bg-white/75 backdrop-blur-[1px]">
                  <span className="h-7 w-7 animate-spin rounded-full border-[3px] border-[#D52027] border-t-transparent" />
                  <span className="text-xs font-semibold uppercase tracking-wider text-[#D52027]">
                    {t('canvas.drawing', { sheet: title })}
                  </span>
                </div>
              )}
              {paneState === 'pending' && (
                <span className="absolute end-2 top-8 z-10 rounded-full bg-neutral-800/80 px-2 py-0.5 text-[10px] font-medium text-white">
                  {t('canvas.queued')}
                </span>
              )}
              {paneState === 'done' && (
                <span className="absolute end-2 top-8 z-10 rounded-full bg-green-600/90 px-2 py-0.5 text-[10px] font-bold text-white">
                  {t('canvas.ready')}
                </span>
              )}
              {(paneState === 'failed' || paneState === 'skipped') && (
                <span
                  className="absolute end-2 top-8 z-10 rounded-full bg-[#D52027]/90 px-2 py-0.5 text-[10px] font-bold text-white"
                  title={t('canvas.keptPreviousTitle')}
                >
                  {t('canvas.keptPrevious')}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {savedBrief && !genJob?.running && (
        <div className="mt-3 flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-sm">
          <span className="font-semibold text-primary">✓ {t('canvas.briefSaved')}</span>
          <span className="min-w-0 flex-1 truncate" title={savedBrief}>{savedBrief}</span>
          <span className="text-xs text-muted-foreground">
            {t('canvas.addDetailsHint')}
          </span>
          <button
            type="button"
            onClick={() => setSavedBrief(null)}
            className="rounded px-1.5 text-muted-foreground hover:bg-accent"
            aria-label={t('canvas.dismiss')}
          >
            ✕
          </button>
        </div>
      )}
      <div className="relative mt-3 flex shrink-0 flex-wrap items-center justify-between gap-3">
        {galleryOpen && pastProjects.length > 0 && (
          <div className="absolute bottom-full left-0 z-20 mb-2 w-full max-w-2xl rounded-lg border border-border bg-background p-3 shadow-xl">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold">{t('canvas.myProjectsHeading')}</span>
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
                        ? t('canvas.opening')
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
        <button
          type="button"
          onClick={() => setWizardOpen(true)}
          title={t('canvas.newDesignTitle')}
          className="shrink-0 rounded-md border border-border px-3 py-2.5 text-sm text-muted-foreground transition hover:bg-accent"
        >
          ✨ {t('canvas.newDesign')}
        </button>
        {pastProjects.length > 0 && (
          <button
            type="button"
            onClick={() => setGalleryOpen((v) => !v)}
            title={t('canvas.myProjectsTitle')}
            className="shrink-0 rounded-md border border-border px-3 py-2.5 text-sm text-muted-foreground transition hover:bg-accent"
          >
            ▤ {t('canvas.myProjects', { count: pastProjects.length })}
          </button>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {genJob?.running ? (
            (() => {
              const entries = Object.entries(genJob.panes);
              const done = entries.filter(([, s]) => s === 'done' || s === 'failed' || s === 'skipped').length;
              const drawing = entries
                .filter(([, s]) => s === 'working')
                .map(([id]) => paneTitle(id, SOURCE_META.find((m) => m.id === id)?.title || id));
              return (
                <div className="inline-flex min-w-0 items-center gap-2 text-sm text-primary">
                  <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  <span className="truncate">
                    {drawing.length ? t('canvas.drawingSheets', { sheets: drawing.join(' + ') }) : t('canvas.designing')}
                    <span className="text-muted-foreground">{t('canvas.sheetsProgress', { done, total: entries.length })}</span>
                  </span>
                </div>
              );
            })()
          ) : justFinished ? (
            <div className="inline-flex items-center gap-2 text-sm font-medium text-green-600">
              <span>✓</span> {t('canvas.designReady')}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              {proposalState === 'working'
                ? t('canvas.preparingProposal')
                : proposalState === 'error'
                  ? t('canvas.proposalError')
                  : t('canvas.describeHint')}
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
              {t('canvas.generatingProposal')}
            </>
          ) : (
            <>{t('canvas.proceed')}</>
          )}
        </button>
      </div>
    </div>
  );
}
