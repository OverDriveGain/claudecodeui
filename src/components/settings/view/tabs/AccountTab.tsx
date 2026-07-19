import { LogOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../../auth/context/AuthContext';
import { Button } from '../../../../shared/view/ui';
import SettingsSection from '../SettingsSection';

export default function AccountTab() {
  const { t } = useTranslation('settings');
  const { user, logout } = useAuth();

  const handleLogout = async () => {
    if (confirm(t('account.logoutConfirm', 'Are you sure you want to log out?'))) {
      await logout();
    }
  };

  const agentAllow = typeof user?.agent_allow === 'string' ? user.agent_allow : null;

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
