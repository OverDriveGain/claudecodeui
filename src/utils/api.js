import { IS_PLATFORM } from "../constants/config";
import { hostForProject, hostForSession } from "./remoteHosts";

export const AUTH_TOKEN_REFRESHED_EVENT = 'auth-token-refreshed';
export const AUTH_SESSION_EXPIRED_EVENT = 'auth-session-expired';

// Only accept a refreshed token that has this app's issued JWT shape
// (three base64url segments). An attacker-injected/malformed header value
// must never overwrite the stored auth token.
/**
 * @param {unknown} token
 * @returns {token is string}
 */
export const isValidRefreshedToken = (token) =>
  typeof token === 'string' &&
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);

const readTokenClaims = (token) => {
  if (!isValidRefreshedToken(token)) {
    return null;
  }

  try {
    const encodedPayload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const paddedPayload = encodedPayload.padEnd(
      encodedPayload.length + ((4 - (encodedPayload.length % 4)) % 4),
      '=',
    );
    const payload = JSON.parse(atob(paddedPayload));

    if (
      typeof payload.iat !== 'number' ||
      !Number.isFinite(payload.iat) ||
      typeof payload.exp !== 'number' ||
      !Number.isFinite(payload.exp)
    ) {
      return null;
    }

    return { issuedAt: payload.iat * 1000, expiresAt: payload.exp * 1000 };
  } catch {
    return null;
  }
};

export const isAuthTokenExpired = (token) => {
  const claims = readTokenClaims(token);
  return claims ? Date.now() >= claims.expiresAt : false;
};

export const getAuthTokenRefreshDelay = (token) => {
  const claims = readTokenClaims(token);
  if (!claims) {
    return null;
  }

  const refreshAt = claims.issuedAt + ((claims.expiresAt - claims.issuedAt) / 2);
  return Math.max(0, refreshAt - Date.now());
};

export const expireAuthSession = () => {
  localStorage.removeItem('auth-token');
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(AUTH_SESSION_EXPIRED_EVENT));
  }
};

export const getStoredAuthToken = () => {
  const token = localStorage.getItem('auth-token');
  if (token && isAuthTokenExpired(token)) {
    expireAuthSession();
    return null;
  }
  return token;
};

export const storeAuthToken = (token) => {
  if (!isValidRefreshedToken(token)) {
    return false;
  }

  localStorage.setItem('auth-token', token);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(AUTH_TOKEN_REFRESHED_EVENT, { detail: token }));
  }
  return true;
};

// MYMU: stock servers wrap REST payloads as {success:true, data:…}; some of
// this server's routes do too. Normalize both shapes at the parse site.
export const unwrapApiEnvelope = (payload) =>
  payload && typeof payload === 'object' && payload.success === true && 'data' in payload
    ? payload.data
    : payload;

// Utility function for authenticated API calls. MYMU: `host` (a RemoteHost from
// remoteHosts.ts) redirects the call to a connected peer host with ITS token —
// the multi-host model: every resource is served by the host that owns it.
/**
 * @param {string} url
 * @param {RequestInit & { headers?: Record<string, string> }} [options]
 * @param {import('./remoteHosts').RemoteHost | null} [host]
 */
export const authenticatedFetch = (url, options = {}, host = null) => {
  const token = host ? host.token : getStoredAuthToken();

  const defaultHeaders = {};

  // Only set Content-Type for non-FormData requests
  if (!(options.body instanceof FormData)) {
    defaultHeaders['Content-Type'] = 'application/json';
  }

  if ((host || !IS_PLATFORM) && token) {
    defaultHeaders['Authorization'] = `Bearer ${token}`;
  }

  return fetch(host ? `${host.url}${url}` : url, {
    ...options,
    headers: {
      ...defaultHeaders,
      ...options.headers,
    },
  }).then((response) => {
    // Sliding-expiry refresh only applies to the primary host's token.
    const refreshedToken = response.headers.get('X-Refreshed-Token');
    // MYMU: peer-host responses must never rotate/expire the PRIMARY session.
    if (refreshedToken && !host) {
      storeAuthToken(refreshedToken);
    }
    if (!host && response.headers.get('X-Auth-Error')) {
      expireAuthSession();
    }
    return response;
  });
};

