import { test } from 'node:test';
import assert from 'node:assert';
import { ipHash } from '../lib/selfips.js';

// The secret is passed explicitly now rather than read from process.env. Workers has no ambient
// environment — `env` is handed to the request — so every caller supplies it, and the tests say
// so too.
const S = 'test-secret';

test('the same network hashes the same way every time', () => {
  assert.equal(ipHash('73.9.1.2', S), ipHash('73.9.1.2', S));
});

test('different networks do not collide', () => {
  assert.notEqual(ipHash('73.9.1.2', S), ipHash('73.9.1.3', S));
});

test("the sender's IP address is never stored in the clear", () => {
  const ip = '73.9.1.2';
  const h = ipHash(ip, S);
  // This used to assert the hash did not contain the substring '73'. That is two hex characters,
  // which turn up in a random 24-character hex digest about half the time — the assertion passed
  // on luck and failed the first time the digest changed for an unrelated reason. What it was
  // reaching for is that the ADDRESS must not survive into the hash, so that is what it says now.
  assert.ok(!h.includes(ip), 'the address must not appear in the hash');
  assert.ok(!h.includes(ip.replace(/\./g, '')), 'nor with its dots stripped');
  assert.match(h, /^[0-9a-f]{24}$/);
});

test('the hash is keyed, so one deployment cannot recognise another one\'s networks', () => {
  assert.notEqual(ipHash('73.9.1.2', S), ipHash('73.9.1.2', 'a-different-secret'));
});
