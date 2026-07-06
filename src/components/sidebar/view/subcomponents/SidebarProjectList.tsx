import { useEffect } from 'react';
import type { TFunction } from 'i18next';

import type { LoadingProgress, Project, ProjectSession, LLMProvider } from '../../../../types/app';
import type { MCPServerStatus, SessionWithProvider } from '../../types/types';

import SidebarProjectItem from './SidebarProjectItem';
import SidebarProjectsState from './SidebarProjectsState';
import SidebarSessionItem from './SidebarSessionItem';

export type SidebarProjectListProps = {
  // Which list this instance renders:
  //  - 'projects'      → folder-grouped projects with nested sessions
  //  - 'conversations' → a flat, most-recent-first list of every session (like
  //                      claude.ai/code's Recents)
  //  - 'agents'        → the remote-control agents (their own top-level tab)
  listKind?: 'projects' | 'conversations' | 'agents';
  projects: Project[];
  filteredProjects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isLoading: boolean;
  loadingProgress: LoadingProgress | null;
  expandedProjects: Set<string>;
  editingProject: string | null;
  editingName: string;
  initialSessionsLoaded: Set<string>;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  deletingProjects: Set<string>;
  tasksEnabled: boolean;
  mcpServerStatus: MCPServerStatus;
  getProjectSessions: (project: Project) => SessionWithProvider[];
  onLoadMoreSessions: (projectId: string) => void;
  loadingMoreProjects: Set<string>;
  isProjectStarred: (projectName: string) => boolean;
  onEditingNameChange: (value: string) => void;
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
  onNewSession: (project: Project) => void;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  t: TFunction;
};

export default function SidebarProjectList({
  listKind = 'projects',
  projects,
  filteredProjects,
  selectedProject,
  selectedSession,
  isLoading,
  loadingProgress,
  expandedProjects,
  editingProject,
  editingName,
  initialSessionsLoaded,
  currentTime,
  editingSession,
  editingSessionName,
  deletingProjects,
  tasksEnabled,
  mcpServerStatus,
  getProjectSessions,
  onLoadMoreSessions,
  loadingMoreProjects,
  isProjectStarred,
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
  onNewSession,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  t,
}: SidebarProjectListProps) {
  const state = (
    <SidebarProjectsState
      isLoading={isLoading}
      loadingProgress={loadingProgress}
      projectsCount={projects.length}
      filteredProjectsCount={filteredProjects.length}
      t={t}
    />
  );

  useEffect(() => {
    let baseTitle = 'MyMu';
    const displayName = selectedProject?.displayName?.trim();
    if (displayName) {
      baseTitle = `${displayName} - ${baseTitle}`;
    }
    document.title = baseTitle;
  }, [selectedProject]);

  const showProjects = !isLoading && projects.length > 0 && filteredProjects.length > 0;

  // React key + per-project state lookups all use the DB `projectId` so they remain
  // stable across renames and session changes.
  const renderItem = (project: Project) => (
    <SidebarProjectItem
      key={project.projectId}
      project={project}
      selectedProject={selectedProject}
      selectedSession={selectedSession}
      isExpanded={expandedProjects.has(project.projectId)}
      isDeleting={deletingProjects.has(project.projectId)}
      isStarred={isProjectStarred(project.projectId)}
      editingProject={editingProject}
      editingName={editingName}
      sessions={getProjectSessions(project)}
      initialSessionsLoaded={initialSessionsLoaded.has(project.projectId)}
      isLoadingMoreSessions={loadingMoreProjects.has(project.projectId)}
      currentTime={currentTime}
      editingSession={editingSession}
      editingSessionName={editingSessionName}
      tasksEnabled={tasksEnabled}
      mcpServerStatus={mcpServerStatus}
      onEditingNameChange={onEditingNameChange}
      onToggleProject={onToggleProject}
      onProjectSelect={onProjectSelect}
      onToggleStarProject={onToggleStarProject}
      onStartEditingProject={onStartEditingProject}
      onCancelEditingProject={onCancelEditingProject}
      onSaveProjectName={onSaveProjectName}
      onDeleteProject={onDeleteProject}
      onSessionSelect={onSessionSelect}
      onDeleteSession={onDeleteSession}
      onLoadMoreSessions={onLoadMoreSessions}
      onNewSession={onNewSession}
      onEditingSessionNameChange={onEditingSessionNameChange}
      onStartEditingSession={onStartEditingSession}
      onCancelEditingSession={onCancelEditingSession}
      onSaveEditingSession={onSaveEditingSession}
      t={t}
    />
  );

  // Remote-control agents have their own top-level tab, so they are kept out of the
  // conversations/projects list and rendered on their own when listKind === 'agents'.
  const isAgent = (project: Project) =>
    Boolean(project.isRemoteAgent) || project.projectId.startsWith('remote:');

  if (listKind === 'agents') {
    const agentProjects = filteredProjects.filter(isAgent);
    return (
      <div className="pb-safe-area-inset-bottom md:space-y-1">
        {agentProjects.length > 0 ? (
          agentProjects.map(renderItem)
        ) : (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground md:py-8">
            {t('sidebar.noAgents', { defaultValue: 'No agents found.' })}
          </div>
        )}
      </div>
    );
  }

  const conversationProjects = filteredProjects.filter((project) => !isAgent(project));

  // Conversations tab: a single flat list of every session across all (non-agent)
  // projects, most-recently-used first — the same shape claude.ai/code shows in its
  // Recents panel, instead of a tree of collapsed project folders.
  if (listKind === 'conversations') {
    const sessionTime = (session: SessionWithProvider): number => {
      const raw =
        (session.updated_at as string) ||
        (session.lastActivity as string) ||
        (session.createdAt as string) ||
        (session.created_at as string) ||
        '';
      const t = new Date(raw).getTime();
      return Number.isNaN(t) ? 0 : t;
    };

    const rows = conversationProjects
      .flatMap((project) =>
        getProjectSessions(project).map((session) => ({ project, session })),
      )
      .sort((a, b) => sessionTime(b.session) - sessionTime(a.session));

    if (!showProjects) {
      return <div className="pb-safe-area-inset-bottom md:space-y-1">{state}</div>;
    }

    return (
      <div className="pb-safe-area-inset-bottom md:space-y-1">
        {rows.length > 0 ? (
          rows.map(({ project, session }) => (
            <SidebarSessionItem
              key={`${project.projectId}:${session.id}`}
              project={project}
              session={session}
              selectedSession={selectedSession}
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
              t={t}
            />
          ))
        ) : (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground md:py-8">
            {t('sidebar.noConversations', { defaultValue: 'No conversations yet.' })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="pb-safe-area-inset-bottom md:space-y-1">
      {!showProjects ? state : conversationProjects.map(renderItem)}
    </div>
  );
}
