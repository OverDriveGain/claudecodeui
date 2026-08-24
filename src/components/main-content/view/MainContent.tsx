import React, { useEffect, useState } from 'react';

import ChatInterface from '../../chat/view/ChatInterface';
import CanvasView from '../../canvas/CanvasView';
import FileTree from '../../file-tree/view/FileTree';
import StandaloneShell from '../../standalone-shell/view/StandaloneShell';
import GitPanel from '../../git-panel/view/GitPanel';
import PluginTabContent from '../../plugins/view/PluginTabContent';
import type { MainContentProps } from '../types/types';
import { useTaskMaster } from '../../../contexts/TaskMasterContext';
import { usePaletteOpsRegister } from '../../../contexts/PaletteOpsContext';
import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useEditorSidebar } from '../../code-editor/hooks/useEditorSidebar';
import EditorSidebar from '../../code-editor/view/EditorSidebar';
import type { Project } from '../../../types/app';
import { TaskMasterPanel } from '../../task-master';

import MainContentHeader from './subcomponents/MainContentHeader';
import MainContentStateView from './subcomponents/MainContentStateView';
import ErrorBoundary from './ErrorBoundary';

type TaskMasterContextValue = {
  currentProject?: Project | null;
  setCurrentProject?: ((project: Project) => void) | null;
};

type TasksSettingsContextValue = {
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  isTaskMasterReady: boolean | null;
};

function MainContent({
  selectedProject,
  selectedSession,
  activeTab,
  setActiveTab,
  ws,
  sendMessage,
  latestMessage,
  isMobile,
  agentViewMode = false,
  onMenuClick,
  isLoading,
  onInputFocusChange,
  onSessionActive,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  processingSessions,
  onNavigateToSession,
  onShowSettings,
  externalMessageUpdate,
  newSessionTrigger,
}: MainContentProps) {
  const { preferences } = useUiPreferences();
  const { autoExpandTools, showRawParameters, showThinking, autoScrollToBottom, sendByCtrlEnter } = preferences;

  const { currentProject, setCurrentProject } = useTaskMaster() as TaskMasterContextValue;
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings() as TasksSettingsContextValue;

  const shouldShowTasksTab = Boolean(tasksEnabled && isTaskMasterInstalled);

  // Files tab is kept MOUNTED (hidden via CSS) once first visited, like the chat
  // tab above — unmounting it on tab switch threw away the expanded-folders and
  // drill-down state, so returning to Files always restarted at the tree root.
  // Reset on project change so a new project gets a fresh (lazy) mount.
  const [filesTabVisited, setFilesTabVisited] = useState(false);
  useEffect(() => {
    if (activeTab === 'files') setFilesTabVisited(true);
  }, [activeTab]);
  useEffect(() => {
    setFilesTabVisited(false);
  }, [selectedProject?.projectId]);

  const {
    editingFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
  } = useEditorSidebar({
    selectedProject,
    isMobile,
  });

  useEffect(() => {
    // Identify projects by DB `projectId`; the TaskMaster context uses the
    // same identifier to key its internal maps.
    const selectedProjectId = selectedProject?.projectId;
    const currentProjectId = currentProject?.projectId;

    if (selectedProject && selectedProjectId !== currentProjectId) {
      setCurrentProject?.(selectedProject);
    }
  }, [selectedProject, currentProject?.projectId, setCurrentProject]);

  useEffect(() => {
    if (!shouldShowTasksTab && activeTab === 'tasks') {
      setActiveTab('chat');
    }
  }, [shouldShowTasksTab, activeTab, setActiveTab]);

  // A live agent has no Shell tab; if one is opened while Shell is active, fall back
  // to Chat so the user isn't left on a now-hidden, blank tab.
  useEffect(() => {
    if (selectedProject?.isRemoteAgent && activeTab === 'shell') {
      setActiveTab('chat');
    }
  }, [selectedProject?.isRemoteAgent, activeTab, setActiveTab]);

  usePaletteOpsRegister({
    openFile: (filePath: string) => {
      setActiveTab('files');
      handleFileOpen(filePath);
    },
  });

  if (isLoading) {
    return <MainContentStateView mode="loading" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  if (!selectedProject) {
    return <MainContentStateView mode="empty" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  // BTI single-window app: Canvas panes on top, Chat below. No tab bar, no
  // sidebar, no files/shell/git/editor — just the two surfaces the customer uses.
  return (
    <div className="flex h-full flex-col">
      {/* Phones: canvas collapses to a slim results bar (auto height) and the
          conversation takes the rest. Desktop keeps the 60/40 canvas/chat split. */}
      <div className="min-h-0 shrink-0 overflow-hidden border-border sm:flex-[3] sm:border-b">
        <CanvasView selectedProject={selectedProject} />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden sm:flex-[2]">
        <ErrorBoundary showDetails>
          <ChatInterface
            selectedProject={selectedProject}
            selectedSession={selectedSession}
            ws={ws}
            sendMessage={sendMessage}
            latestMessage={latestMessage}
            onFileOpen={handleFileOpen}
            onInputFocusChange={onInputFocusChange}
            onSessionActive={onSessionActive}
            onSessionInactive={onSessionInactive}
            onSessionProcessing={onSessionProcessing}
            onSessionNotProcessing={onSessionNotProcessing}
            processingSessions={processingSessions}
            onNavigateToSession={onNavigateToSession}
            onShowSettings={onShowSettings}
            autoExpandTools={autoExpandTools}
            showRawParameters={showRawParameters}
            showThinking={showThinking}
            autoScrollToBottom={autoScrollToBottom}
            sendByCtrlEnter={sendByCtrlEnter}
            externalMessageUpdate={externalMessageUpdate}
            newSessionTrigger={newSessionTrigger}
            onShowAllTasks={null}
          />
        </ErrorBoundary>
      </div>
    </div>
  );
}

export default React.memo(MainContent);
