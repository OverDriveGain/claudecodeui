import { errorText } from '../../utils/readError';

import type { ApiErrorPayload } from './types';

export async function parseJsonSafely<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Always returns a displayable string. The server speaks two error dialects —
 * the structured envelope `{ success:false, error:{ code, message } }` (global
 * AppError handler, e.g. a wrong password) and flat `{ error:"..." }` — and the
 * old implementation here returned `payload.error` verbatim, so the structured
 * shape leaked an OBJECT into the alert and the real reason never rendered.
 */
export function resolveApiErrorMessage(payload: ApiErrorPayload | null, fallback: string): string {
  if (!payload) {
    return fallback;
  }

  return errorText(payload, fallback) || fallback;
}

/** Machine-readable error code from either error dialect, or null. */
export function resolveApiErrorCode(payload: ApiErrorPayload | null): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if (payload.error && typeof payload.error === 'object' && typeof payload.error.code === 'string') {
    return payload.error.code;
  }
  if (typeof payload.code === 'string') {
    return payload.code;
  }

  return null;
}
