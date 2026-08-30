import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveApiErrorCode, resolveApiErrorMessage } from './utils';

// The wrong-password regression: /api/auth/login rejects through the global
// AppError handler, whose body is { success:false, error:{ code, message } }.
// The old resolver returned the error OBJECT, which the login alert then tried
// to render as text. These pin the resolver to always produce a string + code.
const wrongPasswordBody = {
  success: false,
  error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid username or password' },
};

test('resolveApiErrorMessage: structured envelope yields the message string', () => {
  assert.equal(resolveApiErrorMessage(wrongPasswordBody, 'Login failed'), 'Invalid username or password');
});

test('resolveApiErrorMessage: flat { error: string } still works', () => {
  assert.equal(resolveApiErrorMessage({ error: 'nope' }, 'Login failed'), 'nope');
});

test('resolveApiErrorMessage: null payload falls back', () => {
  assert.equal(resolveApiErrorMessage(null, 'Login failed'), 'Login failed');
});

test('resolveApiErrorMessage: empty/garbage body falls back, never blank', () => {
  assert.equal(resolveApiErrorMessage({}, 'Login failed'), 'Login failed');
  assert.equal(resolveApiErrorMessage({ error: '' }, 'Login failed'), 'Login failed');
});

test('resolveApiErrorCode: reads the envelope code', () => {
  assert.equal(resolveApiErrorCode(wrongPasswordBody), 'AUTH_INVALID_CREDENTIALS');
});

test('resolveApiErrorCode: top-level code and absent code', () => {
  assert.equal(resolveApiErrorCode({ code: 'AUTH_TOKEN_EXPIRED' }), 'AUTH_TOKEN_EXPIRED');
  assert.equal(resolveApiErrorCode({ error: 'plain string' }), null);
  assert.equal(resolveApiErrorCode(null), null);
});
