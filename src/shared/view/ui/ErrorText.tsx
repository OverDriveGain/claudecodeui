import { cn } from '../../../lib/utils';
import { errorText } from '../../../utils/readError';

/**
 * ErrorText — the render chokepoint for failure messages (MyMu, 2026-08-12).
 *
 * Pass it anything (a string, an Error, a parsed error body, an object) and it
 * renders a specific message in the standard red style, or NOTHING when `error`
 * is nullish. It physically cannot print "[object Object]" or a blank box for a
 * real failure — the coercion runs through `errorText()`. This replaces the
 * `{error && <div className="text-red-600 …">{error}</div>}` pattern so a stray
 * object at a call site can never leak to the screen again.
 */
export function ErrorText({
  error,
  className,
  fallback,
}: {
  error: unknown;
  /** Extra classes; merged over the default red text style. */
  className?: string;
  /** Message to show when `error` is truthy but carries no usable text. */
  fallback?: string;
}) {
  const text = errorText(error, fallback);
  if (!text) return null;
  return (
    <div role="alert" className={cn('text-sm text-red-600 dark:text-red-400', className)}>
      {text}
    </div>
  );
}
