import type { ReactNode } from 'react';

export type AuthUser = {
  id?: number | string;
  username: string;
  /** BTI: per-user workspace dir the agent runs in (from the server). */
  workspacePath?: string;
  // Set for agent-view share-token bearers: the one agent name this session may
  // see. The UI collapses to that agent's conversation + files (no sidebar).
  agentView?: string;
  [key: string]: unknown;
};

export type AuthActionResult = { success: true } | { success: false; error: string };

// BTI email-token: request-token may surface a dev token when no email provider
// is configured (non-production), so the gate can show it for testing.
export type RequestTokenResult =
  | { success: true; delivered: boolean; devToken?: string }
  | { success: false; error: string };

export type AuthSessionPayload = {
  token?: string;
  user?: AuthUser;
  error?: string;
  message?: string;
};

export type AuthStatusPayload = {
  needsSetup?: boolean;
};

export type AuthUserPayload = {
  user?: AuthUser;
};

export type OnboardingStatusPayload = {
  hasCompletedOnboarding?: boolean;
};

export type ApiErrorPayload = {
  error?: string;
  message?: string;
};

export type AuthContextValue = {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  needsSetup: boolean;
  hasCompletedOnboarding: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<AuthActionResult>;
  loginWithToken: (token: string) => Promise<AuthActionResult>;
  register: (username: string, password: string) => Promise<AuthActionResult>;
  requestToken: (email: string) => Promise<RequestTokenResult>;
  loginWithToken: (token: string) => Promise<AuthActionResult>;
  logout: () => void;
  refreshOnboardingStatus: () => Promise<void>;
};

export type AuthProviderProps = {
  children: ReactNode;
};
