import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { KeyRound, Loader2, Lock, ShieldCheck } from 'lucide-react';

import { useAuth } from '../context/AuthContext';

import AuthErrorAlert from './AuthErrorAlert';
import AuthInputField from './AuthInputField';
import AuthScreenLayout from './AuthScreenLayout';

type ChangePasswordFormState = {
  newPassword: string;
  confirmPassword: string;
};

const initialState: ChangePasswordFormState = {
  newPassword: '',
  confirmPassword: '',
};

/**
 * Forced password-change screen shown right after a user signs in with an
 * admin-issued one-time password (`must_change_password`). It sits in front of
 * the app in ProtectedRoute: the user cannot proceed until they choose their own
 * password. No current-password field — the one-time password was just verified
 * by the login that produced this session.
 */
export default function ChangePasswordForm() {
  const { user, changePassword, logout } = useAuth();

  const [formState, setFormState] = useState<ChangePasswordFormState>(initialState);
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const updateField = useCallback((field: keyof ChangePasswordFormState, value: string) => {
    setFormState((previous) => ({ ...previous, [field]: value }));
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrorMessage('');

      if (formState.newPassword.length < 6) {
        setErrorMessage('Password must be at least 6 characters long.');
        return;
      }
      if (formState.newPassword !== formState.confirmPassword) {
        setErrorMessage('Passwords do not match.');
        return;
      }

      setIsSubmitting(true);
      // Forced flow: no current password to send.
      const result = await changePassword('', formState.newPassword);
      if (!result.success) {
        setErrorMessage(result.error);
        setIsSubmitting(false);
      }
      // On success ProtectedRoute unmounts this screen; no local reset needed.
    },
    [changePassword, formState],
  );

  return (
    <AuthScreenLayout
      title="Choose a password"
      description={
        user?.username
          ? `Welcome, ${user.username}. Set a password to finish signing in.`
          : 'Set a password to finish signing in.'
      }
      footerText="Your temporary password can only be used once. Pick a password you'll remember."
      logo={
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary shadow-lg shadow-primary/10">
          <KeyRound className="h-8 w-8" />
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Hidden username field helps password managers associate the new secret. */}
        <input
          type="text"
          name="username"
          autoComplete="username"
          value={user?.username ?? ''}
          readOnly
          hidden
        />

        <AuthInputField
          id="newPassword"
          name="newPassword"
          label="New password"
          value={formState.newPassword}
          onChange={(value) => updateField('newPassword', value)}
          placeholder="Create a password"
          isDisabled={isSubmitting}
          type="password"
          autoComplete="new-password"
          icon={Lock}
        />

        <AuthInputField
          id="confirmPassword"
          name="confirmPassword"
          label="Confirm password"
          value={formState.confirmPassword}
          onChange={(value) => updateField('confirmPassword', value)}
          placeholder="Re-enter your password"
          isDisabled={isSubmitting}
          type="password"
          autoComplete="new-password"
          icon={ShieldCheck}
        />

        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5" />
          At least 6 characters.
        </p>

        <AuthErrorAlert errorMessage={errorMessage} />

        <button
          type="submit"
          disabled={isSubmitting}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 font-medium text-primary-foreground shadow-lg shadow-primary/25 transition-all duration-200 hover:shadow-primary/30 hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:ring-offset-2 focus:ring-offset-card active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Saving...
            </>
          ) : (
            'Set password & continue'
          )}
        </button>

        <button
          type="button"
          onClick={logout}
          disabled={isSubmitting}
          className="w-full text-center text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
        >
          Sign in as a different user
        </button>
      </form>
    </AuthScreenLayout>
  );
}
