import { test } from 'node:test';
import assert from 'node:assert';
import { clientIp, secretsMatch, authorized } from '../lib/http.js';

const req = (headers = {}) => new Request('https://tracker.example/events', { headers });

// ── who is asking ───────────────────────────────────────────────────────────────────────────

test('the address comes from Cloudflare, not from the caller', () => {
  // The whole point. X-Forwarded-For is written by whoever is calling, so a stranger could set
  // it to the sender's own network and have their opens filed as `self` — recorded but never
  // counted, which is to say: erased from the numbers. CF-Connecting-IP is set by Cloudflare
  // itself and must win whenever both are present.
  assert.equal(
    clientIp(req({ 'cf-connecting-ip': '72.152.1.4', 'x-forwarded-for': '9.9.9.9' })),
    '72.152.1.4',
  );
});

test('X-Forwarded-For is still read when Cloudflare has not set its own header', () => {
  // This is the `wrangler dev` case, where the request never passed through Cloudflare.
  assert.equal(clientIp(req({ 'x-forwarded-for': '72.152.1.4, 10.0.0.1' })), '72.152.1.4');
});

test('no address at all is an empty string, never a crash', () => {
  assert.equal(clientIp(req()), '');
});

// ── the secret ──────────────────────────────────────────────────────────────────────────────

test('a matching secret is accepted', () => {
  assert.equal(secretsMatch('hunter2', 'hunter2'), true);
});

test('a wrong secret, a prefix of it, and a longer one are all rejected', () => {
  assert.equal(secretsMatch('hunter2', 'hunter3'), false);
  assert.equal(secretsMatch('hunter', 'hunter2'), false);
  assert.equal(secretsMatch('hunter2x', 'hunter2'), false);
});

test('an empty secret never matches, including against another empty one', () => {
  // Fails closed: an unconfigured deployment must refuse, not admit everybody.
  assert.equal(secretsMatch('', ''), false);
  assert.equal(secretsMatch('', 'hunter2'), false);
  assert.equal(secretsMatch(null, undefined), false);
});

test('authorized() requires the header and a configured secret', () => {
  const withHeader = req({ 'x-tracker-secret': 'hunter2' });
  assert.equal(authorized(withHeader, { TRACKER_SECRET: 'hunter2' }), true);
  assert.equal(authorized(withHeader, { TRACKER_SECRET: 'wrong' }), false);
  // An unset secret must never mean "let everyone in".
  assert.equal(authorized(withHeader, {}), false);
  assert.equal(authorized(req(), { TRACKER_SECRET: 'hunter2' }), false);
});
