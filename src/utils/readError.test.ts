import assert from 'node:assert/strict';
import test from 'node:test';

import { errorText, pickErrorMessage } from './readError';

test('errorText: structured envelope (the mansoor [object Object] bug)', () => {
  const body = { success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password' } };
  assert.equal(errorText(body), 'Invalid username or password');
});

test('errorText: flat { error: string }', () => {
  assert.equal(errorText({ error: 'Login failed' }), 'Login failed');
});

test('errorText: top-level { message }', () => {
  assert.equal(errorText({ message: 'Boom' }), 'Boom');
});

test('errorText: Error instance uses its message', () => {
  assert.equal(errorText(new Error('Failed to fetch')), 'Failed to fetch');
});

test('errorText: plain string passes through', () => {
  assert.equal(errorText('nope'), 'nope');
});

test('errorText: nullish → empty (no error → render nothing)', () => {
  assert.equal(errorText(null), '');
  assert.equal(errorText(undefined), '');
});

test('errorText: a raw object with no message never yields [object Object]', () => {
  assert.equal(errorText({ weird: { nested: true } }), 'Something went wrong');
});

test('errorText: envelope whose message is literally "[object Object]" is rejected', () => {
  // Guards against a double-garble (server already stringified an object).
  assert.equal(errorText({ error: { message: '[object Object]' } }, 'Login failed'), 'Login failed');
});

test('errorText: structured envelope falls back to code when message missing', () => {
  assert.equal(errorText({ error: { code: 'FORBIDDEN' } }), 'FORBIDDEN');
});

test('errorText: custom fallback used when truthy-but-empty', () => {
  assert.equal(errorText({ error: '' }, 'Connection failed'), 'Connection failed');
});

test('pickErrorMessage: empty body falls back to HTTP status line', () => {
  assert.equal(pickErrorMessage(null, 502, 'Bad Gateway'), 'HTTP 502 Bad Gateway');
});

test('pickErrorMessage: body message wins over status', () => {
  assert.equal(pickErrorMessage({ error: { message: 'Nope' } }, 500, 'Internal Server Error'), 'Nope');
});
