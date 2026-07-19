/**
 * bldr Canvas — shared types (data-source model).
 *
 * Each project has a set of DATA SOURCES; each source has a TYPE that decides how
 * its pane renders. `bldr.json` (served by /api/bldr/manifest) is the source of
 * truth; the agent's `update_canvas` tool pushes live changes. A per-source `rev`
 * bumps on every change so a pane refreshes in place (cache-bust) — no page reload.
 */

export type SourceType = 'image' | 'cost-table' | 'map-cesium';

/** A binary asset reference. Frontend prefers path (served) > data_url > url. */
export interface AssetRef {
  data_url?: string;
  path?: string;
  url?: string;
  mime?: string;
  alt?: string;
}

export interface CostRow {
  item: string;
  qty?: number;
  unit?: string;
  cost: number;
}
export interface CostData {
  name: string;
  currency?: string;
  rows: CostRow[];
  total?: number;
}
export interface LocationData {
  lat: number;
  lng: number;
  zoom?: number;
  label?: string;
  model?: unknown;
}

/** One data source's current value. `path`/`data_url`/`url` for files, `data` for structured. */
export interface SourceValue {
  type: SourceType;
  path?: string;
  data_url?: string;
  url?: string;
  alt?: string;
  name?: string;
  data?: CostData | LocationData | unknown;
  /** bumped on each change → cache-bust / re-render */
  rev: number;
}

/** The on-disk project manifest (bldr.json). */
export interface BldrManifest {
  name: string;
  sources: Record<string, SourceValue>;
  locks: string[][];
}

/**
 * Raw payload of one update_canvas tool call: named source fields, each carrying
 * a value WITHOUT a rev (the store assigns/bumps rev). All optional.
 */
export type CanvasUpdate = {
  note?: string;
  sources?: Record<string, Omit<SourceValue, 'rev'>>;
} & Record<string, unknown>;

/** Reduced canvas state for one project/conversation. */
export interface CanvasState {
  sources: Record<string, SourceValue>;
  note?: string;
  /** Monotonic update counter across all sources. */
  updates: number;
}
