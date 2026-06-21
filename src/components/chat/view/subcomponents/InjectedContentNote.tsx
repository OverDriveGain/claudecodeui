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
export type InjectedSegment = { kind: 'skill' | 'reminder'; label: string; body: string };

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

export function InjectedSegmentChip({ seg }: { seg: InjectedSegment }) {
  const [open, setOpen] = useState(false);
  const icon = seg.kind === 'skill' ? '📦' : 'ℹ️';
  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-md border border-white/15 bg-black/20 px-2 py-1 text-xs text-gray-200 transition-colors hover:bg-black/30"
      >
        <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span aria-hidden>{icon}</span>
        <span className="font-medium">{seg.label}</span>
      </button>
      {open && (
        <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-white/10 bg-black/30 p-2 text-xs leading-relaxed text-gray-200">
          {seg.body}
        </pre>
      )}
    </div>
  );
}
