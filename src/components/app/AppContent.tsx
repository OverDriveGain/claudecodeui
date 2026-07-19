import { useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import Sidebar from '../sidebar/view/Sidebar';
import MainContent from '../main-content/view/MainContent';
import CommandPalette from '../command-palette/CommandPalette';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { useAuth } from '../auth/context/AuthContext';
import { PaletteOpsProvider, usePaletteOpsRegister } from '../../contexts/PaletteOpsContext';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { useSessionProtection } from '../../hooks/useSessionProtection';
import { useProjectsState } from '../../hooks/useProjectsState';
import type { SessionWithProvider } from '../sidebar/types/types';

export default function AppContent() {
  return (
    <PaletteOpsProvider>
      <AppContentInner />
    </PaletteOpsProvider>
  );
}

function AppContentInner() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const { t } = useTranslation('common');
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { ws, sendMessage, latestMessage, isConnected } = useWebSocket();
  const { user } = useAuth();
  // Agent-view share token: the whole app collapses to one agent's conversation
  // (+ its files) — no sidebar, no palette. Everything else is already invisible
  // server-side; this is the matching focused layout.
  const agentViewMode = Boolean(user?.agentView);
  const wasConnectedRef = useRef(false);

  const {
    activeSessions,
    processingSessions,
    markSessionAsActive,
    markSessionAsInactive,
    markSessionAsProcessing,
    markSessionAsNotProcessing,
  } = useSessionProtection();

  const {
    projects,
    selectedProject,
    selectedSession,
    activeTab,
    sidebarOpen,
    isLoadingProjects,
    externalMessageUpdate,
    newSessionTrigger,
    setActiveTab,
    setSidebarOpen,
    setIsInputFocused,
    setShowSettings,
    openSettings,
    refreshProjectsSilently,
    sidebarSharedProps,
    handleNewSession,
    handleProjectSelect,
    handleSessionSelect,
  } = useProjectsState({
    sessionId,
    navigate,
    latestMessage,
    isMobile,
    activeSessions,
  });

  usePaletteOpsRegister({
    openSettings,
    refreshProjects: refreshProjectsSilently,
  });

  // Agent-view mode: with no sidebar there's nothing to click, so open the (one)
  // scoped agent automatically — its live remote session, exactly as the sidebar
  // click would. Prefers the remote agent over a same-named local project.
  useEffect(() => {
    if (!agentViewMode || selectedProject || isLoadingProjects || projects.length === 0) return;
    const agentProject = projects.find((p) => p.isRemoteAgent) ?? projects[0];
    handleProjectSelect(agentProject);
    if (agentProject.isRemoteAgent) {
      const agentSessionId =
        agentProject.remoteSessionId || agentProject.projectId.replace(/^remote:/, '');
      handleSessionSelect({
        id: agentSessionId,
        __provider: 'claude',
        __projectId: agentProject.projectId,
        summary: agentProject.displayName,
      } as SessionWithProvider);
    }
  }, [agentViewMode, selectedProject, isLoadingProjects, projects, handleProjectSelect, handleSessionSelect]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return undefined;
    }

    const handleServiceWorkerMessage = (event: MessageEvent) => {
      const message = event.data;
      if (!message || message.type !== 'notification:navigate') {
        return;
      }

      if (typeof message.provider === 'string' && message.provider.trim()) {
        localStorage.setItem('selected-provider', message.provider);
      }

      setActiveTab('chat');
      setSidebarOpen(false);
      void refreshProjectsSilently();

      if (typeof message.sessionId === 'string' && message.sessionId) {
        navigate(`/session/${message.sessionId}`);
        return;
      }

      navigate('/');
    };

    navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);

    return () => {
      navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage);
    };
  }, [navigate, refreshProjectsSilently, setActiveTab, setSidebarOpen]);

  // Permission recovery: query pending permissions on WebSocket reconnect or session change
  useEffect(() => {
    const isReconnect = isConnected && !wasConnectedRef.current;

    if (isReconnect) {
      wasConnectedRef.current = true;
    } else if (!isConnected) {
      wasConnectedRef.current = false;
    }

    if (isConnected && selectedSession?.id) {
      sendMessage({
        type: 'get-pending-permissions',
        sessionId: selectedSession.id
      });
    }
  }, [isConnected, selectedSession?.id, sendMessage]);

  // Pin the fixed app to the VISUAL viewport so the on-screen keyboard can't
  // displace it. A position:fixed element is anchored to the LAYOUT viewport,
  // which iOS does NOT shrink when the keyboard opens — instead iOS shrinks the
  // visual viewport AND scrolls it up to keep the focused field visible. Because
  // the fixed app stays on the (unmoved) layout viewport, its top edge slides
  // above the visible area: focusing the composer makes "everything scroll to the
  // top." Tracking vv.height + vv.offsetTop (on resize AND scroll) and driving the
  // container's top/height from them keeps the app exactly overlaying the visible
  // region, so opening the keyboard never displaces the chat. Desktop/Android:
  // offsetTop is 0 and vv.height == the window, so this is a no-op there.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const update = () => {
      root.style.setProperty('--app-height', `${vv.height}px`);
      root.style.setProperty('--app-top', `${vv.offsetTop}px`);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return (
    <div className="fixed inset-0 flex bg-background" style={{ bottom: 'var(--keyboard-height, 0px)' }}>
      {/* BTI: sidebar removed — single-window app (chat + canvas only). */}
      <div className="flex min-w-0 flex-1 flex-col">
        <MainContent
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          ws={ws}
          sendMessage={sendMessage}
          latestMessage={latestMessage}
          isMobile={isMobile}
          agentViewMode={agentViewMode}
          onMenuClick={() => setSidebarOpen(true)}
          isLoading={isLoadingProjects}
          onInputFocusChange={setIsInputFocused}
          onSessionActive={markSessionAsActive}
          onSessionInactive={markSessionAsInactive}
          onSessionProcessing={markSessionAsProcessing}
          onSessionNotProcessing={markSessionAsNotProcessing}
          processingSessions={processingSessions}
          onNavigateToSession={(targetSessionId: string, options) =>
            navigate(`/session/${targetSessionId}`, { replace: Boolean(options?.replace) })
          }
          onShowSettings={() => setShowSettings(true)}
          externalMessageUpdate={externalMessageUpdate}
          newSessionTrigger={newSessionTrigger}
        />
      </div>

      {!agentViewMode && (
        <CommandPalette
          selectedProject={selectedProject}
          onStartNewChat={handleNewSession}
          onOpenSettings={() => openSettings()}
          onShowTab={setActiveTab}
        />
      )}
    </div>
  );
}
