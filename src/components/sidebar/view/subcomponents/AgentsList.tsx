// MYMU: the live-agents tab (FORK.md F1) — every row is one running `claude
// --remote-control` session surfaced by the relay; clicking opens its
// conversation through the exact same session-select flow project sessions use.
import { useCallback, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Eye, EyeOff, Play } from 'lucide-react';
import type { TFunction } from 'i18next';

import type { Project, ProjectSession } from '../../../../types/app';
import type { SessionWithProvider } from '../../types/types';
import { cn } from '../../../../lib/utils';
import { api } from '../../../../utils/api';
import { useRemoteHosts } from '../../../../utils/remoteHosts';
import { agentHostKey, hostKeyLabel, toggleHostHidden, useHiddenHosts } from '../../../../utils/hostFocus';

type AgentsListProps = {
  agents: Project[];
  selectedSession: ProjectSession | null;
  /** Session ids with an active run — drives the working spinner. */
  processingIds: ReadonlySet<string>;
  /** Show a per-user label on each row (only when more than one login is connected). */
  showHostLabels?: boolean;
  /** The primary login's username — labels the agents this session owns. */
  primaryLabel?: string;
  /** Individually-hidden agents still present in the roster (real names). */
  hiddenAgents?: Project[];
  /** Hidden agent keys with no live roster match (offline/removed). */
  orphanHiddenKeys?: string[];
  onSessionSelect: (session: SessionWithProvider, projectId: string) => void;
  onHideAgent?: (agent: Project) => void;
  onUnhideAgent?: (agent: Project) => void;
  onUnhideKey?: (key: string) => void;
  t: TFunction;
};

/** Title portion of a stable agent key (`account␟title` | `title`). */
function titleFromKey(key: string): string {
  const sep = String.fromCharCode(0x1f);
  const i = key.indexOf(sep);
  return i >= 0 ? key.slice(i + 1) : key;
}

