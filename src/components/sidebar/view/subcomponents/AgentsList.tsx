// MYMU: the live-agents tab (FORK.md F1) — every row is one running `claude
// --remote-control` session surfaced by the relay; clicking opens its
// conversation through the exact same session-select flow project sessions use.
import { useMemo } from 'react';
import { EyeOff } from 'lucide-react';
import type { TFunction } from 'i18next';

import type { Project, ProjectSession } from '../../../../types/app';
import type { SessionWithProvider } from '../../types/types';
import { cn } from '../../../../lib/utils';

type AgentsListProps = {
  agents: Project[];
  selectedSession: ProjectSession | null;
  /** Session ids with an active run — drives the working spinner. */
  processingIds: ReadonlySet<string>;
  onSessionSelect: (session: SessionWithProvider, projectId: string) => void;
  onHideAgent?: (agent: Project) => void;
  t: TFunction;
};

export default function AgentsList({
  agents,
  selectedSession,
  processingIds,
  onSessionSelect,
  onHideAgent,
  t,
}: AgentsListProps) {
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

  if (agents.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-sm text-muted-foreground">
        {t('agents.empty', { defaultValue: 'No agents visible' })}
      </p>
    );
  }

  return (
    <div className="px-2 pb-2">
      <div className="space-y-0.5">
        {sorted.map((agent) => {
          const session = agent.sessions?.[0];
          if (!session) return null;
          const isSelected = selectedSession?.id === session.id;
          const isWorking = processingIds.has(session.id);
          return (
            <div
              key={agent.projectId}
              className={cn(
                'group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer',
                isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
              )}
              onClick={() => onSessionSelect({ ...session, provider: 'claude' } as SessionWithProvider, agent.projectId)}
            >
              {/* Liveliness: spinner while working, dot otherwise */}
              {isWorking ? (
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
              {agent.remoteAccount ? (
                <span className="ml-auto shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                  {agent.remoteAccount}
                </span>
              ) : null}
              {onHideAgent ? (
                <button
                  type="button"
                  title={t('agents.hide', { defaultValue: 'Remove from view' })}
                  className={cn(
                    'shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100',
                    agent.remoteAccount ? '' : 'ml-auto',
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
          );
        })}
      </div>
    </div>
  );
}
