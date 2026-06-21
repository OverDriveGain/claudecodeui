/* Pure unit tests for the session event-log core. Run: npx tsx src/stores/sessionLog.test.ts */
import { deriveLog, rewriteMessageSessionId, sameMessage, type NormalizedMessage } from './sessionLog';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; }
  else { fail++; console.error(`  ✗ ${name} ${extra}`); }
}
function ids(list: NormalizedMessage[]) { return list.map((m) => m.id).join(','); }

function msg(p: Partial<NormalizedMessage> & { id: string; timestamp: string }): NormalizedMessage {
  return { sessionId: 's', provider: 'claude', kind: 'text', ...p } as NormalizedMessage;
}
function logOf(...msgs: NormalizedMessage[]) {
  const m = new Map<string, NormalizedMessage>();
  for (const x of msgs) m.set(x.id, x);
  return m;
}

// 1. Chronological order regardless of insertion order.
{
  const log = logOf(
    msg({ id: 'C', timestamp: '2026-01-01T00:00:03Z', role: 'assistant' }),
    msg({ id: 'A', timestamp: '2026-01-01T00:00:01Z', role: 'user', content: 'a' }),
    msg({ id: 'B', timestamp: '2026-01-01T00:00:02Z', role: 'assistant', content: 'b' }),
  );
  check('order: sorts by timestamp not insertion', ids(deriveLog(log)) === 'A,B,C', ids(deriveLog(log)));
}

// 2. Replace-by-id keeps position and updates content.
{
  const log = logOf(
    msg({ id: 'A', timestamp: '2026-01-01T00:00:01Z', kind: 'tool_use' }),
    msg({ id: 'B', timestamp: '2026-01-01T00:00:02Z', role: 'assistant', content: 'b' }),
  );
  log.set('A', msg({ id: 'A', timestamp: '2026-01-01T00:00:01Z', kind: 'tool_use', content: 'updated' }));
  const out = deriveLog(log);
  check('replace: keeps order', ids(out) === 'A,B', ids(out));
  check('replace: updates content', out[0].content === 'updated');
}

// 3. Swallow scenario: a stale server upsert (subset) cannot drop the live reply.
{
  const log = logOf(
    msg({ id: 'u1', timestamp: '2026-01-01T00:00:01Z', role: 'user', content: 'hi' }),
    msg({ id: 'r1', timestamp: '2026-01-01T00:00:02Z', role: 'assistant', content: 'reply' }),
  );
  // "stale fetch" re-upserts only the older message — reply must remain.
  log.set('u1', msg({ id: 'u1', timestamp: '2026-01-01T00:00:01Z', role: 'user', content: 'hi' }));
  check('swallow: reply survives stale re-upsert', ids(deriveLog(log)) === 'u1,r1', ids(deriveLog(log)));
}

// 4. Optimistic echo dedup: local_ + real user, same text → only real.
{
  const log = logOf(
    msg({ id: 'local_1', timestamp: '2026-01-01T00:00:01Z', role: 'user', content: 'hello' }),
    msg({ id: 'uuidU', timestamp: '2026-01-01T00:00:01Z', role: 'user', content: 'hello' }),
  );
  const out = deriveLog(log);
  check('echo: one user row', out.length === 1, `len=${out.length}`);
  check('echo: keeps the real (non-local) id', out[0]?.id === 'uuidU', out[0]?.id);
}

// 5. Streaming → finalize → server copy collapse to one assistant row.
{
  // After finalize the placeholder is gone; we keep the finalized text + server text.
  const log = logOf(
    msg({ id: 'text_final', timestamp: '2026-01-01T00:00:02Z', role: 'assistant', kind: 'text', content: 'answer' }),
    msg({ id: 'uuidA', timestamp: '2026-01-01T00:00:02Z', role: 'assistant', kind: 'text', content: 'answer' }),
  );
  check('stream: duplicate assistant text collapsed', deriveLog(log).length === 1, `len=${deriveLog(log).length}`);

  // Live placeholder vs server copy (same content) also collapses.
  const log2 = logOf(
    msg({ id: '__streaming_s', timestamp: '2026-01-01T00:00:02Z', role: 'assistant', kind: 'stream_delta', content: 'answer' }),
    msg({ id: 'uuidA', timestamp: '2026-01-01T00:00:02Z', role: 'assistant', kind: 'text', content: 'answer' }),
  );
  const out2 = deriveLog(log2);
  check('stream: placeholder collapses into real text', out2.length === 1 && out2[0].kind === 'text', ids(out2));
}

