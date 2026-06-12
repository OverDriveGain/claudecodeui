type ClaudeStatusProps = {
  status?: { text?: string; tokens?: number; can_interrupt?: boolean } | null;
  onAbort?: () => void;
  isLoading: boolean;
  externalRunning?: boolean;
  provider?: string;
};

/**
 * Brand loading indicator. While the agent is working we drop the old
 * "Processing… STOP" status bar entirely and show the MyMu wordmark with each
 * letter swelling small→big→small in sequence (the brand spinner). Stopping a
 * turn lives on the composer's send button, which becomes a stop control while
 * the agent is busy.
 */
export default function ClaudeStatus({ isLoading, externalRunning = false }: ClaudeStatusProps) {
  const active = isLoading || externalRunning;
  if (!active) return null;

  return (
    <div className="mb-3 flex w-full items-center justify-center" role="status" aria-label="Working">
      <div className="mymu-loader select-none text-2xl">
        <span>M</span>
        <span>y</span>
        <span>M</span>
        <span>u</span>
      </div>
    </div>
  );
}
