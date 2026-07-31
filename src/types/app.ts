export type LLMProvider = 'claude' | 'cursor' | 'codex' | 'opencode';

export type ProviderModelOption = {
  value: string;
  label: string;
  description?: string;
  effort?: {
    default?: string;
    values: {
      value: string;
      description?: string;
    }[];
  };
};

export type ProviderModelsDefinition = {
  OPTIONS: ProviderModelOption[];
  DEFAULT: string;
};

export type ProviderModelsCacheInfo = {
  updatedAt: string;
  expiresAt: string;
  source: 'memory' | 'disk' | 'fresh';
};

export type AppTab = 'chat' | 'files' | 'shell' | 'git' | 'tasks' | 'browser' | `plugin:${string}`;

export interface ProjectSession {
  id: string;
  title?: string;
  summary?: string;
  name?: string;
  createdAt?: string;
  created_at?: string;
  updated_at?: string;
  lastActivity?: string;
  messageCount?: number;
  provider?: LLMProvider;
  __provider?: LLMProvider;
  // Tags the session with the owning project's DB `projectId` so UI handlers
  // (session switching, sidebar focus, etc.) can match against selectedProject.
  __projectId?: string;
  [key: string]: unknown;
}

export interface ProjectSessionMeta {
  total?: number;
  hasMore?: boolean;
  [key: string]: unknown;
}

export interface ProjectTaskmasterInfo {
  hasTaskmaster?: boolean;
  status?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

// After the projectName → projectId migration the backend no longer returns a
// folder-derived `name` string. Projects are now addressed everywhere by the
// DB-assigned `projectId` (primary key in the `projects` table), and the UI
// uses the same identifier for routing, state keys and API calls.
export interface Project {
  projectId: string;
  displayName: string;
  fullPath: string;
  path?: string;
  isStarred?: boolean;
  sessions?: ProjectSession[];
  sessionMeta?: ProjectSessionMeta;
  taskmaster?: ProjectTaskmasterInfo;
  // Set only for virtual remote:<id> projects — a `claude --remote-control` agent.
  // remoteSessionId is the session the composer drives; remoteConnected is the
  // honest online/offline state.
  isRemoteAgent?: boolean;
  remoteSessionId?: string;
  remoteConnected?: boolean;
  // worker_status==='running' on the relay — the agent is mid-turn. Drives the
  // sidebar running dot, exactly like claude.ai/code.
  remoteRunning?: boolean;
  // Owning claude.ai account label — present only when >1 account is configured
  // (RC_ACCOUNTS). Used to badge which login the agent belongs to.
  remoteAccount?: string;
  // Multi-host mode: origin of the CONNECTED PEER host this project came from
  // (see utils/remoteHosts). Absent/undefined = the primary host (page origin).
  __hostUrl?: string;
  [key: string]: unknown;
}

export interface LoadingProgress {
  kind?: 'loading_progress';
  phase?: string;
  current: number;
  total: number;
  currentProject?: string;
  [key: string]: unknown;
}
