import { test } from 'node:test';
import assert from 'node:assert';
import { messagePath, parseMessagePath, eventPath, parseEventPath, enc, dec } from '../lib/paths.js';

test('a message round-trips through its pathname', () => {
  const p = messagePath({ day: '2026-08-27', token: '20260827T173455-abcdefghijkm',
                          recipient: 'reader-a1@example.test', subject: 'Re: Shoot dates — June?', source: 'mailmate' });
  const back = parseMessagePath(p);
  assert.deepEqual(back, { day: '2026-08-27', token: '20260827T173455-abcdefghijkm',
                           recipient: 'reader-a1@example.test', subject: 'Re: Shoot dates — June?',
                           source: 'mailmate', recipientCount: 0 });
});

test('the audience size round-trips, since attribution refuses to learn without it', () => {
  const p = messagePath({ day: '2026-08-27', token: '20260827T173455-abcdefghijkm',
                          recipient: 'a@b.com', subject: 'Hi', source: 'mailmate', recipientCount: 9 });
  assert.equal(parseMessagePath(p).recipientCount, 9);
});

test('a message registered before audience size existed still parses, as count 0', () => {
  const legacy = 'msg/2026-08-27/20260827T173455-abcdefghijkm/YUBiLmNvbQ/SGk/bWFpbG1hdGU.json';
  const back = parseMessagePath(legacy);
  assert.ok(back);
  assert.equal(back.recipientCount, 0, 'unknown audience must never be mistaken for one-to-one');
});

test('a subject full of punctuation and emoji survives', () => {
  const subject = 'Quote: 3 days @ $4,500/day — "final"? 📸 #shoot';
  const back = parseMessagePath(messagePath({ day: '2026-08-27', token: '20260827T173455-abcdefghijkm',
                                              recipient: 'a@b.com', subject, source: 'gmail-web' }));
  assert.equal(back.subject, subject);
});

test('an empty subject does not break the path', () => {
  const back = parseMessagePath(messagePath({ day: '2026-08-27', token: '20260827T173455-abcdefghijkm',
                                              recipient: 'a@b.com', subject: '', source: 'mailmate' }));
  assert.equal(back.subject, '');
  assert.equal(back.recipient, 'a@b.com');
});

test('a very long subject is truncated, not dropped', () => {
  const subject = 'x'.repeat(400);
  const back = parseMessagePath(messagePath({ day: '2026-08-27', token: '20260827T173455-abcdefghijkm',
                                              recipient: 'a@b.com', subject, source: 'mailmate' }));
  assert.equal(back.subject.length, 120);
});

test('an event round-trips, so listing a day needs no content fetches', () => {
  const p = eventPath({ day: '2026-08-27', token: '20260827T173455-abcdefghijkm',
                        at: '2026-08-27T18:04:12.123Z', kind: 'open', classification: 'human',
                        fingerprint: 'a1b2c3d4e5', nonce: 'q7' });
  const back = parseEventPath(p);
  assert.equal(back.token, '20260827T173455-abcdefghijkm');
  assert.equal(back.kind, 'open');
  assert.equal(back.classification, 'human');
  assert.equal(back.at, '2026-08-27T18:04:12Z');
  assert.equal(back.fingerprint, 'a1b2c3d4e5');
});

test('events written before per-reader tracking still parse, rather than vanishing', () => {
  const legacy = 'ev/2026-08-27/20260827T173455-abcdefghijkm/20260827T180412123Z__open__human__q7.json';
  const back = parseEventPath(legacy);
  assert.ok(back, 'a day of history must not disappear when the format grows');
  assert.equal(back.classification, 'human');
  assert.equal(back.fingerprint, null);
});

test('the shared Gmail bucket survives the pathname', () => {
  const p = eventPath({ day: '2026-08-27', token: '20260827T173455-abcdefghijkm',
                        at: '2026-08-27T18:04:12.000Z', kind: 'open', classification: 'human',
                        fingerprint: 'gmail-proxy', nonce: 'z1' });
  assert.equal(parseEventPath(p).fingerprint, 'gmail-proxy');
});

test('every classification survives the pathname, hyphen included', () => {
  for (const c of ['human', 'scanner', 'privacy-proxy', 'self', 'unknown']) {
    const p = eventPath({ day: '2026-08-27', token: '20260827T173455-abcdefghijkm',
                          at: '2026-08-27T18:04:12.000Z', kind: 'click', classification: c, nonce: 'z1' });
    assert.equal(parseEventPath(p).classification, c, `failed for ${c}`);
  }
});

test('rubbish pathnames parse to null rather than half a record', () => {
  assert.equal(parseMessagePath('nonsense'), null);
  assert.equal(parseEventPath('ev/broken'), null);
});

test('base64url encoding leaves nothing that breaks a URL path', () => {
  const round = dec(enc('a/b+c=d?e#f'));
  assert.equal(round, 'a/b+c=d?e#f');
  assert.ok(!/[/+=]/.test(enc('a/b+c=d')));
});

test('an empty recipient still occupies its path segment', () => {
  // '' collapsed to a double slash, which the store folds away — a recipient-less
  // registration came back with its source sitting in the subject position.
  const p = messagePath({ day: '2026-08-29', token: '20260829T154739-ub3tLWbrxdpK',
                          recipient: '', subject: 'compare', source: 'apple-mail', recipientCount: 0 });
  assert.ok(!p.includes('//'), 'no collapsing double slash');
  const back = parseMessagePath(p);
  assert.equal(back.recipient, '');
  assert.equal(back.subject, 'compare');
  assert.equal(back.source, 'apple-mail');
});

test('the device family rides the pathname and round-trips', () => {
  const p = eventPath({ day: '2026-08-29', token: '20260829T170258-8zWxTJrxmTq4',
                        at: '2026-08-29T17:10:07.000Z', kind: 'open', classification: 'human',
                        fingerprint: '9708e1866d', device: 'ios~safari', nonce: 'q7' });
  const back = parseEventPath(p);
  assert.equal(back.device, 'ios|safari');
  assert.equal(back.fingerprint, '9708e1866d');
});

test('fingerprint-only events (before device existed) still parse, device null', () => {
  const legacy = 'ev/2026-08-29/20260829T170258-8zWxTJrxmTq4/20260829T171007000Z__open__human__9708e1866d__q7.json';
  const back = parseEventPath(legacy);
  assert.equal(back.fingerprint, '9708e1866d');
  assert.equal(back.device, null);
});
