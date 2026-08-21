import type { TFunction } from 'i18next';
import { MessageSquare } from 'lucide-react';

import { cn } from '../../../../lib/utils';
import type { Project, ProjectSession } from '../../../../types/app';
import type { SessionWithProvider } from '../../types/types';
import { getSessionDate, getSessionName } from '../../utils/utils';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';

type SidebarConversationsListProps = {
  projects: Project[];
  getProjectSessions: (project: Project) => SessionWithProvider[];
  selectedSession: ProjectSession | null;
  processingIds: ReadonlySet<string>;
  onSessionSelect: (session: SessionWithProvider, projectId: string) => void;
  currentTime: Date;
  // Optional client-side title filter for partial (<2 char) queries — the real
  // content search takes over at >=2 chars in SidebarContent.
  filter?: string;
  t: TFunction;
};

/** Compact relative age for a conversation row: <1m, Xm, Xhr, Xd. */
const formatCompactAge = (date: Date, now: Date): string => {
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const minutes = Math.floor(Math.max(0, now.getTime() - date.getTime()) / (1000 * 60));
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}hr`;
  return `${Math.floor(hours / 24)}d`;
};

/**
 * MYMU: the Conversations tab (FORK.md F1) — a flat, newest-first list of every
 * conversation across all (non-agent) projects, click to open. Live agents keep
 * their own tab, so they are excluded here. This is what the Conversations tab
 * shows with an empty search box; typing >=2 chars swaps in the content search.
 */
export default function SidebarConversationsList({
  projects,
  getProjectSessions,
  selectedSession,
  processingIds,
  onSessionSelect,
  currentTime,
  filter,
  t,
}: SidebarConversationsListProps) {
  const needle = (filter ?? '').trim().toLowerCase();
  const rows: Array<{ session: SessionWithProvider; project: Project }> = [];
  for (const project of projects) {
    if (project.isRemoteAgent) {
      continue;
    }
    for (const session of getProjectSessions(project)) {
      if (needle && !getSessionName(session, t).toLowerCase().includes(needle)) {
        continue;
      }
      rows.push({ session, project });
    }
  }
  rows.sort((a, b) => getSessionDate(b.session).getTime() - getSessionDate(a.session).getTime());

  if (rows.length === 0) {
    return (
      <div className="px-4 py-12 text-center md:py-8">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
          <MessageSquare className="h-6 w-6 text-muted-foreground" />
        </div>
        <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">
          {t('conversations.emptyTitle', 'No conversations yet')}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t('conversations.emptyDescription', 'Your conversations across all projects will appear here.')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-0.5 px-2">
      {rows.map(({ session, project }) => {
        const isSelected = selectedSession?.id === session.id;
        const isProcessing = processingIds.has(session.id);
        const provider = session.__provider ?? session.provider ?? 'claude';
        const age = formatCompactAge(getSessionDate(session), currentTime);
        return (
          <button
            key={`${project.projectId}-${session.id}`}
            type="button"
            className={cn(
              'w-full rounded-md px-2 py-2 text-left transition-colors',
              isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
            )}
            onClick={() => onSessionSelect(session, project.projectId)}
          >
            <div className="flex items-center gap-1.5">
              {isProcessing ? (
                <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border border-primary border-t-transparent" />
              ) : (
                <SessionProviderLogo provider={provider} className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="truncate text-xs font-normal text-foreground">
                {getSessionName(session, t)}
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 pl-5 text-[10px] text-muted-foreground">
              <span className="truncate">{project.displayName}</span>
              {age && (
                <>
                  <span className="shrink-0">·</span>
                  <span className="shrink-0 tabular-nums">{age}</span>
                </>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
