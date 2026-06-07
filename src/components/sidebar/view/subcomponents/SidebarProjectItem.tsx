import { Bot, Check, ChevronDown, ChevronRight, Edit3, Folder, FolderOpen, Star, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import { useAgentHealth } from '../../../../hooks/useAgentHealth';
import type { Project, ProjectSession, LLMProvider } from '../../../../types/app';
import type { MCPServerStatus, SessionWithProvider } from '../../types/types';
import { getTaskIndicatorStatus } from '../../utils/utils';

import TaskIndicator from './TaskIndicator';
import SidebarProjectSessions from './SidebarProjectSessions';

type SidebarProjectItemProps = {
  project: Project;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isExpanded: boolean;
  isDeleting: boolean;
  isStarred: boolean;
  editingProject: string | null;
  editingName: string;
  sessions: SessionWithProvider[];
  initialSessionsLoaded: boolean;
  isLoadingMoreSessions: boolean;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  tasksEnabled: boolean;
  mcpServerStatus: MCPServerStatus;
  onEditingNameChange: (name: string) => void;
  onToggleProject: (projectName: string) => void;
  onProjectSelect: (project: Project) => void;
  onToggleStarProject: (projectName: string) => void;
  onStartEditingProject: (project: Project) => void;
  onCancelEditingProject: () => void;
  onSaveProjectName: (projectName: string) => void;
  onDeleteProject: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: LLMProvider,
  ) => void;
  onLoadMoreSessions: (projectId: string) => void;
  onNewSession: (project: Project) => void;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  t: TFunction;
};

const getSessionCountDisplay = (project: Project, sessions: SessionWithProvider[]): string => {
  const total = Number(project.sessionMeta?.total ?? sessions.length);
  return String(total);
};

