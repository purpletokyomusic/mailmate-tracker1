import { test } from 'node:test';
import assert from 'node:assert';
import { newToken, dayOf, sentAtOf, isValidToken } from '../lib/token.js';

test('a token carries its own send time, so the pixel needs no lookup', () => {
  const tok = newToken(new Date('2026-08-27T17:34:55Z'));
  assert.match(tok, /^20260827T173455-[A-Za-z2-9]{12}$/);
  assert.equal(dayOf(tok), '2026-08-27');
  assert.equal(sentAtOf(tok).toISOString(), '2026-08-27T17:34:55.000Z');
});

test('tokens do not repeat', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(newToken());
  assert.equal(seen.size, 500);
});

test('a token with no timestamp is rejected rather than guessed at', () => {
  for (const bad of ['garbage', '', undefined, '20260827-abcdefghijkm']) {
    assert.equal(dayOf(bad), null);
    assert.equal(sentAtOf(bad), null);
    assert.equal(isValidToken(bad), false);
  }
});

test('look-alike characters are absent, so a token can be read off a screen', () => {
  assert.ok(!/[0O1lI]/.test(newToken().split('-')[1]));
});
