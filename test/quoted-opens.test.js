import { test } from 'node:test';
import assert from 'node:assert';
import { demoteQuotedOpens } from '../lib/quoted-opens.js';

const msg = (token, sentAt, events) => ({ token, sentAt, events });
const open = (at, fp) => ({ at, kind: 'open', classification: 'human', fingerprint: fp });
const humans = (m) => m.events.filter((e) => e.classification === 'human').length;

test('a pixel quoted inside a newer reply does not count as its own open', () => {
  const older = msg('t-old', '2026-08-27T18:00:00Z', [open('2026-08-29T15:00:01Z', 'reader-1')]);
  const newer = msg('t-new', '2026-08-29T14:00:00Z', [open('2026-08-29T15:00:00Z', 'reader-1')]);
  demoteQuotedOpens([older, newer]);
  assert.equal(humans(newer), 1, 'the message actually opened must still count');
  assert.equal(humans(older), 0, 'the quoted pixel must not count');
  assert.equal(older.events[0].classification, 'quoted', 'and it must be recorded, not deleted');
});

test('two genuinely separate readings still count twice', () => {
  const a = msg('t-a', '2026-08-27T18:00:00Z', [open('2026-08-29T15:00:00Z', 'reader-1')]);
  const b = msg('t-b', '2026-08-28T18:00:00Z', [open('2026-08-29T18:00:00Z', 'reader-1')]);
  demoteQuotedOpens([a, b]);
  assert.equal(humans(a), 1);
  assert.equal(humans(b), 1);
});

test('two different people opening at the same moment both count', () => {
  const a = msg('t-a', '2026-08-27T18:00:00Z', [open('2026-08-29T15:00:00Z', 'reader-1')]);
  const b = msg('t-b', '2026-08-28T18:00:00Z', [open('2026-08-29T15:00:02Z', 'reader-2')]);
  demoteQuotedOpens([a, b]);
  assert.equal(humans(a), 1, 'different readers are never each others quoted pixels');
  assert.equal(humans(b), 1);
});

test('the NEWEST message wins even when its pixel loads second', () => {
  const older = msg('t-old', '2026-08-27T18:00:00Z', [open('2026-08-29T15:00:00Z', 'r')]);
  const newer = msg('t-new', '2026-08-29T14:00:00Z', [open('2026-08-29T15:00:05Z', 'r')]);
  demoteQuotedOpens([older, newer]);
  assert.equal(humans(newer), 1);
  assert.equal(humans(older), 0);
});

test('a burst of three keeps only the newest', () => {
  const m1 = msg('t1', '2026-08-25T10:00:00Z', [open('2026-08-29T15:00:00Z', 'r')]);
  const m2 = msg('t2', '2026-08-26T10:00:00Z', [open('2026-08-29T15:00:01Z', 'r')]);
  const m3 = msg('t3', '2026-08-27T10:00:00Z', [open('2026-08-29T15:00:02Z', 'r')]);
  demoteQuotedOpens([m1, m2, m3]);
  assert.deepEqual([humans(m1), humans(m2), humans(m3)], [0, 0, 1]);
});

test('a lone open is never demoted', () => {
  const only = msg('t', '2026-08-27T18:00:00Z', [open('2026-08-29T15:00:00Z', 'r')]);
  demoteQuotedOpens([only]);
  assert.equal(humans(only), 1);
});

test('scanner and self opens are left entirely alone', () => {
  const m = msg('t', '2026-08-27T18:00:00Z', [
    { at: '2026-08-29T15:00:00Z', kind: 'open', classification: 'self', fingerprint: 'r' },
    { at: '2026-08-29T15:00:01Z', kind: 'open', classification: 'scanner', fingerprint: 'r' },
  ]);
  demoteQuotedOpens([m]);
  assert.deepEqual(m.events.map((e) => e.classification), ['self', 'scanner']);
});