export default function SidebarProjectItem({
  project,
  selectedProject,
  selectedSession,
  isExpanded,
  isDeleting,
  isStarred,
  editingProject,
  editingName,
  sessions,
  initialSessionsLoaded,
  isLoadingMoreSessions,
  currentTime,
  editingSession,
  editingSessionName,
  tasksEnabled,
  mcpServerStatus,
  onEditingNameChange,
  onToggleProject,
  onProjectSelect,
  onToggleStarProject,
  onStartEditingProject,
  onCancelEditingProject,
  onSaveProjectName,
  onDeleteProject,
  onSessionSelect,
  onDeleteSession,
  onLoadMoreSessions,
  onNewSession,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  t,
}: SidebarProjectItemProps) {
  // Project identity is tracked by the DB-assigned `projectId` everywhere
  // after the projectName → projectId migration.
  const isSelected = selectedProject?.projectId === project.projectId;
  const isEditing = editingProject === project.projectId;
  const totalSessionCount = Number(project.sessionMeta?.total ?? sessions.length);
  const sessionCountDisplay = getSessionCountDisplay(project, sessions);
  const sessionCountLabel = `${sessionCountDisplay} session${totalSessionCount === 1 ? '' : 's'}`;
  const taskStatus = getTaskIndicatorStatus(project, mcpServerStatus);

  // Live agent health (actively polled, zombie-checked). Shared singleton poller.
  const agentHealth = useAgentHealth();

  const toggleProject = () => onToggleProject(project.projectId);
  const toggleStarProject = () => onToggleStarProject(project.projectId);

  const saveProjectName = () => {
    onSaveProjectName(project.projectId);
  };

  const selectAndToggleProject = () => {
    if (selectedProject?.projectId !== project.projectId) {
      onProjectSelect(project);
    }

    toggleProject();
  };

  const isFleetProject = project.projectId.startsWith('fleet:');
  const isFleetOffline = isFleetProject && !project.fleetAlive;
  // Alive but no control plane — transcript is readable, sending is blocked.
  const isFleetReadOnly = isFleetProject && Boolean(project.fleetAlive) && project.fleetControllable === false;

  // agent-discovery states
  const isAgentProject = project.projectId.startsWith('agent:');
  const agentState = project.agentState as 'ONLINE' | 'CONTROLLABLE' | 'DISCONNECTED' | undefined;
  const isAgentDisconnected = isAgentProject && agentState === 'DISCONNECTED';
  const isAgentReadOnly = isAgentProject && agentState === 'ONLINE' && !project.agentWritable;
  const isAgentControllable = isAgentProject && (agentState === 'CONTROLLABLE' || (agentState === 'ONLINE' && Boolean(project.agentWritable)));

  // An agent — whether a live channel agent (agent:) OR a fleet-roster agent
  // (fleet:) — is a single, non-expandable leaf: clicking opens it straight away.
  // NEITHER renders as a folder (no expand, no session list, no "new session"
  // dropdown). Channel agents get live health; fleet agents use the roster state.
  const isAgentLeaf = isAgentProject || isFleetProject;
  if (isAgentLeaf) {
    const agentId = isAgentProject ? project.projectId.slice('agent:'.length) : '';
    const health = isAgentProject ? (agentHealth[agentId] || null) : null;

    // Unified status -> dot colour, icon colour, single badge, faded-when-offline.
    let dotClass = 'bg-gray-400';
    let iconClass = 'text-muted-foreground';
    let badgeText = '';
    let badgeClass = 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400';
    let faded = false;
    const GREEN = 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
    const BLUE = 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400';
    const AMBER = 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
    const GRAY = 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400';

    if (isAgentProject) {
      // Working = channel live AND a real backing process (zombie-checked daemon-side).
      const working = health ? health.working : isAgentControllable;
      const disconnected = health ? (health.state === 'DISCONNECTED' || !health.alive) : isAgentDisconnected;
      if (working) {
        dotClass = 'bg-green-500'; iconClass = 'text-green-600 dark:text-green-400';
        badgeText = isAgentReadOnly ? 'live' : 'working'; badgeClass = GREEN;
      } else if (disconnected) {
        dotClass = 'bg-gray-400'; iconClass = 'text-muted-foreground'; badgeText = 'disconnected'; badgeClass = GRAY; faded = true;
      } else {
        dotClass = 'bg-amber-500'; iconClass = 'text-amber-600 dark:text-amber-400'; badgeText = 'not responding'; badgeClass = AMBER;
      }
    } else {
      // Fleet roster agent: alive+controllable -> working; alive only -> read-only; else offline.
      if (!project.fleetAlive) {
        dotClass = 'bg-gray-400'; iconClass = 'text-muted-foreground'; badgeText = 'offline'; badgeClass = GRAY; faded = true;
      } else if (project.fleetControllable) {
        dotClass = 'bg-green-500'; iconClass = 'text-green-600 dark:text-green-400'; badgeText = 'working'; badgeClass = GREEN;
      } else {
        dotClass = 'bg-blue-500'; iconClass = 'text-blue-600 dark:text-blue-400'; badgeText = 'read-only'; badgeClass = BLUE;
      }
    }

    // Last-seen line (channel agents only — sourced from live health).
    const lastSeenSec = health?.last_seen;
    const agoSec = lastSeenSec ? Math.max(0, Math.floor(currentTime.getTime() / 1000 - lastSeenSec)) : null;
    const lastSeenText =
      agoSec == null ? null
      : agoSec < 60 ? `${agoSec}s ago`
      : agoSec < 3600 ? `${Math.floor(agoSec / 60)}m ago`
      : agoSec < 86400 ? `${Math.floor(agoSec / 3600)}h ago`
      : `${Math.floor(agoSec / 86400)}d ago`;
    const statusTitle = `${badgeText}${lastSeenText ? ` · last seen ${lastSeenText}` : ''}`;

    const leafCwd = isAgentProject
      ? (project.agentCwd || '')
      : (project.fullPath && project.fullPath !== project.displayName ? project.fullPath : '');

    // Resolve the agent's session id (the leaf never expands to load sessions[],
    // so prefer explicit ids from the project payload).
    const sessionId = isAgentProject
      ? (project.agentSessionId || sessions[0]?.id || project.sessions?.[0]?.id || null)
      : (sessions[0]?.id || project.sessions?.[0]?.id || null);
    const rawSession = sessions[0] ?? project.sessions?.[0] ?? null;
    const leafSession: SessionWithProvider | null = sessionId
      ? { ...(rawSession ?? {}), id: sessionId, __provider: 'claude' as LLMProvider }
      : null;

    const openAgent = () => {
      onProjectSelect(project);
      if (leafSession) {
        onSessionSelect(leafSession, project.projectId);
      }
    };

    return (
      <div className={cn('md:space-y-1', faded && 'opacity-70')}>
        <Button
          variant="ghost"
          className={cn(
            'flex h-auto w-full items-center justify-between gap-2 p-2 font-normal hover:bg-accent/50',
            isSelected && 'bg-accent text-accent-foreground',
          )}
          onClick={openAgent}
          title={leafCwd || project.displayName}
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <Bot className={cn('h-4 w-4 flex-shrink-0', iconClass)} />
            <div className="min-w-0 flex-1 text-left">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-sm font-semibold text-foreground">{project.displayName}</span>
                {badgeText && (
                  <span className={cn('flex-shrink-0 rounded px-1 py-0.5 text-[10px] font-medium leading-none', badgeClass)}>
                    {badgeText}
                  </span>
                )}
              </div>
              {(lastSeenText || leafCwd) && (
                <div className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                  {lastSeenText && <span className="flex-shrink-0">{lastSeenText}</span>}
                  {lastSeenText && leafCwd && <span className="flex-shrink-0 opacity-40">·</span>}
                  {leafCwd && <span className="truncate" title={leafCwd}>{leafCwd}</span>}
                </div>
              )}
            </div>
          </div>
          <span className={cn('h-2 w-2 flex-shrink-0 rounded-full', dotClass)} title={statusTitle} />
        </Button>
      </div>
    );
  }

  return (
    <div className={cn('md:space-y-1', isDeleting && 'opacity-50 pointer-events-none', isFleetOffline && 'opacity-70', isAgentDisconnected && 'opacity-70')}>
      <div className="md:group group">
        <div className="md:hidden">
          <div
            className={cn(
              'p-3 mx-3 my-1 rounded-lg bg-card border border-border/50 active:scale-[0.98] transition-all duration-150',
              isSelected && 'bg-primary/5 border-primary/20',
              isStarred &&
                !isSelected &&
                'bg-yellow-50/50 dark:bg-yellow-900/5 border-yellow-200/30 dark:border-yellow-800/30',
            )}
            onClick={toggleProject}
          >
            <div className="flex items-center justify-between">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <div
                  className={cn(
                    'w-8 h-8 rounded-lg flex items-center justify-center transition-colors',
                    isExpanded ? 'bg-primary/10' : 'bg-muted',
                  )}
                >
                  {isExpanded ? (
                    <FolderOpen className="h-4 w-4 text-primary" />
                  ) : (
                    <Folder className="h-4 w-4 text-muted-foreground" />
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  {isEditing ? (
                    <input
                      type="text"
                      value={editingName}
                      onChange={(event) => onEditingNameChange(event.target.value)}
                      className="w-full rounded-lg border-2 border-primary/40 bg-background px-3 py-2 text-sm text-foreground shadow-sm transition-all duration-200 focus:border-primary focus:shadow-md focus:outline-none"
                      placeholder={t('projects.projectNamePlaceholder')}
                      autoFocus
                      autoComplete="off"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          saveProjectName();
                        }

                        if (event.key === 'Escape') {
                          onCancelEditingProject();
                        }
                      }}
                      style={{
                        fontSize: '16px',
                        WebkitAppearance: 'none',
                        borderRadius: '8px',
                      }}
                    />
                  ) : (
                    <>
                      <div className="flex min-w-0 flex-1 items-center justify-between">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <h3 className="truncate text-sm font-medium text-foreground">{project.displayName}</h3>
                          {isFleetProject && (
                            <span
                              className={cn(
                                'flex-shrink-0 rounded px-1 py-0.5 text-[10px] font-medium leading-none',
                                project.fleetAlive
                                  ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                                  : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
                              )}
                            >
                              {project.fleetAlive ? 'online' : 'offline'}
                            </span>
                          )}
                          {isFleetReadOnly && (
                            <span className="flex-shrink-0 rounded px-1 py-0.5 text-[10px] font-medium leading-none bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                              read-only
                            </span>
                          )}
                          {isAgentControllable && (
                            <span className="flex-shrink-0 rounded px-1 py-0.5 text-[10px] font-medium leading-none bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                              connected
                            </span>
                          )}
                          {isAgentReadOnly && (
                            <span className="flex-shrink-0 rounded px-1 py-0.5 text-[10px] font-medium leading-none bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                              read-only
                            </span>
                          )}
                          {isAgentDisconnected && (
                            <span className="flex-shrink-0 rounded px-1 py-0.5 text-[10px] font-medium leading-none bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                              disconnected
                            </span>
                          )}
                        </div>
                        {tasksEnabled && (
                          <TaskIndicator
                            status={taskStatus}
                            size="xs"
                            className="ml-2 hidden flex-shrink-0 md:inline-flex"
                          />
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">{sessionCountLabel}</p>
                    </>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1">
                {isEditing ? (
                  <>
                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-500 shadow-sm transition-all duration-150 active:scale-90 active:shadow-none dark:bg-green-600"
                      onClick={(event) => {
                        event.stopPropagation();
                        saveProjectName();
                      }}
                    >
                      <Check className="h-4 w-4 text-white" />
                    </button>
                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-500 shadow-sm transition-all duration-150 active:scale-90 active:shadow-none dark:bg-gray-600"
                      onClick={(event) => {
                        event.stopPropagation();
                        onCancelEditingProject();
                      }}
                    >
                      <X className="h-4 w-4 text-white" />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className={cn(
                        'w-8 h-8 rounded-lg flex items-center justify-center active:scale-90 transition-all duration-150 border',
                        isStarred
                          ? 'bg-yellow-500/10 dark:bg-yellow-900/30 border-yellow-200 dark:border-yellow-800'
                          : 'bg-gray-500/10 dark:bg-gray-900/30 border-gray-200 dark:border-gray-800',
                      )}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleStarProject();
                      }}
                      title={isStarred ? t('tooltips.removeFromFavorites') : t('tooltips.addToFavorites')}
                    >
                      <Star
                        className={cn(
                          'w-4 h-4 transition-colors',
                          isStarred
                            ? 'text-yellow-600 dark:text-yellow-400 fill-current'
                            : 'text-gray-600 dark:text-gray-400',
                        )}
                      />
                    </button>

                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-lg border border-red-200 bg-red-500/10 active:scale-90 dark:border-red-800 dark:bg-red-900/30"
                      onClick={(event) => {
                        event.stopPropagation();
                        onDeleteProject(project);
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-red-600 dark:text-red-400" />
                    </button>

                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 active:scale-90 dark:border-primary/30 dark:bg-primary/20"
                      onClick={(event) => {
                        event.stopPropagation();
                        onStartEditingProject(project);
                      }}
                    >
                      <Edit3 className="h-4 w-4 text-primary" />
                    </button>

                    <div className="flex h-6 w-6 items-center justify-center rounded-md bg-muted/30">
                      {isExpanded ? (
                        <ChevronDown className="h-3 w-3 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-3 w-3 text-muted-foreground" />
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        <Button
          variant="ghost"
          className={cn(
            'hidden md:flex w-full justify-between p-2 h-auto font-normal hover:bg-accent/50',
            isSelected && 'bg-accent text-accent-foreground',
            isStarred &&
              !isSelected &&
              'bg-yellow-50/50 dark:bg-yellow-900/10 hover:bg-yellow-100/50 dark:hover:bg-yellow-900/20',
          )}
          onClick={selectAndToggleProject}
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {isExpanded ? (
              <FolderOpen className="h-4 w-4 flex-shrink-0 text-primary" />
            ) : (
              <Folder className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1 text-left">
              {isEditing ? (
                <div className="space-y-1">
                  <input
                    type="text"
                    value={editingName}
                    onChange={(event) => onEditingNameChange(event.target.value)}
                    className="w-full rounded border border-border bg-background px-2 py-1 text-sm text-foreground focus:ring-2 focus:ring-primary/20"
                    placeholder={t('projects.projectNamePlaceholder')}
                    autoFocus
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        saveProjectName();
                      }
                      if (event.key === 'Escape') {
                        onCancelEditingProject();
                      }
                    }}
                  />
                  <div className="truncate text-xs text-muted-foreground" title={project.fullPath}>
                    {project.fullPath}
                  </div>
                </div>
              ) : (
                <div>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <div className="truncate text-sm font-semibold text-foreground" title={project.displayName}>
                      {project.displayName}
                    </div>
                    {isFleetProject && (
                      <span
                        className={cn(
                          'flex-shrink-0 rounded px-1 py-0.5 text-[10px] font-medium leading-none',
                          project.fleetAlive
                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                            : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
                        )}
                      >
                        {project.fleetAlive ? 'online' : 'offline'}
                      </span>
                    )}
                    {isFleetReadOnly && (
                      <span className="flex-shrink-0 rounded px-1 py-0.5 text-[10px] font-medium leading-none bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                        read-only
                      </span>
                    )}
                    {isAgentControllable && (
                      <span className="flex-shrink-0 rounded px-1 py-0.5 text-[10px] font-medium leading-none bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                        connected
                      </span>
                    )}
                    {isAgentReadOnly && (
                      <span className="flex-shrink-0 rounded px-1 py-0.5 text-[10px] font-medium leading-none bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                        read-only
                      </span>
                    )}
                    {isAgentDisconnected && (
                      <span className="flex-shrink-0 rounded px-1 py-0.5 text-[10px] font-medium leading-none bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                        disconnected
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {sessionCountDisplay}
                    {project.fullPath !== project.displayName && (
                      <span className="ml-1 opacity-60" title={project.fullPath}>
                        {' - '}
                        {project.fullPath.length > 25 ? `...${project.fullPath.slice(-22)}` : project.fullPath}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-shrink-0 items-center gap-1">
            {isEditing ? (
              <>
                <div
                  className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-green-600 transition-colors hover:bg-green-50 hover:text-green-700 dark:hover:bg-green-900/20"
                  onClick={(event) => {
                    event.stopPropagation();
                    saveProjectName();
                  }}
                >
                  <Check className="h-3 w-3" />
                </div>
                <div
                  className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-700 dark:hover:bg-gray-800"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCancelEditingProject();
                  }}
                >
                  <X className="h-3 w-3" />
                </div>
              </>
            ) : (
              <>
                <div
                  className={cn(
                    'w-6 h-6 opacity-0 group-hover:opacity-100 transition-all duration-200 flex items-center justify-center rounded cursor-pointer touch:opacity-100',
                    isStarred ? 'hover:bg-yellow-50 dark:hover:bg-yellow-900/20 opacity-100' : 'hover:bg-accent',
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleStarProject();
                  }}
                  title={isStarred ? t('tooltips.removeFromFavorites') : t('tooltips.addToFavorites')}
                >
                  <Star
                    className={cn(
                      'w-3 h-3 transition-colors',
                      isStarred
                        ? 'text-yellow-600 dark:text-yellow-400 fill-current'
                        : 'text-muted-foreground',
                    )}
                  />
                </div>
                <div
                  className="touch:opacity-100 flex h-6 w-6 cursor-pointer items-center justify-center rounded opacity-0 transition-all duration-200 hover:bg-accent group-hover:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation();
                    onStartEditingProject(project);
                  }}
                  title={t('tooltips.renameProject')}
                >
                  <Edit3 className="h-3 w-3" />
                </div>
                <div
                  className="touch:opacity-100 flex h-6 w-6 cursor-pointer items-center justify-center rounded opacity-0 transition-all duration-200 hover:bg-red-50 group-hover:opacity-100 dark:hover:bg-red-900/20"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDeleteProject(project);
                  }}
                  title={t('tooltips.deleteProject')}
                >
                  <Trash2 className="h-3 w-3 text-red-600 dark:text-red-400" />
                </div>
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
                )}
              </>
            )}
          </div>
        </Button>
      </div>

      <SidebarProjectSessions
        project={project}
        isExpanded={isExpanded}
        sessions={sessions}
        selectedSession={selectedSession}
        initialSessionsLoaded={initialSessionsLoaded}
        hasMoreSessions={Boolean(project.sessionMeta?.hasMore)}
        isLoadingMoreSessions={isLoadingMoreSessions}
        currentTime={currentTime}
        editingSession={editingSession}
        editingSessionName={editingSessionName}
        onEditingSessionNameChange={onEditingSessionNameChange}
        onStartEditingSession={onStartEditingSession}
        onCancelEditingSession={onCancelEditingSession}
        onSaveEditingSession={onSaveEditingSession}
        onProjectSelect={onProjectSelect}
        onSessionSelect={onSessionSelect}
        onDeleteSession={onDeleteSession}
        onLoadMoreSessions={onLoadMoreSessions}
        onNewSession={onNewSession}
        t={t}
      />
    </div>
  );
}
