import { useEffect, useRef, useState } from 'react';
import Lottie from 'lottie-react';

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

// The chat "thinking" animation. Drop a Lottie JSON here to use it; if it's
// absent we fall back to the BLDR letter spinner. Fetched once, module-cached.
const LOTTIE_URL = '/lottie/chat-loader.json';
let lottieCache: unknown | undefined; // undefined = not tried, null = unavailable

/**
 * Brand loading indicator shown while the agent is working. Plays the BLDR Lottie
 * animation when present, otherwise the BLDR wordmark with each letter swelling
 * small→big→small (the brand spinner). Stopping a turn lives on the composer's
 * send button, which becomes a stop control while the agent is busy.
 */
export default function ClaudeStatus({ isLoading, externalRunning = false }: ClaudeStatusProps) {
  const active = isLoading || externalRunning;
  // Debounced visibility: rise immediately, fall after a grace period (see above).
  const [visible, setVisible] = useState(active);
  const [anim, setAnim] = useState<unknown>(lottieCache ?? null);
  const hideTimer = useRef<number | null>(null);

  // Load the Lottie once (if it exists); fall back silently to the letter spinner.
  useEffect(() => {
    if (lottieCache !== undefined) {
      setAnim(lottieCache);
      return;
    }
    let cancelled = false;
    fetch(LOTTIE_URL)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        lottieCache = data ?? null;
        if (!cancelled) setAnim(lottieCache);
      })
      .catch(() => {
        lottieCache = null;
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
      {anim ? (
        <Lottie
          animationData={anim as object}
          loop
          autoplay
          className="h-16 w-auto"
          style={{ maxWidth: 160 }}
        />
      ) : (
        <div className="bldr-loader select-none text-sm">
          <span>B</span>
          <span>L</span>
          <span>D</span>
          <span>R</span>
        </div>
      )}
    </div>
  );
}
