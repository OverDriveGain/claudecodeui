import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { SendIcon } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

/**
 * BTI Chat-Login experience.
 *
 * The first thing a logged-out visitor sees: the app's empty panes on top, and a
 * chat below where a scripted "assistant" signs them in. The prompt accepts EITHER
 * an email (→ a durable login token is emailed) OR a login token (→ signed in).
 * The token *is* the login. It deliberately is NOT the LLM — we don't run an agent
 * before authentication. On success the AuthContext session is set and
 * ProtectedRoute swaps in the real app.
 */

const PANES = ['Top view', 'Section', 'Costs', 'Elevations', 'Map'];

type Msg = { role: 'assistant' | 'user'; text: string };

// Forgiving extraction — the user is chatting, not filling a form.
const extractEmail = (s: string): string | null =>
  s.match(/[^\s@]+@[^\s@]+\.[^\s@]+/)?.[0] ?? null;
const extractToken = (s: string): string | null =>
  s.match(/bldr_[A-Za-z0-9]{16,}/)?.[0] ?? null;

export default function ChatLoginExperience() {
  const { requestToken, loginWithToken } = useAuth();
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: 'assistant',
      text:
        "Welcome to BLDR — let's design your build. What's your email to get started? "
        + 'Or paste your login token if you already have one.',
    },
  ]);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const say = useCallback((role: Msg['role'], text: string) => {
    setMessages((prev) => [...prev, { role, text }]);
  }, []);

  const handleSubmit = useCallback(
    async (event?: FormEvent) => {
      event?.preventDefault();
      const entry = value.trim();
      if (!entry || busy || done) return;

      // 1) A login token? Sign in directly.
      const token = extractToken(entry);
      if (token) {
        say('user', '••• login token •••');
        setValue('');
        setBusy(true);
        const result = await loginWithToken(token);
        setBusy(false);
        if (!result.success) {
          say('assistant', `${result.error}`);
          return;
        }
        setDone(true);
        say('assistant', "You're in! Loading your workspace…");
        return;
      }

      // 2) An email? Email them a durable login token.
      const email = extractEmail(entry);
      if (email) {
        say('user', entry);
        setValue('');
        setBusy(true);
        const result = await requestToken(email);
        setBusy(false);
        if (!result.success) {
          say('assistant', `${result.error} Want to try a different email?`);
          return;
        }
        say(
          'assistant',
          `I emailed your login token to ${email}. Paste it here to sign in — and keep it, it's your login next time.`,
        );
        if (result.devToken) {
          say('assistant', `(dev — no email provider configured) your token is ${result.devToken}`);
        }
        return;
      }

      // 3) Neither.
      say('user', entry);
      say('assistant', "Tell me your email to get started, or paste your login token.");
      setValue('');
    },
    [busy, done, loginWithToken, requestToken, say, value],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleSubmit();
      }
    },
    [handleSubmit],
  );

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Empty panes — the same canvas the customer will fill once signed in. */}
      <div className="min-h-0 flex-1 p-2 sm:p-4">
        <div className="grid h-full grid-cols-2 gap-2 sm:gap-3 md:grid-cols-3">
          {PANES.map((title) => (
            <div
              key={title}
              className="flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card/40"
            >
              <div className="border-b border-border/40 px-3 py-1.5 text-xs font-medium text-muted-foreground">
                {title}
              </div>
              <div className="flex flex-1 items-center justify-center text-[11px] text-muted-foreground/40">
                Empty
              </div>
            </div>
          ))}
          <div className="hidden items-center justify-center rounded-xl border border-dashed border-border/40 text-sm font-semibold text-primary md:flex">
            BLDR
          </div>
        </div>
      </div>

      {/* Chat — sign in here. */}
      <div className="flex max-h-[45vh] flex-shrink-0 flex-col border-t border-border/60 bg-card/30">
        <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 sm:p-4">
          <div className="mx-auto w-full max-w-2xl space-y-3">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm ${
                    m.role === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted/60 text-foreground'
                  }`}
                >
                  {m.text}
                </div>
              </div>
            ))}
            {busy && (
              <div className="flex justify-start">
                <div className="rounded-2xl bg-muted/60 px-3.5 py-2 text-sm text-muted-foreground">…</div>
              </div>
            )}
          </div>
        </div>

        <form onSubmit={handleSubmit} className="flex-shrink-0 p-3 sm:p-4">
          <div className="mx-auto flex w-full max-w-2xl items-center gap-2 rounded-2xl border border-border/60 bg-background p-1.5">
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={busy || done}
              type="text"
              autoComplete="off"
              placeholder="Your email — or paste your login token"
              className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/60"
            />
            <button
              type="submit"
              disabled={busy || done || !value.trim()}
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground transition-opacity disabled:opacity-40"
              aria-label="Send"
            >
              <SendIcon className="h-4 w-4" />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
