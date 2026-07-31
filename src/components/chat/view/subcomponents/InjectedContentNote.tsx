import { useState } from 'react';
import { ChevronRight } from 'lucide-react';

/**
 * Injected-context machinery that Claude Code folds into the conversation as
 * ordinary user-role messages: a loaded skill's full SKILL.md, or a long
 * <system-reminder> block. Rendered verbatim these dominate the chat with walls
 * of text (and read like "the agent keeps sending something"). We collapse each
 * into a compact, expandable chip so the conversation stays readable while the
 * full content is one click away.
 */
export type InjectedSegment = { kind: 'skill' | 'reminder' | 'injected'; label: string; body: string };

/**
 * Short human label for a generic injected payload (server-flagged `isInjected`,
 * e.g. a loaded skill's instructions): first markdown heading if there is one,
 * else the first line, truncated.
 */
export function injectedLabelFor(body: string): string {
  const heading = body.match(/^#{1,3}\s+(.+)$/m);
  const source = (heading ? heading[1] : body.trimStart().split('\n', 1)[0] || '').trim();
  const clipped = source.length > 64 ? `${source.slice(0, 64).trimEnd()}…` : source;
  return clipped || 'Injected instructions';
}

// Collapse a reminder only when it's long enough to be noise; short ones stay inline.
const REMINDER_COLLAPSE_MIN = 200;

/**
 * Split a user message into the human-authored text and any injected machinery
 * segments (skill payloads, long system-reminders). Short reminders are left in
 * the text. Returns the cleaned text plus the segments to render as chips.
 */
export function splitInjectedContent(content: string): { text: string; segments: InjectedSegment[] } {
  const segments: InjectedSegment[] = [];
  if (!content) return { text: '', segments };

  // Pull out <system-reminder>…</system-reminder> blocks; keep short ones inline.
  let text = content.replace(/<system-reminder>([\s\S]*?)<\/system-reminder>/g, (match, body) => {
    const trimmed = String(body).trim();
    if (trimmed.length < REMINDER_COLLAPSE_MIN) return match; // leave short reminders in place
    segments.push({ kind: 'reminder', label: 'System reminder', body: trimmed });
    return '';
  });

  // A loaded skill is injected as a user message that begins with this exact line.
  const trimmed = text.trim();
  if (/^Base directory for this skill:/.test(trimmed)) {
    const firstLine = trimmed.split('\n', 1)[0] || '';
    const pathMatch = firstLine.match(/Base directory for this skill:\s*(.+)$/);
    let name = '';
    if (pathMatch) {
      name = (pathMatch[1].trim().replace(/\/+$/, '').split('/').pop() || '').trim();
    }
    if (!name) {
      const heading = trimmed.match(/^#\s+(.+)$/m);
      name = heading ? heading[1].trim() : 'skill';
    }
    segments.push({ kind: 'skill', label: `Loaded skill: ${name}`, body: trimmed });
    text = '';
  }

  return { text: text.trim(), segments };
}

const SEGMENT_ICON: Record<InjectedSegment['kind'], string> = {
  skill: '📦',
  reminder: 'ℹ️',
  injected: '⚙️',
};

export function InjectedSegmentChip({ seg }: { seg: InjectedSegment }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex max-w-full items-center gap-1.5 rounded-md border border-border/60 bg-muted/50 px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted"
      >
        <ChevronRight className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span aria-hidden>{SEGMENT_ICON[seg.kind]}</span>
        <span className="truncate font-medium">{seg.label}</span>
      </button>
      {open && (
        <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/50 bg-muted/30 p-2 text-xs leading-relaxed text-foreground/80">
          {seg.body}
        </pre>
      )}
    </div>
  );
}

/**
 * Left-aligned row for a user-role message that the person did NOT type —
 * harness-injected context (loaded skill payloads, synthetic instructions).
 * Mirrors how other chat platforms mark automated/context messages: dimmed,
 * on the agent side, collapsed behind a labeled chip.
 */
export function InjectedContextRow({ segments, timestamp }: { segments: InjectedSegment[]; timestamp?: string }) {
  return (
    <div className="w-full">
      <div className="flex items-center gap-2 pb-1 text-[11px] uppercase tracking-wide text-muted-foreground/70">
        <span>Context added automatically</span>
        {timestamp ? <span className="normal-case tracking-normal">· {timestamp}</span> : null}
      </div>
      <div className="space-y-1">
        {segments.map((seg, i) => (
          <InjectedSegmentChip key={`${seg.kind}-${i}`} seg={seg} />
        ))}
      </div>
    </div>
  );
}