// Route by ownership: calls addressed by projectId / sessionId go to the
// connected host that surfaced that item (null = primary, the page's origin).
const byProject = (projectId) => hostForProject(projectId);
const bySession = (sessionId) => hostForSession(sessionId);

// API endpoints
export const api = {
  // Auth endpoints (no token required)
  auth: {
    status: () => fetch('/api/auth/status'),
    login: (username, password) => fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    register: (username, password) => fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    refresh: () => authenticatedFetch('/api/auth/refresh', { method: 'POST' }),
    user: () => authenticatedFetch('/api/auth/user'),
    logout: () => authenticatedFetch('/api/auth/logout', { method: 'POST' }),
  },

  // Protected endpoints
  // config endpoint removed - no longer needed (frontend uses window.location)
  // After the projectName → projectId migration the path/query identifier is
  // the DB-assigned `projectId`; parameter names reflect that for clarity.
  projects: () => authenticatedFetch('/api/projects'),
  // Same endpoints against a CONNECTED PEER host (multi-host merge in useProjectsState).
  projectsFor: (host) => authenticatedFetch('/api/projects', {}, host),
  agentStatusFor: (host) => authenticatedFetch('/api/projects/agent-status', {}, host),
  archivedProjects: () => authenticatedFetch('/api/projects/archived'),
  agentStatus: () => authenticatedFetch('/api/projects/agent-status'),
  projectSessions: (projectId, { limit = 20, offset = 0 } = {}) => {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    params.set('offset', String(offset));
    return authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/sessions?${params.toString()}`, {}, byProject(projectId));
  },
  projectTaskmaster: (projectId) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/taskmaster`),
  // Unified endpoint for persisted session messages.
  // Provider/project metadata are resolved by the backend from sessionId.
  unifiedSessionMessages: (sessionId, _provider = 'claude', { limit = null, offset = 0 } = {}) => {
    const params = new URLSearchParams();
    if (limit !== null) {
      params.append('limit', String(limit));
      params.append('offset', String(offset));
    }
    const queryString = params.toString();
    return authenticatedFetch(`/api/providers/sessions/${encodeURIComponent(sessionId)}/messages${queryString ? `?${queryString}` : ''}`, {}, bySession(sessionId));
  },
  renameProject: (projectId, displayName) =>
    authenticatedFetch(`/api/projects/${projectId}/rename`, {
      method: 'PUT',
      body: JSON.stringify({ displayName }),
    }),
  restoreProject: (projectId) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/restore`, {
      method: 'POST',
    }),
  // Session deletion now mirrors project deletion:
  // - default: archive only (`isArchived = 1`)
  // - hardDelete: remove the row and, by default, its persisted transcript file
  deleteSession: (sessionId, hardDelete = false) => {
    const params = new URLSearchParams();
    if (hardDelete) {
      params.set('force', 'true');
    }
    const qs = params.toString();
    return authenticatedFetch(`/api/providers/sessions/${sessionId}${qs ? `?${qs}` : ''}`, {
      method: 'DELETE',
    }, bySession(sessionId));
  },
  getArchivedSessions: () =>
    authenticatedFetch('/api/providers/sessions/archived'),
  // Resolves one session (by app id or provider-native id) to its metadata and
  // owning project — used when a /session/<id> URL isn't in loaded payloads.
  sessionDetails: (sessionId) =>
    authenticatedFetch(`/api/providers/sessions/${encodeURIComponent(sessionId)}`),
  runningSessions: () =>
    authenticatedFetch('/api/providers/sessions/running'),
  restoreSession: (sessionId) =>
    authenticatedFetch(`/api/providers/sessions/${sessionId}/restore`, {
      method: 'POST',
    }, bySession(sessionId)),
  renameSession: (sessionId, summary) =>
    authenticatedFetch(`/api/providers/sessions/${sessionId}`, {
      method: 'PUT',
      body: JSON.stringify({ summary }),
    }, bySession(sessionId)),
  // `hardDelete` => server `?force=true` (remove DB row + Claude *.jsonl + sessions rows for path).
  deleteProject: (projectId, hardDelete = false) => {
    const params = new URLSearchParams();
    if (hardDelete) params.set('force', 'true');
    const qs = params.toString();
    return authenticatedFetch(`/api/projects/${projectId}${qs ? `?${qs}` : ''}`, {
      method: 'DELETE',
    });
  },
  searchConversationsUrl: (query, limit = 50) => {
    const token = getStoredAuthToken();
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (token) params.set('token', token);
    return `/api/providers/search/sessions?${params.toString()}`;
  },
  createProject: (projectData) =>
    authenticatedFetch('/api/projects/create-project', {
      method: 'POST',
      body: JSON.stringify(projectData),
    }),
  migrateLegacyProjectStars: (projectIds) =>
    authenticatedFetch('/api/projects/migrate-legacy-stars', {
      method: 'POST',
      body: JSON.stringify({ projectIds }),
    }),
  toggleProjectStar: (projectId) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/toggle-star`, {
      method: 'POST',
    }),
  readFile: (projectId, filePath) =>
    authenticatedFetch(`/api/file-tree/projects/${projectId}/file?filePath=${encodeURIComponent(filePath)}`, {}, byProject(projectId)),
  readFileBlob: (projectId, filePath) =>
    authenticatedFetch(`/api/file-tree/projects/${projectId}/files/content?path=${encodeURIComponent(filePath)}`, {}, byProject(projectId)),
  saveFile: (projectId, filePath, content) =>
    authenticatedFetch(`/api/file-tree/projects/${projectId}/file`, {
      method: 'PUT',
      body: JSON.stringify({ filePath, content }),
    }),
  getFiles: (projectId, options = {}) =>
    authenticatedFetch(`/api/file-tree/projects/${projectId}/files`, options, byProject(projectId)),
  getMentionableFiles: (projectId, options = {}) =>
    authenticatedFetch(`/api/file-tree/projects/${projectId}/files?respectGitignore=true`, options, byProject(projectId)),

  // File operations
  createFile: (projectId, { path, type, name }) =>
    authenticatedFetch(`/api/file-tree/projects/${projectId}/files/create`, {
      method: 'POST',
      body: JSON.stringify({ path, type, name }),
    }),

  renameFile: (projectId, { oldPath, newName }) =>
    authenticatedFetch(`/api/file-tree/projects/${projectId}/files/rename`, {
      method: 'PUT',
      body: JSON.stringify({ oldPath, newName }),
    }),

  deleteFile: (projectId, { path, type }) =>
    authenticatedFetch(`/api/file-tree/projects/${projectId}/files`, {
      method: 'DELETE',
      body: JSON.stringify({ path, type }),
    }),

  uploadFiles: (projectId, formData) =>
    authenticatedFetch(`/api/file-tree/projects/${projectId}/files/upload`, {
      method: 'POST',
      body: formData,
      headers: {}, // Let browser set Content-Type for FormData
    }),

  // TaskMaster endpoints — all addressed by DB projectId post-migration.
  taskmaster: {
    // Initialize TaskMaster in a project
    init: (projectId) =>
      authenticatedFetch(`/api/taskmaster/init/${projectId}`, {
        method: 'POST',
      }),

    // Add a new task
    addTask: (projectId, { prompt, title, description, priority, dependencies }) =>
      authenticatedFetch(`/api/taskmaster/add-task/${projectId}`, {
        method: 'POST',
        body: JSON.stringify({ prompt, title, description, priority, dependencies }),
      }),

    // Parse PRD to generate tasks
    parsePRD: (projectId, { fileName, numTasks, append }) =>
      authenticatedFetch(`/api/taskmaster/parse-prd/${projectId}`, {
        method: 'POST',
        body: JSON.stringify({ fileName, numTasks, append }),
      }),

    // Get available PRD templates
    getTemplates: () =>
      authenticatedFetch('/api/taskmaster/prd-templates'),

    // Apply a PRD template
    applyTemplate: (projectId, { templateId, fileName, customizations }) =>
      authenticatedFetch(`/api/taskmaster/apply-template/${projectId}`, {
        method: 'POST',
        body: JSON.stringify({ templateId, fileName, customizations }),
      }),

    // Update a task
    updateTask: (projectId, taskId, updates) =>
      authenticatedFetch(`/api/taskmaster/update-task/${projectId}/${taskId}`, {
        method: 'PUT',
        body: JSON.stringify(updates),
      }),
  },

  // Browse filesystem for project suggestions
  browseFilesystem: (dirPath = null) => {
    const params = new URLSearchParams();
    if (dirPath) params.append('path', dirPath);

    return authenticatedFetch(`/api/file-tree/browse-filesystem?${params}`);
  },

  createFolder: (folderPath) =>
    authenticatedFetch('/api/file-tree/create-folder', {
      method: 'POST',
      body: JSON.stringify({ path: folderPath }),
    }),

  // User endpoints
  user: {
    gitConfig: () => authenticatedFetch('/api/user/git-config'),
    updateGitConfig: (gitName, gitEmail) =>
      authenticatedFetch('/api/user/git-config', {
        method: 'POST',
        body: JSON.stringify({ gitName, gitEmail }),
      }),
    onboardingStatus: () => authenticatedFetch('/api/user/onboarding-status'),
    completeOnboarding: () =>
      authenticatedFetch('/api/user/complete-onboarding', {
        method: 'POST',
      }),
    // Per-user "Remove from view" preference for the agents view. `agentKey` is a
    // stable agent identity (account + title), not the volatile relay session id.
    hiddenAgents: () => authenticatedFetch('/api/user/hidden-agents'),
    hideAgent: (agentKey) =>
      authenticatedFetch('/api/user/hidden-agents', {
        method: 'POST',
        body: JSON.stringify({ agentKey }),
      }),
    unhideAgent: (agentKey) =>
      authenticatedFetch('/api/user/hidden-agents', {
        method: 'DELETE',
        body: JSON.stringify({ agentKey }),
      }),
  },

  // Agent → host assignments (deployment-global, admin-set on the PRIMARY host).
  // Pins an agent to the CCUI host it runs on so sends and file landing route
  // there. Same stable `agentKey` as hidden-agents.
  agentHosts: {
    list: () => authenticatedFetch('/api/agent-hosts'),
    set: (agentKey, hostUrl) =>
      authenticatedFetch('/api/agent-hosts', {
        method: 'PUT',
        body: JSON.stringify({ agentKey, hostUrl }),
      }),
    clear: (agentKey) =>
      authenticatedFetch('/api/agent-hosts', {
        method: 'DELETE',
        body: JSON.stringify({ agentKey }),
      }),
  },

  // Generic GET method for any endpoint
  get: (endpoint) => authenticatedFetch(`/api${endpoint}`),

  // Generic POST method for any endpoint
  post: (endpoint, body) => authenticatedFetch(`/api${endpoint}`, {
    method: 'POST',
    ...(body instanceof FormData ? { body } : { body: JSON.stringify(body) }),
  }),

  // Generic PUT method for any endpoint
  put: (endpoint, body) => authenticatedFetch(`/api${endpoint}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }),

  // Generic DELETE method for any endpoint
  delete: (endpoint, options = {}) => authenticatedFetch(`/api${endpoint}`, {
    method: 'DELETE',
    ...options,
  }),
};