export default function AgentsList({
  agents,
  selectedSession,
  processingIds,
  showHostLabels,
  primaryLabel,
  hiddenAgents = [],
  orphanHiddenKeys = [],
  onSessionSelect,
  onHideAgent,
  onUnhideAgent,
  onUnhideKey,
  t,
}: AgentsListProps) {
  const [showHiddenList, setShowHiddenList] = useState(false);
  const [starting, setStarting] = useState<ReadonlySet<string>>(new Set());
  const [startError, setStartError] = useState<Record<string, string>>({});
  const remoteHosts = useRemoteHosts();
  const hiddenHosts = useHiddenHosts();

  // Bring an offline agent online via this account's configured start command,
  // run on the host that owns the agent. Spinner stays until the roster poll
  // flips remoteConnected; failures surface inline under the row.
  const handleStart = useCallback(async (agent: Project) => {
    const id = agent.projectId;
    const name = (agent.displayName || '').trim();
    if (!name || starting.has(id)) return;
    setStartError((prev) => { const next = { ...prev }; delete next[id]; return next; });
    setStarting((prev) => new Set(prev).add(id));
    const host = remoteHosts.find((h) => h.key === agentHostKey(agent)) ?? null;
    try {
      const res = await api.startAgent(name, host);
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok === false) {
        const msg = body?.error || body?.stderr || `Start failed (${res.status})`;
        setStartError((prev) => ({ ...prev, [id]: String(msg).trim().slice(0, 300) }));
      }
    } catch (err) {
      setStartError((prev) => ({ ...prev, [id]: err instanceof Error ? err.message : 'Start failed' }));
    } finally {
      // Clear the local spinner after a grace window; the roster poll takes over.
      setTimeout(() => {
        setStarting((prev) => { const next = new Set(prev); next.delete(id); return next; });
      }, 8000);
    }
  }, [remoteHosts, starting]);

  const sorted = useMemo(
    () =>
      [...agents].sort((a, b) => {
        // Online first, then by name.
        const oa = a.remoteConnected ? 0 : 1;
        const ob = b.remoteConnected ? 0 : 1;
        if (oa !== ob) return oa - ob;
        return (a.displayName || '').localeCompare(b.displayName || '');
      }),
    [agents],
  );

  // Host-focus recovery: which currently-connected hosts (incl. the primary '')
  // the user has focus-hidden. Stale keys for disconnected hosts are ignored.
  const hiddenHostKeys = useMemo(() => {
    const connected = new Set<string>(['', ...remoteHosts.map((h) => h.key)]);
    return [...hiddenHosts].filter((k) => connected.has(k));
  }, [hiddenHosts, remoteHosts]);

  const hiddenAgentCount = hiddenAgents.length + orphanHiddenKeys.length;

  return (
    <div className="px-2 pb-2">
      {/* Per-user focus recovery — hiding a login's agents is never a dead end. */}
      {hiddenHostKeys.length > 0 && (
        <div className="mb-1.5 flex flex-wrap items-center gap-1 rounded-md bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground">
          <span className="mr-0.5">Hidden:</span>
          {hiddenHostKeys.map((k) => (
            <button
              key={k || 'primary'}
              type="button"
              title="Show this user’s agents"
              className="inline-flex items-center gap-1 rounded bg-background px-1.5 py-0.5 font-medium text-primary transition-colors hover:bg-primary/10"
              onClick={() => toggleHostHidden(k)}
            >
              <Eye className="h-3 w-3" />
              {hostKeyLabel(k, primaryLabel)}
            </button>
          ))}
        </div>
      )}

      {agents.length === 0 ? (
        <p className="px-2 py-6 text-center text-sm text-muted-foreground">
          {t('agents.empty', { defaultValue: 'No agents visible' })}
        </p>
      ) : (
        <div className="space-y-0.5">
          {sorted.map((agent) => {
            const session = agent.sessions?.[0];
            if (!session) return null;
            const isSelected = selectedSession?.id === session.id;
            const isWorking = processingIds.has(session.id);
            const isOffline = !agent.remoteConnected;
            const isStarting = starting.has(agent.projectId);
            const err = startError[agent.projectId];
            return (
              <div key={agent.projectId}>
              <div
                className={cn(
                  'group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer',
                  isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                )}
                onClick={() => onSessionSelect({ ...session, provider: 'claude' } as SessionWithProvider, agent.projectId)}
              >
                {/* Liveliness: spinner while working/starting, dot otherwise */}
                {isWorking || isStarting ? (
                  <span className="h-2 w-2 shrink-0 animate-spin rounded-full border border-primary border-t-transparent" />
                ) : (
                  <span
                    className={cn(
                      'h-2 w-2 shrink-0 rounded-full',
                      agent.remoteConnected ? 'bg-green-500' : 'bg-muted-foreground/40',
                    )}
                  />
                )}
                <span className="truncate">{agent.displayName}</span>
                {showHostLabels ? (
                  <span className="shrink-0 rounded bg-primary/10 px-1 text-[10px] font-medium text-primary/80">
                    {hostKeyLabel(agentHostKey(agent), primaryLabel)}
                  </span>
                ) : null}
                {agent.remoteAccount ? (
                  <span className="ml-auto shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                    {agent.remoteAccount}
                  </span>
                ) : null}
                {isOffline ? (
                  <button
                    type="button"
                    title={t('agents.start', { defaultValue: 'Start this agent' })}
                    disabled={isStarting}
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10 disabled:opacity-50',
                      agent.remoteAccount || onHideAgent ? '' : 'ml-auto',
                    )}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleStart(agent);
                    }}
                  >
                    <Play className="h-3 w-3" />
                    {isStarting
                      ? t('agents.starting', { defaultValue: 'Starting…' })
                      : t('agents.start', { defaultValue: 'Start' })}
                  </button>
                ) : null}
                {onHideAgent ? (
                  <button
                    type="button"
                    title={t('agents.hide', { defaultValue: 'Remove from view' })}
                    className={cn(
                      'shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100',
                      !agent.remoteAccount && !isOffline ? 'ml-auto' : '',
                    )}
                    onClick={(e) => {
                      e.stopPropagation();
                      onHideAgent(agent);
                    }}
                  >
                    <EyeOff className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
              {err ? (
                <p className="break-words px-2 pb-1 text-[11px] leading-snug text-destructive">{err}</p>
              ) : null}
              </div>
            );
          })}
        </div>
      )}

      {/* Per-agent recovery: reveal + restore individually-hidden agents. */}
      {hiddenAgentCount > 0 && (
        <div className="mt-1.5 border-t border-border/40 pt-1.5">
          <button
            type="button"
            className="flex w-full items-center gap-1 px-1 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            aria-expanded={showHiddenList}
            onClick={() => setShowHiddenList((v) => !v)}
          >
            {showHiddenList ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {hiddenAgentCount} hidden {hiddenAgentCount === 1 ? 'agent' : 'agents'}
            <span className="ml-1 text-muted-foreground/70">{showHiddenList ? '· hide list' : '· show'}</span>
          </button>
          {showHiddenList && (
            <div className="mt-0.5 space-y-0.5">
              {hiddenAgents.map((agent) => (
                <div
                  key={agent.projectId}
                  className="group flex items-center gap-2 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent/40"
                >
                  <EyeOff className="h-3 w-3 shrink-0 opacity-60" />
                  <span className="truncate">{agent.displayName}</span>
                  {agent.remoteAccount ? (
                    <span className="ml-auto shrink-0 rounded bg-muted px-1 text-[10px]">{agent.remoteAccount}</span>
                  ) : null}
                  <button
                    type="button"
                    title="Restore to view"
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10',
                      agent.remoteAccount ? '' : 'ml-auto',
                    )}
                    onClick={() => onUnhideAgent?.(agent)}
                  >
                    <Eye className="h-3 w-3" />
                    Show
                  </button>
                </div>
              ))}
              {orphanHiddenKeys.map((key) => (
                <div
                  key={key}
                  className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent/40"
                >
                  <EyeOff className="h-3 w-3 shrink-0 opacity-60" />
                  <span className="truncate">{titleFromKey(key)}</span>
                  <button
                    type="button"
                    title="Restore to view"
                    className="ml-auto inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10"
                    onClick={() => onUnhideKey?.(key)}
                  >
                    <Eye className="h-3 w-3" />
                    Show
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
