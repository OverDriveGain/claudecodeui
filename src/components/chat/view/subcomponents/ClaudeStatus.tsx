import { useEffect, useRef, useState } from 'react';

type ClaudeStatusProps = {
  status?: { text?: string; tokens?: number; can_interrupt?: boolean } | null;
  onAbort?: () => void;
  isLoading: boolean;
  externalRunning?: boolean;
  provider?: string;
};

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
export default function ClaudeStatus({ isLoading, externalRunning = false }: ClaudeStatusProps) {
  const active = isLoading || externalRunning;
  // Debounced visibility: rise immediately, fall after a grace period (see above).
  const [visible, setVisible] = useState(active);
  const hideTimer = useRef<number | null>(null);

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

  if (!visible) return null;

  return (
    <div className="mb-2 flex w-full items-center justify-center" role="status" aria-label="Working">
      <div className="mymu-loader select-none text-sm">
        <span>M</span>
        <span>y</span>
        <span>M</span>
        <span>u</span>
      </div>
    </div>
  );
}
