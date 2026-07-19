import type { ReactNode } from 'react';

interface PaneFrameProps {
  title: string;
  empty?: boolean;
  emptyHint?: string;
  /** Full-bleed body (no padding/centering) — for maps, video, iframes. */
  flush?: boolean;
  children?: ReactNode;
}

/** Consistent pane chrome: bordered card, header, scrollable body + empty state. */
export default function PaneFrame({ title, empty, emptyHint, flush, children }: PaneFrameProps) {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-lg border border-border bg-card">
      <div className="border-b border-border px-3 py-1.5 text-xs font-medium text-muted-foreground">
        {title}
      </div>
      <div
        className={
          flush
            ? 'relative min-h-0 flex-1 overflow-hidden'
            : 'flex min-h-0 flex-1 items-center justify-center overflow-auto p-2'
        }
      >
        {empty ? (
          <div className="text-center">
            <div className="text-xs text-muted-foreground/70">{emptyHint || 'No content yet'}</div>
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
