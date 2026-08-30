import { AlertCircle, Clock } from 'lucide-react';

type AuthErrorAlertProps = {
  errorMessage: string;
  /**
   * 'error' — the attempt failed (wrong password, network error).
   * 'notice' — informational, not the user's fault (session expired / signed
   * out); rendered in a calmer amber so it doesn't read as a mistake.
   */
  variant?: 'error' | 'notice';
};

export default function AuthErrorAlert({ errorMessage, variant = 'error' }: AuthErrorAlertProps) {
  if (!errorMessage) {
    return null;
  }

  const isNotice = variant === 'notice';
  const Icon = isNotice ? Clock : AlertCircle;

  return (
    <div
      role="alert"
      className={
        isNotice
          ? 'flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-amber-600 dark:text-amber-400'
          : 'flex items-start gap-2.5 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-destructive'
      }
    >
      <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" />
      <p className="text-sm leading-relaxed">{errorMessage}</p>
    </div>
  );
}
