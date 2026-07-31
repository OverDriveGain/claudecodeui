import { useTranslation } from 'react-i18next';
import { ActivityIcon } from 'lucide-react';

type TokenUsageSummaryProps = {
  usage: Record<string, unknown> | null;
  onClick?: () => void;
};

const formatTokenCount = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }

  if (value >= 10_000) {
    return `${Math.round(value / 1_000)}K`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }

  return value.toLocaleString();
};

const readUsageNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Session-total token chip. Lives ABOVE the composer as a session stat — not in
 * the input-tools row, where it read as another input control next to the
 * attach button. Hidden until the session has reported any usage.
 */
export default function TokenUsageSummary({ usage, onClick }: TokenUsageSummaryProps) {
  const { t } = useTranslation('chat');
  const breakdown =
    usage?.breakdown && typeof usage.breakdown === 'object'
      ? usage.breakdown as Record<string, unknown>
      : null;
  const inputTokens = readUsageNumber(usage?.inputTokens ?? breakdown?.input);
  const outputTokens = readUsageNumber(usage?.outputTokens ?? breakdown?.output);
  const usedTokens = readUsageNumber(usage?.used) || inputTokens + outputTokens;

  if (!usage || usedTokens <= 0) {
    return null;
  }

  const windowTokens = readUsageNumber(usage?.total);
  const windowPct = windowTokens > 0 ? Math.min(100, Math.round((usedTokens / windowTokens) * 100)) : null;
  const label = t('input.totalTokens', { defaultValue: 'Total tokens' });

  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border/60 bg-card/80 pl-1 pr-2.5 text-xs shadow-sm backdrop-blur transition-colors hover:border-primary/30 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      title={
        windowTokens > 0
          ? `${usedTokens.toLocaleString()} tokens used in this session — ${windowPct}% of the ${formatTokenCount(windowTokens)} context window`
          : `${usedTokens.toLocaleString()} tokens used in this session`
      }
      aria-label={label}
    >
      <span className="grid h-5 w-5 place-items-center rounded-full bg-primary/10 text-primary">
        <ActivityIcon className="h-3 w-3" />
      </span>
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums text-foreground">{formatTokenCount(usedTokens)}</span>
      {windowPct !== null && windowPct >= 1 && (
        <span className="tabular-nums text-[10px] text-muted-foreground/70">{windowPct}%</span>
      )}
    </button>
  );
}
