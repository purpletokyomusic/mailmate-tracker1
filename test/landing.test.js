import { test } from 'node:test';
import assert from 'node:assert';
import { landing } from '../handlers/landing.js';

test('the landing page reports the address and that a secret is set', async () => {
  const res = landing(new Request('https://tracker.test/'), { TRACKER_SECRET: 'x' });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Your MailMate tracker is running/);
  assert.match(body, /https:\/\/tracker\.test/);
  assert.match(body, /Secret: <strong>set ✓<\/strong>/);
  assert.doesNotMatch(body, /NOT SET/);
});

test('the landing page says when no secret is configured, without ever printing one', async () => {
  const res = landing(new Request('https://tracker.test/'), {});
  const body = await res.text();
  assert.match(body, /Secret: <strong>NOT SET<\/strong>/);
  assert.match(body, /Variables and Secrets/);
});

test('the landing page never reads or touches the store', async () => {
  // No `env.DB` at all — if this handler ever tried to query it, this would throw.
  const res = landing(new Request('https://tracker.test/'), { TRACKER_SECRET: 'x' });
  assert.equal(res.status, 200);
});

test('the landing page is never cached', () => {
  const res = landing(new Request('https://tracker.test/'), { TRACKER_SECRET: 'x' });
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('the address shown is whatever origin the request actually arrived on', async () => {
  const res = landing(new Request('https://custom.example/'), { TRACKER_SECRET: 'x' });
  const body = await res.text();
  assert.match(body, /https:\/\/custom\.example/);
});
