import { test } from 'node:test';
import assert from 'node:assert';
import { classify } from '../lib/classify.js';

const sentAt = '2026-08-27T10:00:00Z';
const later  = '2026-08-27T13:30:00Z';
const normal = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Safari/604.1';

test('a fetch carrying Daniel\'s own signed tag is him, never an open', () => {
  assert.equal(classify({ sentAt, at: later, userAgent: normal, ip: '73.9.1.2', isSelf: true }), 'self');
});

test('an open within 60s of send is a scanner, not a person', () => {
  assert.equal(classify({ sentAt, at: '2026-08-27T10:00:30Z', userAgent: normal, ip: '1.2.3.4' }), 'scanner');
});

test('Apple privacy relay is named, not counted as a read', () => {
  assert.equal(classify({ sentAt, at: later, userAgent: normal, ip: '17.58.20.4' }), 'privacy-proxy');
});

test('Gmail image proxy counts as a real open', () => {
  assert.equal(classify({ sentAt, at: later, userAgent: 'Mozilla/5.0 (compatible; GoogleImageProxy)', ip: '66.249.84.1' }), 'human');
});

test('a known security scanner is a scanner even hours later', () => {
  assert.equal(classify({ sentAt, at: later, userAgent: 'Barracuda Link Protect', ip: '64.235.1.1' }), 'scanner');
});

test('a headless fetcher is a scanner', () => {
  assert.equal(classify({ sentAt, at: later, userAgent: 'python-requests/2.31.0', ip: '5.6.7.8' }), 'scanner');
});

test('a later open by a normal client is human', () => {
  assert.equal(classify({ sentAt, at: later, userAgent: normal, ip: '73.9.1.2' }), 'human');
});

test('no user agent at all is unknown, not human', () => {
  assert.equal(classify({ sentAt, at: later, userAgent: '', ip: '73.9.1.2' }), 'unknown');
});

test('self beats every other rule, including the 60-second scanner rule', () => {
  assert.equal(classify({ sentAt, at: '2026-08-27T10:00:05Z', userAgent: normal, ip: '73.9.1.2', isSelf: true }), 'self');
});
