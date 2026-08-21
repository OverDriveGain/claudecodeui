// MYMU: per-tenant "bring an offline agent online" command (Settings → Agents).
// The template is run AS this account's linux_user on the agent's host when a
// user clicks Start on an offline agent; `{name}` is replaced with the agent
// name. Empty = the Start action is disabled for this account.
import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { api } from '../../../../../../utils/api';

export default function OfflineAgentStartSection() {
  const [command, setCommand] = useState('');
  const [linuxUser, setLinuxUser] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api.getAgentStartCommand();
        const body = await res.json().catch(() => ({}));
        if (!alive) return;
        setCommand(typeof body?.command === 'string' ? body.command : '');
        setLinuxUser(typeof body?.linuxUser === 'string' ? body.linuxUser : null);
      } catch { /* leave blank */ } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => { alive = false; if (savedTimer.current) clearTimeout(savedTimer.current); };
  }, []);

  const save = async () => {
    setSaving(true);
    setStatus('idle');
    try {
      const res = await api.setAgentStartCommand(command.trim());
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error('save failed');
      setCommand(typeof body?.command === 'string' ? body.command : '');
      setStatus('saved');
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setStatus('idle'), 2500);
    } catch {
      setStatus('error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-b border-border px-4 py-4 md:px-6">
      <h3 className="text-sm font-semibold text-foreground">Start offline agents</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Command run to bring an offline agent online when you click Start. It runs as
        {linuxUser ? <> your host user <code className="rounded bg-muted px-1">{linuxUser}</code></> : ' your host user'}.
        Use <code className="rounded bg-muted px-1">{'{name}'}</code> for the agent name. Leave empty to disable.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <input
          type="text"
          value={command}
          disabled={!loaded}
          spellCheck={false}
          placeholder="spawn-agents {name}"
          onChange={(e) => setCommand(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !loaded}
          className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Save
        </button>
      </div>
      {status === 'saved' ? <p className="mt-1.5 text-[11px] text-green-600">Saved.</p> : null}
      {status === 'error' ? <p className="mt-1.5 text-[11px] text-destructive">Could not save.</p> : null}
    </div>
  );
}
