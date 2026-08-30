import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Lock, User } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import type { AuthFeedback } from '../types';
import AuthErrorAlert from './AuthErrorAlert';
import AuthInputField from './AuthInputField';
import AuthScreenLayout from './AuthScreenLayout';

type LoginFormState = {
  username: string;
  password: string;
};

const initialState: LoginFormState = {
  username: '',
  password: '',
};

// Server AUTH_* / client feedback codes → translated login.errors.* messages.
// Unknown codes fall back to the raw server message (never blank, never an object).
const FEEDBACK_I18N_KEYS: Record<string, string> = {
  AUTH_INVALID_CREDENTIALS: 'login.errors.invalidCredentials',
  AUTH_CREDENTIALS_REQUIRED: 'login.errors.requiredFields',
  NETWORK_ERROR: 'login.errors.networkError',
  AUTH_TOKEN_EXPIRED: 'login.errors.sessionExpired',
  AUTH_TOKEN_INVALID: 'login.errors.signedOut',
  AUTH_STATUS_CHECK_FAILED: 'login.errors.statusCheckFailed',
};

// Being sent back to login is not the user's mistake — show these calmer.
const NOTICE_CODES = new Set(['AUTH_TOKEN_EXPIRED', 'AUTH_TOKEN_INVALID']);

/**
 * Login form component.
 * Handles credential input with browser autofill support (`autocomplete`
 * attributes) so that password managers can offer to fill saved credentials.
 */
export default function LoginForm() {
  const { t } = useTranslation('auth');
  const { error: sessionFeedback, login } = useAuth();

  const [formState, setFormState] = useState<LoginFormState>(initialState);
  const [submitFeedback, setSubmitFeedback] = useState<AuthFeedback | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const updateField = useCallback((field: keyof LoginFormState, value: string) => {
    setFormState((previous) => ({ ...previous, [field]: value }));
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setSubmitFeedback(null);

      // Keep form validation local so each auth screen owns its own UI feedback.
      if (!formState.username.trim() || !formState.password) {
        setSubmitFeedback({
          code: 'AUTH_CREDENTIALS_REQUIRED',
          message: t('login.errors.requiredFields'),
        });
        return;
      }

      setIsSubmitting(true);
      const result = await login(formState.username.trim(), formState.password);
      if (!result.success) {
        setSubmitFeedback({ code: result.code, message: result.error });
      }
      setIsSubmitting(false);
    },
    [formState.password, formState.username, login, t],
  );

  // A fresh submit result replaces the "why am I back at login" notice.
  const activeFeedback = submitFeedback ?? sessionFeedback;
  const i18nKey = activeFeedback?.code ? FEEDBACK_I18N_KEYS[activeFeedback.code] : undefined;
  const feedbackText = activeFeedback
    ? (i18nKey ? t(i18nKey, { defaultValue: activeFeedback.message }) : activeFeedback.message)
    : '';
  const feedbackVariant =
    activeFeedback?.code && NOTICE_CODES.has(activeFeedback.code) ? 'notice' : 'error';

  return (
    <AuthScreenLayout
      title={t('login.title')}
      description={t('login.description')}
      footerText="Enter your credentials to access MyMu"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <AuthInputField
          id="username"
          label={t('login.username')}
          value={formState.username}
          onChange={(value) => updateField('username', value)}
          placeholder={t('login.placeholders.username')}
          isDisabled={isSubmitting}
          autoComplete="username"
          icon={User}
        />

        <AuthInputField
          id="password"
          label={t('login.password')}
          value={formState.password}
          onChange={(value) => updateField('password', value)}
          placeholder={t('login.placeholders.password')}
          isDisabled={isSubmitting}
          type="password"
          autoComplete="current-password"
          icon={Lock}
        />

        <AuthErrorAlert errorMessage={feedbackText} variant={feedbackVariant} />

        <button
          type="submit"
          disabled={isSubmitting}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 font-medium text-primary-foreground shadow-lg shadow-primary/25 transition-all duration-200 hover:brightness-110 hover:shadow-primary/30 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:ring-offset-2 focus:ring-offset-card active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('login.loading')}
            </>
          ) : (
            t('login.submit')
          )}
        </button>
      </form>
    </AuthScreenLayout>
  );
}