// 6. Out-of-order replay: a reconnect re-adds a missed mid-turn frame; sort fixes it.
{
  const log = logOf(
    msg({ id: 'tu', timestamp: '2026-01-01T00:00:01Z', kind: 'tool_use' }),
    msg({ id: 'txt', timestamp: '2026-01-01T00:00:03Z', role: 'assistant', content: 'done' }),
  );
  // Replay re-sends tool_use (same id, no-op) and the missed tool_result (t2), appended last.
  log.set('tu', msg({ id: 'tu', timestamp: '2026-01-01T00:00:01Z', kind: 'tool_use' }));
  log.set('tr', msg({ id: 'tr', timestamp: '2026-01-01T00:00:02Z', kind: 'tool_result' }));
  check('replay: late frame sorts into correct slot', ids(deriveLog(log)) === 'tu,tr,txt', ids(deriveLog(log)));
}

// 7. Same-timestamp blocks keep emission (insertion) order — tool_use before its text.
{
  const log = logOf(
    msg({ id: 'tu', timestamp: '2026-01-01T00:00:05Z', kind: 'tool_use' }),
    msg({ id: 'tx', timestamp: '2026-01-01T00:00:05Z', role: 'assistant', content: 'after tool' }),
  );
  check('tiebreak: equal timestamps keep insertion order', ids(deriveLog(log)) === 'tu,tx', ids(deriveLog(log)));
}

// 8. rewriteMessageSessionId rewrites sessionId + the streaming placeholder id.
{
  const a = rewriteMessageSessionId(msg({ id: '__streaming_old', sessionId: 'old', timestamp: 't' }), 'old', 'new');
  check('rewrite: streaming id rewritten', a.id === '__streaming_new' && a.sessionId === 'new', a.id);
  const b = rewriteMessageSessionId(msg({ id: 'keep', sessionId: 'old', timestamp: 't' }), 'old', 'new');
  check('rewrite: normal id kept, sessionId changed', b.id === 'keep' && b.sessionId === 'new');
}

// 9. sameMessage: identical content equal; any change not.
{
  const a = msg({ id: 'm', timestamp: 't1', role: 'assistant', content: 'hello' });
  const b = msg({ id: 'm', timestamp: 't1', role: 'assistant', content: 'hello' });
  const c = msg({ id: 'm', timestamp: 't1', role: 'assistant', content: 'hello!' });
  check('sameMessage: identical → equal', sameMessage(a, b) === true);
  check('sameMessage: content diff → not equal', sameMessage(a, c) === false);
}

// 10. Idempotent upsert: re-applying identical server messages keeps refs (no churn).
{
  const m1 = msg({ id: 'a', timestamp: 't1', role: 'user', content: 'hi' });
  const m2 = msg({ id: 'b', timestamp: 't2', role: 'assistant', content: 'yo' });
  const log = new Map<string, NormalizedMessage>();
  const upsert = (msgs: NormalizedMessage[]) => {
    let changed = false;
    for (const m of msgs) { const cur = log.get(m.id); if (cur && sameMessage(cur, m)) continue; log.set(m.id, m); changed = true; }
    return changed;
  };
  check('upsert: first apply changes', upsert([m1, m2]) === true);
  const refA = log.get('a');
  // Re-fetch returns fresh-but-identical objects (new references, same content).
  check('upsert: identical re-apply is no-op', upsert([{ ...m1 }, { ...m2 }]) === false);
  check('upsert: kept the existing object reference', log.get('a') === refA);
  // A real change is detected.
  check('upsert: changed message applies', upsert([{ ...m2, content: 'changed' }]) === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
