import { test } from 'node:test';
import assert from 'node:assert';
import { selfTag, isSelfFetch } from '../lib/selftag.js';

const S = 'test-secret';

test('the same machine gets the same tag', () => {
  assert.equal(selfTag('73.9.1.2', S), selfTag('73.9.1.2', S));
});

test('a different machine gets a different tag', () => {
  assert.notEqual(selfTag('73.9.1.2', S), selfTag('8.8.8.8', S));
});

test('the tag does not contain the IP it was made from', () => {
  assert.ok(!selfTag('73.9.1.2', S).includes('73'), 'tag must not leak the sender network');
});

test('a fetch from the registering machine is recognised', () => {
  assert.equal(isSelfFetch(selfTag('73.9.1.2', S), '73.9.1.2', S), true);
});

test('a recipient is never mistaken for Daniel', () => {
  assert.equal(isSelfFetch(selfTag('73.9.1.2', S), '52.4.9.9', S), false);
});

test('a missing tag fails closed — an unknown fetch is not called self', () => {
  assert.equal(isSelfFetch('', '73.9.1.2', S), false);
  assert.equal(isSelfFetch('x', '73.9.1.2', S), false);
});

test('a forged tag does not pass without the secret', () => {
  assert.equal(isSelfFetch(selfTag('73.9.1.2', 'wrong-secret'), '73.9.1.2', S), false);
});
