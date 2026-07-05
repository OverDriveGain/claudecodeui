import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import {
  DEFAULT_SERVER_ORIGIN,
  getServerOrigin,
  normalizeServerOrigin,
  setServerOrigin,
} from '../../../mobile/serverConfig';
import { useAuth } from '../context/AuthContext';
import AuthErrorAlert from './AuthErrorAlert';
import AuthInputField from './AuthInputField';
import AuthScreenLayout from './AuthScreenLayout';

type Mode = 'password' | 'token';

/**
 * Login screen for the native mobile apps.
 *
 * Adds a configurable **server** field (the CCUI instance to connect to, e.g.
 * https://code.kaxtus.com) on top of the existing auth, and lets the user sign
 * in with a username + password OR by pasting a token. Google sign-in is
 * scaffolded (see handleGoogle) pending server-side OAuth support.
 */
export default function MobileLoginForm() {
  const { t } = useTranslation('auth');
  const { login, loginWithToken } = useAuth();

  const [server, setServer] = useState<string>(() => getServerOrigin() || DEFAULT_SERVER_ORIGIN);
  const [mode, setMode] = useState<Mode>('password');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrorMessage('');

      const normalizedServer = normalizeServerOrigin(server);
      if (!normalizedServer) {
        setErrorMessage(t('login.errors.requiredFields', 'Enter a valid server URL'));
        return;
      }
      // Point every subsequent request at the chosen server BEFORE authenticating.
      setServerOrigin(normalizedServer);
      setServer(normalizedServer);

      setIsSubmitting(true);
      let result;
      if (mode === 'token') {
        if (!token.trim()) {
          setErrorMessage(t('login.errors.requiredFields', 'Enter a token'));
          setIsSubmitting(false);
          return;
        }
        result = await loginWithToken(token.trim());
      } else {
        if (!username.trim() || !password) {
          setErrorMessage(t('login.errors.requiredFields'));
          setIsSubmitting(false);
          return;
        }
        result = await login(username.trim(), password);
      }
      if (!result.success) {
        setErrorMessage(result.error);
      }
      setIsSubmitting(false);
    },
    [server, mode, token, username, password, login, loginWithToken, t],
  );

  const handleGoogle = useCallback(() => {
    // Scaffold only. Requires server-side Google OAuth (see notes). When the
    // server exposes /api/auth/google, open it in the system browser and hand
    // the returned token to loginWithToken.
    setErrorMessage('Google sign-in is not enabled on this server yet.');
  }, []);

  return (
    <AuthScreenLayout
      title={t('login.title')}
      description={t('login.description')}
      footerText="Connect to your CCUI server to see your agents"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <AuthInputField
          id="server"
          label="Server"
          value={server}
          onChange={setServer}
          placeholder="https://code.kaxtus.com"
          isDisabled={isSubmitting}
          autoComplete="url"
        />

        <div className="flex rounded-md border border-border p-0.5 text-sm">
          <button
            type="button"
            onClick={() => setMode('password')}
            className={`flex-1 rounded px-3 py-1.5 transition-colors ${
              mode === 'password' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
            }`}
          >
            {t('login.password')}
          </button>
          <button
            type="button"
            onClick={() => setMode('token')}
            className={`flex-1 rounded px-3 py-1.5 transition-colors ${
              mode === 'token' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
            }`}
          >
            Token
          </button>
        </div>

        {mode === 'password' ? (
          <>
            <AuthInputField
              id="username"
              label={t('login.username')}
              value={username}
              onChange={setUsername}
              placeholder={t('login.placeholders.username')}
              isDisabled={isSubmitting}
              autoComplete="username"
            />
            <AuthInputField
              id="password"
              label={t('login.password')}
              value={password}
              onChange={setPassword}
              placeholder={t('login.placeholders.password')}
              isDisabled={isSubmitting}
              type="password"
              autoComplete="current-password"
            />
          </>
        ) : (
          <AuthInputField
            id="token"
            label="Token"
            value={token}
            onChange={setToken}
            placeholder="Paste your access token"
            isDisabled={isSubmitting}
            autoComplete="off"
          />
        )}

        <AuthErrorAlert errorMessage={errorMessage} />

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground transition-colors duration-200 hover:opacity-90 disabled:opacity-60"
        >
          {isSubmitting ? t('login.loading') : t('login.submit')}
        </button>

        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-border" />
          <span className="text-xs text-muted-foreground">or</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        <button
          type="button"
          onClick={handleGoogle}
          disabled={isSubmitting}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-background px-4 py-2 font-medium text-foreground transition-colors duration-200 hover:bg-accent disabled:opacity-60"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1Z" />
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
            <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z" />
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z" />
          </svg>
          Sign in with Google
        </button>
      </form>
    </AuthScreenLayout>
  );
}
