import { useEffect, useRef, useState } from 'react';

type ClaudeStatusProps = {
  status?: { text?: string; tokens?: number; can_interrupt?: boolean } | null;
  onAbort?: () => void;
  isLoading: boolean;
  externalRunning?: boolean;
  provider?: string;
  /** Epoch ms when the current turn started — drives the elapsed timer. */
  turnStartedAt?: number | null;
  /** Tokens the context has grown this turn — the live "tokens this turn" counter. */
  turnTokens?: number | null;
};

/** "412" / "4.2k" / "112k" — tokens generated this turn, CLI-style. */
function tokensLabel(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.floor(n / 1000)}k`;
}

/** "42s" / "4m 12s" / "1h 04m" — how long the agent has been working. */
function elapsedLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

// How long to keep the indicator visible after work appears to stop. The two
// signals feeding `active` race — `isLoading` comes from the live WS stream while
// `externalRunning` comes from polled agent worker_status that flaps across the
// relay's idle window and unreliable connected/disconnected. Without a hold, those
// disagreements blink the logo on and off. Showing instantly but hiding on a delay
// collapses rapid flaps into a steady indicator; a real stop just hides ~1s late.
const HIDE_GRACE_MS = 1500;

/**
 * Brand loading indicator. While the agent is working we drop the old
 * "Processing… STOP" status bar entirely and show the MyMu wordmark with each
 * letter swelling small→big→small in sequence (the brand spinner). Stopping a
 * turn lives on the composer's send button, which becomes a stop control while
 * the agent is busy.
 */
export default function ClaudeStatus({ isLoading, externalRunning = false, turnStartedAt, turnTokens }: ClaudeStatusProps) {
  const active = isLoading || externalRunning;
  // Debounced visibility: rise immediately, fall after a grace period (see above).
  const [visible, setVisible] = useState(active);
  const hideTimer = useRef<number | null>(null);
  // Re-render once a second so the elapsed label ticks while a turn is timed.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (active) {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      setVisible(true);
      return;
    }
    // Schedule a hide; a flap back to active before it fires cancels it (cleanup).
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null;
      setVisible(false);
    }, HIDE_GRACE_MS);
    return () => {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
    };
  }, [active]);

  // Tick the elapsed clock only while the loader is up and a start is anchored.
  useEffect(() => {
    if (!visible || !turnStartedAt) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [visible, turnStartedAt]);

  if (!visible) return null;

  const showElapsed = typeof turnStartedAt === 'number' && turnStartedAt > 0;
  const showTokens = typeof turnTokens === 'number' && turnTokens > 0;

  return (
    <div className="mb-2 flex w-full items-center justify-center gap-2.5" role="status" aria-label="Working">
      <div className="mymu-loader select-none text-sm">
        <span>M</span>
        <span>y</span>
        <span>M</span>
        <span>u</span>
      </div>
      {(showElapsed || showTokens) && (
        <span className="font-mono text-xs text-muted-foreground">
          {showElapsed && elapsedLabel(now - (turnStartedAt as number))}
          {showTokens && `${showElapsed ? ' · ' : ''}${tokensLabel(turnTokens as number)} tokens`}
        </span>
      )}
    </div>
  );
}
