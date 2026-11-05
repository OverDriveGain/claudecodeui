// A new chat in a project whose folder was moved or deleted used to fail with the
// SDK's misleading "Claude Code native binary not found at claude" (spawn ENOENT
// from the missing cwd). The runtime must report the missing folder instead.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { queryClaudeSDK } from '../list/claude/claude-runtime.provider.js';

test('a missing project folder is reported plainly and nothing is spawned', async () => {
  const sent: Array<{ kind?: string; content?: string; exitCode?: number }> = [];
  const ws = { send: (frame: { kind?: string }) => { sent.push(frame); } };
  let resumeModelCalls = 0;
  const context = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => { resumeModelCalls += 1; return null; },
  };

  await queryClaudeSDK('hello', { cwd: '/nonexistent/mymu-deleted-project' }, ws, context);

  const error = sent.find((f) => f.kind === 'error');
  assert.ok(error, 'an error frame is sent');
  assert.match(error.content || '', /Project folder not found: \/nonexistent\/mymu-deleted-project/);
  assert.doesNotMatch(error.content || '', /native binary/);
  assert.ok(sent.some((f) => f.kind === 'complete' && f.exitCode === 1), 'the turn is closed');
  assert.equal(resumeModelCalls, 0, 'returned before any SDK setup');
});
