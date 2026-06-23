/**
 * Project Canvas — shared types.
 *
 * Mirrors the zod schema of the `update_canvas` MCP tool (server/canvas/canvas-mcp.js).
 * The Canvas is a fixed set of heterogeneous panes that mutate in place: each
 * `update_canvas` call provides only the panes it changes, and a latest-value-
 * per-pane reducer (useCanvasStore) keeps the newest value for each.
 */

/** A reference to a binary asset. Frontend prefers data_url > url > path. */
export interface AssetRef {
  data_url?: string;
  path?: string;
  url?: string;
  mime?: string;
  alt?: string;
}

export interface CostsPane {
  pdf?: AssetRef;
  markdown?: string;
}

export interface MapPane {
  lat?: number;
  lng?: number;
  zoom?: number;
  label?: string;
  geojson?: unknown;
}

/** The raw payload of one update_canvas tool call. All fields optional. */
export interface CanvasUpdate {
  top_view?: AssetRef;
  three_d?: AssetRef;
  costs?: CostsPane;
  free?: string;
  map?: MapPane;
  note?: string;
}

/** The five canvas panes. */
export type CanvasPaneId = 'top_view' | 'three_d' | 'costs' | 'free' | 'map';

export const CANVAS_PANE_IDS: CanvasPaneId[] = ['top_view', 'three_d', 'costs', 'free', 'map'];

/** Per-pane value union — the latest value the reducer holds for each pane. */
export interface CanvasPaneValues {
  top_view?: AssetRef;
  three_d?: AssetRef;
  costs?: CostsPane;
  free?: string;
  map?: MapPane;
}

/**
 * The reduced canvas state for one conversation. `rev` is a per-pane revision
 * counter (bumped each time that pane receives a new value) so panes can detect
 * an in-place mutation and re-render / re-init heavy renderers (e.g. three.js).
 */
export interface CanvasState {
  values: CanvasPaneValues;
  rev: Record<CanvasPaneId, number>;
  /** Last note string from any update, for a small status line. */
  note?: string;
  /** Monotonic update counter across all panes. */
  updates: number;
}
