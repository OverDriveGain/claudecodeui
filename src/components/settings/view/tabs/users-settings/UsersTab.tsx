import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, KeyRound, Loader2, RotateCcw, UserPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../../../utils/api';
import { Badge, Button, Input } from '../../../../../shared/view/ui';
import SettingsSection from '../../SettingsSection';

type AdminUser = {
  id: number;
  username: string;
  accountOwner: boolean;
  linuxUser: string | null;
  agentAllow: string | null;
  mustChangePassword: boolean;
  isActive: boolean;
  lastLogin: string | null;
  createdAt: string | null;
};

type IssuedPassword = {
  username: string;
  oneTimePassword: string;
};

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json();
    const raw = payload?.error ?? payload?.message;
    if (typeof raw === 'string') return raw;
    if (raw && typeof raw === 'object' && typeof raw.message === 'string') return raw.message;
  } catch {
    /* fall through */
  }
  return fallback;
}

/**
 * Owner-only account management. Lists accounts on this host, creates new ones,
 * and resets any account's password — each create/reset returns a one-time
 * password shown exactly once (the server only stores it hashed). The user signs
 * in with it and is then forced to choose their own password.
 */
export default function UsersTab() {
  const { t } = useTranslation('settings');

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [issued, setIssued] = useState<IssuedPassword | null>(null);
  const [copied, setCopied] = useState(false);
  const [busyUserId, setBusyUserId] = useState<number | null>(null);

  // Create form
  const [newUsername, setNewUsername] = useState('');
  const [newLinuxUser, setNewLinuxUser] = useState('');
  const [newIsOwner, setNewIsOwner] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  const loadUsers = useCallback(async () => {
    setIsLoading(true);
    setLoadError('');
    try {
      const response = await api.admin.listUsers();
      if (!response.ok) {
        setLoadError(await readError(response, t('users.loadFailed', 'Failed to load users.')));
        return;
      }
      const payload = await response.json();
      setUsers(Array.isArray(payload?.users) ? payload.users : []);
    } catch {
      setLoadError(t('users.loadFailed', 'Failed to load users.'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const reveal = (username: string, oneTimePassword: string) => {
    setIssued({ username, oneTimePassword });
    setCopied(false);
  };

  const handleCopy = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.oneTimePassword);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const handleReset = async (user: AdminUser) => {
    setBusyUserId(user.id);
    try {
      const response = await api.admin.resetPassword(user.id);
      if (!response.ok) {
        setLoadError(await readError(response, t('users.resetFailed', 'Failed to reset password.')));
        return;
      }
      const payload = await response.json();
      reveal(payload.username ?? user.username, payload.oneTimePassword);
      await loadUsers();
    } catch {
      setLoadError(t('users.resetFailed', 'Failed to reset password.'));
    } finally {
      setBusyUserId(null);
    }
  };

  const handleCreate = async () => {
    setCreateError('');
    const username = newUsername.trim();
    if (username.length < 3) {
      setCreateError(t('users.usernameTooShort', 'Username must be at least 3 characters.'));
      return;
    }
    setIsCreating(true);
    try {
      const response = await api.admin.createUser({
        username,
        accountOwner: newIsOwner,
        linuxUser: newLinuxUser.trim() || undefined,
      });
      if (!response.ok) {
        setCreateError(await readError(response, t('users.createFailed', 'Failed to create user.')));
        return;
      }
      const payload = await response.json();
      reveal(payload.user?.username ?? username, payload.oneTimePassword);
      setNewUsername('');
      setNewLinuxUser('');
      setNewIsOwner(false);
      await loadUsers();
    } catch {
      setCreateError(t('users.createFailed', 'Failed to create user.'));
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* One-time password reveal — shown once after create/reset */}
      {issued && (
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <KeyRound className="h-4 w-4 text-primary" />
            {t('users.oneTimeFor', 'One-time password for')} <span className="font-semibold">{issued.username}</span>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <code className="flex-1 select-all rounded-lg border border-border bg-background px-3 py-2 font-mono text-lg tracking-widest text-foreground">
              {issued.oneTimePassword}
            </code>
            <Button variant="outline" onClick={handleCopy} className="inline-flex items-center gap-1.5">
              {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
              {copied ? t('users.copied', 'Copied') : t('users.copy', 'Copy')}
            </Button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {t(
              'users.oneTimeHint',
              'Share this with the user. They sign in with it once, then must choose their own password. It cannot be shown again — reset to generate a new one.',
            )}
          </p>
          <button
            type="button"
            onClick={() => setIssued(null)}
            className="mt-2 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {t('users.dismiss', 'Dismiss')}
          </button>
        </div>
      )}

      {/* Existing users */}
      <SettingsSection
        title={t('users.title', 'Users')}
        description={t('users.description', 'Accounts that can sign in to this server.')}
      >
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('users.loading', 'Loading…')}
          </div>
        ) : loadError ? (
          <p className="text-sm text-destructive">{loadError}</p>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
            {users.map((user) => (
              <li key={user.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">{user.username}</span>
                    {user.accountOwner && <Badge variant="secondary">{t('users.owner', 'owner')}</Badge>}
                    {user.linuxUser && (
                      <Badge variant="outline">{t('users.linux', 'linux')}: {user.linuxUser}</Badge>
                    )}
                    {user.mustChangePassword && (
                      <Badge variant="outline" className="text-amber-600 dark:text-amber-400">
                        {t('users.pendingPassword', 'must set password')}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {user.lastLogin
                      ? t('users.lastLogin', 'Last login {{when}}', { when: user.lastLogin })
                      : t('users.neverLoggedIn', 'Never signed in')}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleReset(user)}
                  disabled={busyUserId === user.id}
                  className="inline-flex flex-shrink-0 items-center gap-1.5"
                >
                  {busyUserId === user.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3.5 w-3.5" />
                  )}
                  {t('users.resetPassword', 'Reset password')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>

      {/* Create user */}
      <SettingsSection
        title={t('users.addTitle', 'Add User')}
        description={t('users.addDescription', 'Create an account and issue a one-time password.')}
      >
        <div className="max-w-sm space-y-3">
          <Input
            placeholder={t('users.username', 'Username')}
            value={newUsername}
            onChange={(event) => setNewUsername(event.target.value)}
            disabled={isCreating}
          />
          <Input
            placeholder={t('users.linuxUserOptional', 'Linux user (optional)')}
            value={newLinuxUser}
            onChange={(event) => setNewLinuxUser(event.target.value)}
            disabled={isCreating}
          />
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={newIsOwner}
              onChange={(event) => setNewIsOwner(event.target.checked)}
              disabled={isCreating}
              className="h-4 w-4 rounded border-border text-primary focus:ring-primary/40"
            />
            {t('users.makeOwner', 'Account owner (sees all agents, can manage users)')}
          </label>

          {createError && <p className="text-sm text-destructive">{createError}</p>}

          <Button
            onClick={handleCreate}
            disabled={isCreating || newUsername.trim().length < 3}
            className="inline-flex items-center gap-2"
          >
            {isCreating ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
            {t('users.create', 'Create User')}
          </Button>
        </div>
      </SettingsSection>
    </div>
  );
}
