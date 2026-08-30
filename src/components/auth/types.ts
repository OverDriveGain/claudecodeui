import type { ReactNode } from 'react';

export type AuthUser = {
  id?: number | string;
  username: string;
  [key: string]: unknown;
};

export type AuthActionResult =
  | { success: true }
  | { success: false; error: string; code: string | null };

/**
 * Auth failure surfaced to the login screen. `code` is the machine-readable
 * reason (server `AUTH_*` codes or a client-side code) used to pick a
 * translated message; `message` is the raw fallback text.
 */
export type AuthFeedback = {
  code: string | null;
  message: string;
};

export type AuthSessionPayload = {
  token?: string;
  user?: AuthUser;
  error?: string | { code?: string; message?: string; details?: unknown };
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
  error?: string | { code?: string; message?: string; details?: unknown };
  message?: string;
  code?: string;
};

export type AuthContextValue = {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  needsSetup: boolean;
  hasCompletedOnboarding: boolean;
  error: AuthFeedback | null;
  login: (username: string, password: string) => Promise<AuthActionResult>;
  register: (username: string, password: string) => Promise<AuthActionResult>;
  logout: () => void;
  refreshOnboardingStatus: () => Promise<void>;
};

export type AuthProviderProps = {
  children: ReactNode;
};
