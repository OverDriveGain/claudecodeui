import { useState } from 'react';
import { Check, KeyRound, LogOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../../auth/context/AuthContext';
import { Button } from '../../../../shared/view/ui';
import SettingsSection from '../SettingsSection';

export default function AccountTab() {
  const { t } = useTranslation('settings');
  const { user, logout, changePassword } = useAuth();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [didSucceed, setDidSucceed] = useState(false);

  const handleLogout = async () => {
    if (confirm(t('account.logoutConfirm', 'Are you sure you want to log out?'))) {
      await logout();
    }
  };

  const handleChangePassword = async () => {
    setErrorMessage('');
    setDidSucceed(false);

    if (newPassword.length < 6) {
      setErrorMessage(t('account.passwordTooShort', 'New password must be at least 6 characters.'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setErrorMessage(t('account.passwordMismatch', 'Passwords do not match.'));
      return;
    }

    setIsSaving(true);
    const result = await changePassword(currentPassword, newPassword);
    setIsSaving(false);

    if (result.success) {
      setDidSucceed(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } else {
      setErrorMessage(result.error);
    }
  };

  const agentAllow = typeof user?.agent_allow === 'string' ? user.agent_allow : null;

  const inputClass =
    'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60';

  return (
    <div className="space-y-6">
      {/* User info */}
      <SettingsSection title={t('account.userInfo', 'User Information')}>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-muted-foreground">
              {t('account.username', 'Username')}
            </label>
            <p className="mt-1 text-sm font-medium text-foreground">{user?.username || '—'}</p>
          </div>
          {agentAllow && (
            <div>
              <label className="block text-xs font-medium text-muted-foreground">
                {t('account.agentAccess', 'Agent Access')}
              </label>
              <p className="mt-1 text-sm text-foreground">{agentAllow}</p>
            </div>
          )}
        </div>
      </SettingsSection>

      {/* Change password */}
      <SettingsSection title={t('account.changePassword', 'Change Password')}>
        <p className="mb-4 text-sm text-muted-foreground">
          {t('account.changePasswordDescription', 'Update the password you use to sign in.')}
        </p>
        <div className="max-w-sm space-y-3">
          <input
            type="password"
            autoComplete="current-password"
            className={inputClass}
            placeholder={t('account.currentPassword', 'Current password')}
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            disabled={isSaving}
          />
          <input
            type="password"
            autoComplete="new-password"
            className={inputClass}
            placeholder={t('account.newPassword', 'New password')}
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            disabled={isSaving}
          />
          <input
            type="password"
            autoComplete="new-password"
            className={inputClass}
            placeholder={t('account.confirmPassword', 'Confirm new password')}
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            disabled={isSaving}
          />

          {errorMessage && (
            <p className="text-sm text-destructive">{errorMessage}</p>
          )}
          {didSucceed && (
            <p className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
              <Check className="h-4 w-4" />
              {t('account.passwordUpdated', 'Password updated.')}
            </p>
          )}

          <Button
            onClick={handleChangePassword}
            disabled={isSaving || !currentPassword || !newPassword || !confirmPassword}
            className="inline-flex items-center gap-2"
          >
            <KeyRound className="h-4 w-4" />
            {isSaving
              ? t('account.savingPassword', 'Saving…')
              : t('account.updatePassword', 'Update Password')}
          </Button>
        </div>
      </SettingsSection>

      {/* Logout */}
      <SettingsSection title={t('account.session', 'Session')}>
        <p className="mb-4 text-sm text-muted-foreground">
          {t('account.logoutDescription', 'Log out of this account and return to the login screen.')}
        </p>
        <Button
          variant="destructive"
          onClick={handleLogout}
          className="inline-flex items-center gap-2"
        >
          <LogOut className="h-4 w-4" />
          {t('account.logout', 'Log Out')}
        </Button>
      </SettingsSection>
    </div>
  );
}
