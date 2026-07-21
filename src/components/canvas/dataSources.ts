/**
 * bldr data-source registry (client) — mirrors server/bldr/seed.js.
 *
 * The defined set of data sources, their pane titles, and which pane each maps to.
 * Adding a future pane = add an entry here (+ the server seed). The lock groups
 * declare sources that change together (the agent honours them; section is static).
 */
import type { SourceType } from './types';

export interface SourceMeta {
  id: string;
  title: string;
  type: SourceType;
  /** Drawing-set sheet code, shown in each pane's title block (one document). */
  code: string;
}

export const SOURCE_META: SourceMeta[] = [
  { id: 'top_view', title: 'Floor plan', type: 'image', code: 'A-101' },
  { id: 'section', title: 'Section', type: 'image', code: 'A-201' },
  { id: 'elevations', title: 'Elevations', type: 'image', code: 'A-301' },
  { id: 'front_view', title: 'Exterior render', type: 'image', code: 'R-401' },
  { id: 'costs', title: 'Cost estimate', type: 'cost-table', code: 'C-501' },
  { id: 'location', title: 'Site — Dubai', type: 'map-cesium', code: 'S-601' },
];

export const SOURCE_IDS = SOURCE_META.map((s) => s.id);

export const SOURCE_TYPE_BY_ID: Record<string, SourceType> = Object.fromEntries(
  SOURCE_META.map((s) => [s.id, s.type]),
);

/** Sources that must change together. Mockup phase: the image panes are real BTI
 * drawings and are NOT regenerated, so only the computed data panes are grouped. */
export const LOCK_GROUPS: string[][] = [
  ['costs', 'location'],
];
