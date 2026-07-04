/**
 * Pure-function tests for the assistant-text transform.
 * Run: npx tsx src/components/chat/utils/chatFormatting.test.ts
 *
 * Guards the "renders wrong until refresh" fix: live-streamed (stream_delta) and
 * hydrated (text) assistant messages MUST route through normalizeAssistantText so
 * they produce byte-identical content. Any divergence reintroduces the bug.
 */
import assert from 'node:assert';

import { normalizeAssistantText } from './chatFormatting';

let n = 0;
function test(name: string, fn: () => void) {
  fn();
  n++;
  console.log('  ok', name);
}

test('plain text is unchanged', () => {
  assert.equal(normalizeAssistantText('Hello **world**'), 'Hello **world**');
});

test('html entities are decoded', () => {
  assert.equal(normalizeAssistantText('Use &lt;div&gt; &amp; &quot;q&quot;'), 'Use <div> & "q"');
});

test('escaped newlines become real newlines (fixes broken code fences while streaming)', () => {
  assert.equal(
    normalizeAssistantText('```js\\nconst x = 1;\\nconsole.log(x);\\n```'),
    '```js\nconst x = 1;\nconsole.log(x);\n```',
  );
});

test('math spans are preserved (not unescaped)', () => {
  assert.equal(normalizeAssistantText('value $\\alpha$ and $$x^2$$'), 'value $\\alpha$ and $$x^2$$');
});

test('empty content is passed through', () => {
  assert.equal(normalizeAssistantText(''), '');
});

console.log(`\n${n} passed`);
