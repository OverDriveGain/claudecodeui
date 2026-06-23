import { useSyncExternalStore } from 'react';

import type {
  CanvasState,
  CanvasUpdate,
  CanvasPaneId,
} from '../components/canvas/types';
import { CANVAS_PANE_IDS } from '../components/canvas/types';

/**
 * Project Canvas store.
 *
 * Holds one reduced CanvasState per conversation (keyed by the conversation id —
 * in MyMu that's `selectedProject.projectId`, which is the DB project id for
 * local sessions and `remote:<id>` for relay agents). The store is fed by the
 * `update_canvas` MCP tool: ToolRenderer taps each tool_use frame and calls
 * `canvasStore.applyUpdate(conversationId, payload)`.
 *
 * Reducer = latest-value-per-pane: an update only touches the panes it names;
 * each touched pane bumps its own `rev` so heavy renderers (three.js) can detect
 * an in-place mutation. Implemented as a tiny external store (no zustand in this
 * project) consumed via useSyncExternalStore, exactly like useSessionActivityStore.
 */

function emptyState(): CanvasState {
  const rev = {} as Record<CanvasPaneId, number>;
  for (const id of CANVAS_PANE_IDS) rev[id] = 0;
  return { values: {}, rev, updates: 0 };
}

const states = new Map<string, CanvasState>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Apply one update_canvas payload to a conversation's canvas, returning a NEW
 * CanvasState object (so useSyncExternalStore snapshots are referentially stable
 * when nothing changed). Only the panes present in `update` are touched.
 */
function reduce(prev: CanvasState, update: CanvasUpdate): CanvasState {
  const next: CanvasState = {
    values: { ...prev.values },
    rev: { ...prev.rev },
    note: prev.note,
    updates: prev.updates,
  };

  let changed = false;

  if (update.top_view) {
    next.values.top_view = update.top_view;
    next.rev.top_view += 1;
    changed = true;
  }
  if (update.three_d) {
    next.values.three_d = update.three_d;
    next.rev.three_d += 1;
    changed = true;
  }
  if (update.costs) {
    next.values.costs = update.costs;
    next.rev.costs += 1;
    changed = true;
  }
  if (typeof update.free === 'string') {
    next.values.free = update.free;
    next.rev.free += 1;
    changed = true;
  }
  if (update.map) {
    next.values.map = update.map;
    next.rev.map += 1;
    changed = true;
  }

  if (typeof update.note === 'string') {
    next.note = update.note;
    changed = true;
  }

  if (!changed) return prev;
  next.updates = prev.updates + 1;
  return next;
}

export const canvasStore = {
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
 * snapshot (the shared EMPTY object until the first update) so the component
 * re-renders only when that conversation's canvas actually changes.
 */
export function useCanvasState(conversationId: string | undefined): CanvasState {
  return useSyncExternalStore(
    canvasStore.subscribe,
    () => (conversationId ? states.get(conversationId) : undefined) || EMPTY,
  );
}
