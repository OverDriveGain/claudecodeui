import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Eye, EyeOff, Loader2, LogOut, Plus, Users, X } from 'lucide-react';

import {
  connectRemoteHost,
  disconnectRemoteHost,
  useRemoteHosts,
} from '../../../../utils/remoteHosts';
import { PRIMARY_HOST_KEY, shortHostLabel, toggleHostHidden, useHiddenHosts } from '../../../../utils/hostFocus';
import { useAuth } from '../../../auth/context/AuthContext';
import { ErrorText } from '../../../../shared/view/ui';

/**
 * Per-user "hide agents" toggle — focus the left panel on one login at a time.
 * Labeled (icon shows the ACTION, not the state) so an open eye never invites an
 * accidental hide: shown → "Hide" (eye-off action); hidden → an active "Show"
 * pill (eye action) that also signals the user's agents are currently hidden.
 */
function HideAgentsToggle({ hostKey, hidden }: { hostKey: string; hidden: boolean }) {
  return (
    <button
      type="button"
      title={
        hidden
          ? 'This user’s agents are hidden — click to show them'
          : 'Hide this user’s agents from the sidebar'
      }
      aria-pressed={hidden}
      className={`flex flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors ${
        hidden
          ? 'bg-primary/15 text-primary hover:bg-primary/25'
          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
      }`}
      onClick={() => toggleHostHidden(hostKey)}
    >
      {hidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
      <span>{hidden ? 'Show' : 'Hide'}</span>
    </button>
  );
}

type VersionInfo = { version?: string; builtAt?: string | null; bundle?: string | null };

/** "v1.48.6 · backend 25 Jul 22:14 · index-zynbnlzs" — which build a host runs. */
function versionLabel(v: VersionInfo | null): string | null {
  if (!v) return null;
  const parts: string[] = [];
  if (v.version) parts.push(`v${v.version}`);
  if (v.builtAt) {
    const d = new Date(v.builtAt);
    if (!Number.isNaN(d.getTime())) {
      parts.push(`backend ${d.toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`);
    }
  }
  if (v.bundle) parts.push(v.bundle.replace(/\.js$/, ''));
  return parts.length > 0 ? parts.join(' · ') : null;
}

const ORIGIN = typeof window !== 'undefined' ? window.location.origin : '';

/**
 * "Users" — sign in additional accounts so the sidebar shows several logins'
 * agents at once. The common case is ANOTHER USER ON THIS HOST (the URL defaults
 * to the current origin, hidden behind an "advanced" toggle); a different host is
 * an explicit, opt-in edit. No backend peering — the client holds one session per
 * (host, account) tenant, and every agent is served by the login that owns it.
 */
export default function HostsDialog() {
  const hosts = useRemoteHosts();
  const hiddenHosts = useHiddenHosts();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(ORIGIN);
  const [showHostField, setShowHostField] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // host url ('' = primary) → its /api/version answer. Fetched when the dialog opens.
  const [versions, setVersions] = useState<Record<string, VersionInfo | null>>({});

  const isDifferentHost = (u: string): boolean => {
    try {
      return new URL(u).origin !== ORIGIN;
    } catch {
      return Boolean(u.trim());
    }
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const targets: Array<[string, string]> = [['', '/api/version'], ...hosts.map((h): [string, string] => [h.url, `${h.url}/api/version`])];
    for (const [key, url] of targets) {
      fetch(url)
        .then((r) => (r.ok ? (r.json() as Promise<VersionInfo>) : null))
        .then((v) => {
          if (!cancelled) setVersions((prev) => ({ ...prev, [key]: v }));
        })
        .catch(() => {
          if (!cancelled) setVersions((prev) => ({ ...prev, [key]: null }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [open, hosts]);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await connectRemoteHost(url || ORIGIN, username.trim(), password);
      setUrl(ORIGIN);
      setShowHostField(false);
      setUsername('');
      setPassword('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        <Users className="h-3.5 w-3.5" />
        <span className="text-sm">Users</span>
        {hosts.length > 0 && (
          <span className="ml-auto rounded-full bg-primary/15 px-1.5 text-[10px] font-medium text-primary">
            {hosts.length + 1}
          </span>
        )}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-border bg-background p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">Signed-in users</h2>
              <button
                className="rounded-md p-1 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                onClick={() => setOpen(false)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mb-3 space-y-1.5">
              {/* Primary login (this session) */}
              <div className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">{user?.username || 'You'}</div>
                  <div className="text-[11px] text-muted-foreground">You — signed in on this host</div>
                  {versionLabel(versions[''] ?? null) && (
                    <div className="truncate text-[10px] text-muted-foreground/70">{versionLabel(versions[''] ?? null)}</div>
                  )}
                </div>
                {hosts.length > 0 && (
                  <HideAgentsToggle hostKey={PRIMARY_HOST_KEY} hidden={hiddenHosts.has(PRIMARY_HOST_KEY)} />
                )}
              </div>
              {hosts.map((h) => {
                const differentHost = isDifferentHost(h.url);
                return (
                  <div
                    key={h.key}
                    className="flex items-center justify-between gap-2 rounded-lg border border-border/60 px-2.5 py-1.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">{h.username}</div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {differentHost ? `on ${shortHostLabel(h.url)} (${h.url})` : 'on this host'}
                      </div>
                      {differentHost && versionLabel(versions[h.url] ?? null) && (
                        <div className="truncate text-[10px] text-muted-foreground/70">{versionLabel(versions[h.url] ?? null)}</div>
                      )}
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-0.5">
                      <HideAgentsToggle hostKey={h.key} hidden={hiddenHosts.has(h.key)} />
                      <button
                        type="button"
                        title="Sign out this user"
                        className="flex-shrink-0 rounded-md p-1 text-red-600 transition-colors hover:bg-red-500/10 dark:text-red-400"
                        onClick={() => disconnectRemoteHost(h.key)}
                      >
                        <LogOut className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="space-y-2 border-t border-border/60 pt-3">
              <div className="text-xs font-medium text-muted-foreground">
                Add another user — sign in with their account on this host
              </div>
              <div className="flex gap-2">
                <input
                  className="w-1/2 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60"
                  placeholder="Username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoCapitalize="none"
                  autoCorrect="off"
                />
                <input
                  className="w-1/2 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60"
                  placeholder="Password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submit();
                  }}
                />
              </div>

              {/* Cross-host is opt-in: the URL defaults to THIS host and is only
                  editable once the advanced row is expanded. */}
              <button
                type="button"
                className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => setShowHostField((v) => !v)}
              >
                {showHostField ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                Different host (advanced)
              </button>
              {showHostField && (
                <input
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60"
                  placeholder={ORIGIN || 'https://code.example.com'}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  autoCapitalize="none"
                  autoCorrect="off"
                />
              )}
              {showHostField && isDifferentHost(url) && (
                <div className="text-[10px] text-amber-600 dark:text-amber-400">
                  This signs in to a different host, not this one.
                </div>
              )}

              <ErrorText error={error} className="text-xs" />
              <button
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity disabled:opacity-50"
                disabled={busy || !username.trim() || !password}
                onClick={() => void submit()}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Add user
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
