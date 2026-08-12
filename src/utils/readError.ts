/**
 * readError — the single client chokepoint that turns ANY failure into a
 * specific, human-readable string.
 *
 * Why this exists (MyMu, 2026-08-12): the backend speaks two error dialects —
 * the structured envelope `{ success:false, error:{ code, message, details } }`
 * (global handler, from AppError) and the flat `{ error:"..." }` of older
 * routes — and a dead network throws with no body at all. MyMu client code used
 * to assume the flat string everywhere (`new Error(body.error)`), so a
 * structured body rendered as the literal "[object Object]" and a network
 * failure rendered as nothing. Every MyMu (F1–F5) failure path routes its
 * message extraction through here instead of guessing.
 *
 * Guarantees:
 *  - never returns "[object Object]" or any raw-object string,
 *  - never returns a blank string for a real failure (falls back to a generic),
 *  - returns '' ONLY for a nullish value (i.e. "no error"), so render sites can
 *    treat '' as "show nothing".
 */

const GENERIC = 'Something went wrong';

/** Is this a usable, non-empty, non-garbage message string? */
function usable(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.trim() !== '[object Object]';
}

/**
 * Pull a message out of an already-parsed response body (or any thrown value).
 * Handles: plain string bodies, flat `{ error }`, structured `{ error: { message } }`,
 * `{ message }`, nested `{ error: { details } }`, and Error instances.
 */
function extract(body: unknown): string | null {
  if (body == null) return null;
  if (usable(body)) return body.trim();

  if (body instanceof Error) {
    if (usable(body.message)) return body.message.trim();
    return null;
  }

  if (typeof body === 'object') {
    const o = body as Record<string, unknown>;

    // Structured envelope: { error: { code, message, details } }
    if (o.error && typeof o.error === 'object') {
      const e = o.error as Record<string, unknown>;
      if (usable(e.message)) return (e.message as string).trim();
      if (usable(e.details)) return (e.details as string).trim();
      if (usable(e.code)) return (e.code as string).trim();
    }

    // Flat: { error: "..." }
    if (usable(o.error)) return (o.error as string).trim();

    // Some endpoints use { message } / { details } at the top level.
    if (usable(o.message)) return (o.message as string).trim();
    if (usable(o.details)) return (o.details as string).trim();
  }

  return null;
}

/**
 * Coerce any value (thrown error, parsed body, string, object, nullish) into a
 * displayable string. Nullish → '' ("no error"); anything else that yields no
 * usable text → `fallback`.
 */
export function errorText(value: unknown, fallback: string = GENERIC): string {
  if (value == null) return '';
  return extract(value) ?? fallback;
}

/**
 * Extract a message from a parsed body plus its HTTP status. Use when the caller
 * has ALREADY consumed `response.json()` (a Response body reads only once).
 */
export function pickErrorMessage(
  body: unknown,
  status?: number,
  statusText?: string,
  fallback: string = GENERIC,
): string {
  const fromBody = extract(body);
  if (fromBody) return fromBody;
  if (typeof status === 'number') {
    const st = statusText && statusText.trim() ? ` ${statusText.trim()}` : '';
    return `HTTP ${status}${st}`;
  }
  return fallback;
}

/**
 * Read a non-ok fetch Response and return its failure message. Reads the body
 * itself (JSON first, then text), so only call this on a Response nobody else
 * has consumed. Never throws.
 */
export async function readErrorResponse(response: Response, fallback: string = GENERIC): Promise<string> {
  let body: unknown = null;
  try {
    const text = await response.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text; // non-JSON error body (e.g. a proxy/HTML 502)
      }
    }
  } catch {
    /* body unreadable — fall through to status */
  }
  return pickErrorMessage(body, response.status, response.statusText, fallback);
}
