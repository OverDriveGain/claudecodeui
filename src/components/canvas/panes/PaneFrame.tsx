import type { ReactNode } from 'react';

interface PaneFrameProps {
  title: string;
  /** Drawing-set sheet code (e.g. "A-101") shown in the title block. */
  code?: string;
  empty?: boolean;
  emptyHint?: string;
  /** Full-bleed body (no padding/centering) — for maps, video, iframes. */
  flush?: boolean;
  children?: ReactNode;
}

const BTI_RED = '#D52027';

/**
 * Pane chrome styled as ONE SHEET of a BTI drawing set — the same visual
 * language the generated drawings use (white paper, ink text, red accent,
 * title block). Deliberately light-on-white regardless of app theme: the panes
 * together read as one printed proposal document on the dark board.
 */
export default function PaneFrame({ title, code, empty, emptyHint, flush, children }: PaneFrameProps) {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-sm border border-neutral-300 bg-white shadow-[0_1px_8px_rgba(0,0,0,0.35)]">
      {/* Title block strip — identical on every sheet (mirrors the drawings'). */}
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-200 bg-white px-3 py-1.5">
        <span className="h-2.5 w-2.5 shrink-0" style={{ backgroundColor: BTI_RED }} />
        <span className="truncate text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-800">
          {title}
        </span>
        <span className="ml-auto flex shrink-0 items-baseline gap-2">
          <span className="hidden text-[9px] uppercase tracking-[0.12em] text-neutral-400 sm:inline">
            BTI · Build Tech Innovation 3D
          </span>
          {code && (
            <span className="font-mono text-[10px] font-medium" style={{ color: BTI_RED }}>
              {code}
            </span>
          )}
        </span>
      </div>
      <div
        className={
          flush
            ? 'relative min-h-0 flex-1 overflow-hidden bg-white'
            : 'flex min-h-0 flex-1 items-center justify-center overflow-auto bg-white p-2'
        }
      >
        {empty ? (
          <div className="text-center">
            <div className="text-xs text-neutral-400">{emptyHint || 'No content yet'}</div>
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
