import { useSyncExternalStore } from 'react';

import type { CanvasState, CanvasUpdate, BldrManifest, SourceValue } from '../components/canvas/types';
import { SOURCE_IDS, SOURCE_TYPE_BY_ID } from '../components/canvas/dataSources';

/**
 * bldr Canvas store.
 *
 * One CanvasState per conversation/project (keyed by `selectedProject.projectId`).
 * Two inputs, one shape:
 *  - `applyManifest` seeds from the on-disk bldr.json (so panes render on load and
 *    survive refresh).
 *  - `applyUpdate` merges a live `update_canvas` tool payload (the agent changing a
 *    source). Each touched source bumps its own `rev` → the pane refreshes in place
 *    (cache-bust), nothing else re-renders.
 *
 * Tiny external store (no zustand here) read via useSyncExternalStore.
 */

function emptyState(): CanvasState {
  return { sources: {}, updates: 0 };
}

const states = new Map<string, CanvasState>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

// Mockup phase: the image panes are real BTI proposal drawings seeded from the
// manifest. LIVE agent updates must never replace them (only costs/location move),
// so we drop them from any update_canvas payload. The manifest path is unaffected.
const READONLY_LIVE_PANES = new Set(['top_view', 'section', 'elevations', 'front_view']);

/** Pull the per-source values out of an update payload (named fields OR a sources map). */
function collectSources(update: CanvasUpdate): Record<string, Omit<SourceValue, 'rev'>> {
  const out: Record<string, Omit<SourceValue, 'rev'>> = {};
  if (update.sources && typeof update.sources === 'object') {
    for (const [id, v] of Object.entries(update.sources)) {
      if (v && typeof v === 'object' && !READONLY_LIVE_PANES.has(id)) out[id] = v as Omit<SourceValue, 'rev'>;
    }
  }
  for (const id of SOURCE_IDS) {
    if (READONLY_LIVE_PANES.has(id)) continue;
    const v = (update as Record<string, unknown>)[id];
    if (v && typeof v === 'object') out[id] = v as Omit<SourceValue, 'rev'>;
  }
  return out;
}

function reduce(prev: CanvasState, update: CanvasUpdate): CanvasState {
  const incoming = collectSources(update);
  const ids = Object.keys(incoming);
  if (ids.length === 0 && typeof update.note !== 'string') return prev;

  const nextSources = { ...prev.sources };
  for (const id of ids) {
    const value = incoming[id];
    const prevRev = prev.sources[id]?.rev ?? 0;
    const type = value.type || prev.sources[id]?.type || SOURCE_TYPE_BY_ID[id] || 'image';
    nextSources[id] = { ...value, type, rev: prevRev + 1 } as SourceValue;
  }

  return {
    sources: nextSources,
    note: typeof update.note === 'string' ? update.note : prev.note,
    updates: prev.updates + 1,
  };
}

export const canvasStore = {
  /** Seed/replace a conversation's canvas from the on-disk manifest. */
  applyManifest(conversationId: string, manifest: BldrManifest): void {
    if (!conversationId || !manifest || typeof manifest !== 'object') return;
    const sources: Record<string, SourceValue> = {};
    for (const [id, v] of Object.entries(manifest.sources || {})) {
      sources[id] = {
        ...(v as SourceValue),
        type: (v as SourceValue).type || SOURCE_TYPE_BY_ID[id] || 'image',
        rev: (v as SourceValue).rev ?? 1,
      };
    }
    const prev = states.get(conversationId);
    // Don't clobber live updates already applied for unchanged sources: only seed
    // if we have nothing, or merge manifest as the baseline.
    const next: CanvasState = {
      sources: { ...sources, ...(prev?.sources ?? {}) },
      note: prev?.note,
      updates: (prev?.updates ?? 0) + 1,
    };
    states.set(conversationId, next);
    emit();
  },

  applyUpdate(conversationId: string, update: CanvasUpdate): void {
    if (!conversationId) return;
    const prev = states.get(conversationId) || emptyState();
    const next = reduce(prev, update);
    if (next === prev) return;
    states.set(conversationId, next);
    emit();
  },
  getState(conversationId: string): CanvasState | undefined {
    return states.get(conversationId);
  },
  clear(conversationId: string): void {
    if (states.delete(conversationId)) emit();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

const EMPTY = emptyState();

/**
 * Subscribe a component to one conversation's canvas state. Returns a stable
 * snapshot (the shared EMPTY object until the first update).
 */
export function useCanvasState(conversationId: string | undefined): CanvasState {
  return useSyncExternalStore(
    canvasStore.subscribe,
    () => (conversationId ? states.get(conversationId) : undefined) || EMPTY,
  );
}
