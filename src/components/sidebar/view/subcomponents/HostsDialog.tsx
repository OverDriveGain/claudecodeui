import { useEffect, useState } from 'react';
import { Globe, Loader2, Plus, X } from 'lucide-react';

import {
  connectRemoteHost,
  disconnectRemoteHost,
  useRemoteHosts,
} from '../../../../utils/remoteHosts';

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

/**
 * "Hosts" — connect this client to additional CCUI hosts, each with that host's
 * own user (the multi-host paradigm: no backend peering; the client holds one
 * session per host and every agent is served by the host that owns it). The
 * button + dialog are self-contained: connecting/disconnecting updates the
 * remote-hosts store, which the projects fetch, status polls, WS layer and file
 * URLs all subscribe to.
 */
export default function HostsDialog() {
  const hosts = useRemoteHosts();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // host url ('' = primary) → its /api/version answer. Fetched when the dialog opens.
  const [versions, setVersions] = useState<Record<string, VersionInfo | null>>({});

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
      await connectRemoteHost(url, username.trim(), password);
      setUrl('');
      setUsername('');
      setPassword('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed');
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
        <Globe className="h-3.5 w-3.5" />
        <span className="text-sm">Hosts</span>
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
              <h2 className="text-sm font-semibold text-foreground">Connected hosts</h2>
              <button
                className="rounded-md p-1 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                onClick={() => setOpen(false)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mb-3 space-y-1.5">
              <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm text-foreground">{window.location.origin}</div>
                  <div className="text-[11px] text-muted-foreground">This host — your main login</div>
                  {versionLabel(versions[''] ?? null) && (
                    <div className="truncate text-[10px] text-muted-foreground/70">{versionLabel(versions[''] ?? null)}</div>
                  )}
                </div>
              </div>
              {hosts.map((h) => (
                <div
                  key={h.key}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm text-foreground">{h.url} <span className="text-muted-foreground">({h.username})</span></div>
                    <div className="text-[11px] text-muted-foreground">as {h.username}</div>
                    {versionLabel(versions[h.url] ?? null) && (
                      <div className="truncate text-[10px] text-muted-foreground/70">{versionLabel(versions[h.url] ?? null)}</div>
                    )}
                  </div>
                  <button
                    className="flex-shrink-0 rounded-md px-2 py-1 text-xs text-red-600 transition-colors hover:bg-red-500/10 dark:text-red-400"
                    onClick={() => disconnectRemoteHost(h.key)}
                  >
                    Disconnect
                  </button>
                </div>
              ))}
            </div>

            <div className="space-y-2 border-t border-border/60 pt-3">
              <div className="text-xs font-medium text-muted-foreground">
                Add a host — log in with that host&apos;s user
              </div>
              <input
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60"
                placeholder="https://code.example.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
              />
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
              {error && <div className="text-xs text-red-600 dark:text-red-400">{error}</div>}
              <button
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity disabled:opacity-50"
                disabled={busy || !url.trim() || !username.trim() || !password}
                onClick={() => void submit()}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Connect
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
