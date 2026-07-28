/**
 * Design-wizard handoff. The BTI website wizard (bti.kikhia.ae /design) collects
 * project type, area, style, finish and free-text details, then opens/embeds the
 * app as:  https://build.kikhia.ae/?brief=<urlencoded text>
 *
 * We adopt the brief once, strip it from the address bar (same pattern as the
 * ?token= sign-in link), and prefill the chat composer with it — the visitor
 * either sends it as-is ("generate my design") or types more details first.
 */
const KEY = 'bldr-incoming-brief';

/** Read ?brief= from the URL into sessionStorage and clean the address bar. */
export function adoptUrlBrief() {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    const brief = url.searchParams.get('brief');
    if (!brief || !brief.trim()) return;
    sessionStorage.setItem(KEY, brief.trim().slice(0, 2000));
    url.searchParams.delete('brief');
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
  } catch {
    /* malformed URL — ignore */
  }
}

/** One-shot: the adopted brief, or null. Clears it so it prefills only once.
 * Removal is deferred a tick so React StrictMode's synchronous double-run of
 * the consuming effect reads the same value both times. */
export function consumeIncomingBrief() {
  try {
    const v = sessionStorage.getItem(KEY);
    if (v) setTimeout(() => sessionStorage.removeItem(KEY), 0);
    return v;
  } catch {
    return null;
  }
}
