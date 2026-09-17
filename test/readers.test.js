import { test } from 'node:test';
import assert from 'node:assert';
import { addressesIn, audienceOf, learnProfiles, readersOf, annotate } from '../lib/readers.js';

const open = (fp, at = '2026-08-27T18:00:00Z') =>
  ({ at, kind: 'open', classification: 'human', fingerprint: fp });

test('addresses come out of any recipient format', () => {
  assert.deepEqual(addressesIn('Jamie Reed <jreed@g.com>'), ['jreed@g.com']);
  assert.deepEqual(addressesIn('a@b.com, Rick <r@d.com>'), ['a@b.com', 'r@d.com']);
  assert.deepEqual(addressesIn(''), []);
});

test('a one-to-one email teaches that person’s fingerprint', () => {
  const p = learnProfiles([{ recipient: 'lisa@g.com', recipientCount: 1, events: [open('fp-lisa')] }]);
  assert.equal(p['fp-lisa'], 'lisa@g.com');
});

test('a GROUP email teaches nothing — the whole point of the design', () => {
  const p = learnProfiles([{ recipient: 'a@b.com', recipientCount: 9, events: [open('fp-someone')] }]);
  assert.deepEqual(p, {}, 'group mail must never bind a fingerprint to a person');
});

test('a message whose audience was NOT reported teaches nothing', () => {
  // The bug this guards: a reply to one person cc'd to eight arrives with only the To address,
  // so it looks one-to-one and would teach a fingerprint that belongs to any of the nine.
  const p = learnProfiles([{ recipient: 'lisa@g.com', events: [open('fp-maybe-lisa')] }]);
  assert.deepEqual(p, {}, 'without a reported audience size, nothing may be learned');
  const p2 = learnProfiles([{ recipient: 'lisa@g.com', recipientCount: 0, events: [open('fp')] }]);
  assert.deepEqual(p2, {});
});

test('shared buckets are never bound to a person', () => {
  const p = learnProfiles([{ recipient: 'lisa@g.com', recipientCount: 1, events: [open('gmail-proxy'), open('apple-proxy')] }]);
  assert.deepEqual(p, {});
});

test('scanner and self opens teach nothing', () => {
  const p = learnProfiles([{ recipient: 'lisa@g.com', recipientCount: 1, events: [
    { at: '2026-08-27T18:00:00Z', kind: 'open', classification: 'scanner', fingerprint: 'fp-x' },
    { at: '2026-08-27T18:00:00Z', kind: 'open', classification: 'self', fingerprint: 'fp-y' },
  ] }]);
  assert.deepEqual(p, {});
});

test('a learned fingerprint names a reader on a later group email whose KNOWN audience includes them', () => {
  const messages = [
    { recipient: 'lisa@g.com', recipientCount: 1, events: [open('fp-lisa')] },
    { recipient: 'lisa@g.com', recipientCount: 3, recipients: ['lisa@g.com', 'a@b.com', 'c@d.com'],
      events: [open('fp-lisa'), open('fp-stranger')] },
  ];
  annotate(messages);
  assert.deepEqual(messages[1].readers.named, ['lisa@g.com']);
  assert.equal(messages[1].readers.unnamed, 1);
});

// 2026-09-14, tightened same day: Rule A used to leave a learned name standing whenever a
// message's audience simply wasn't known, rather than requiring it be known and include the
// person. A 31-day replay found that cost almost nothing — 2 of 50 named-reader instances, both
// on 2026-08-31 records that predate the client sending `recipients_json` at all — so the file's
// own principle (a wrong name is worse than no name) wins: no audience, no name.
test('a learned fingerprint is UNNAMED on a later group email whose audience was never reported', () => {
  const messages = [
    { recipient: 'lisa@g.com', recipientCount: 1, events: [open('fp-lisa')] },
    { recipient: 'lisa@g.com', recipientCount: 3, events: [open('fp-lisa'), open('fp-stranger')] },
  ];
  annotate(messages);
  assert.deepEqual(messages[1].readers.named, [], 'no explicit audience was ever reported for this message');
  assert.equal(messages[1].readers.unnamed, 2);
});

test('one person opening five times is one reader', () => {
  const m = { recipient: 'a@b.com, c@d.com', events: [open('fp1'), open('fp1'), open('fp1')] };
  assert.equal(readersOf(m, {}).unnamed, 1);
});

test('every Gmail reader counts as exactly one unnamed reader, never a number we invented', () => {
  const m = { recipient: 'a@b.com, c@d.com, e@f.com', events: [open('gmail-proxy'), open('gmail-proxy')] };
  const r = readersOf(m, {});
  assert.deepEqual(r.named, []);
  assert.equal(r.unnamed, 1);
});

test('a message nobody opened has no readers', () => {
  assert.deepEqual(readersOf({ recipient: 'a@b.com', events: [] }, {}), { named: [], unnamed: 0 });
});

test('a fingerprint that was ever SELF is never learned, and its human opens become self', () => {
  const msgs = [
    // his own Mac, seen as self on one message...
    { recipientCount: 1, recipient: 'marshall@x.com',
      events: [{ kind: 'open', classification: 'self', fingerprint: 'mac1' }] },
    // ...counted human on a one-to-one email after his IP changed (2026-09-02)
    { recipientCount: 1, recipient: 'pat@y.com',
      events: [{ kind: 'open', classification: 'human', fingerprint: 'mac1' }] },
    // ...and then "named" as Pat on somebody else's thread
    { recipientCount: 3, recipient: 'sara@z.com',
      events: [{ kind: 'open', classification: 'human', fingerprint: 'mac1' }] },
  ];
  const out = annotate(msgs);
  assert.deepEqual(learnProfiles(msgs), {});
  assert.deepEqual(out[2].readers, { named: [], unnamed: 0 });
  assert.equal(out[1].events[0].classification, 'self');
  assert.equal(out[2].events[0].classification, 'self');
});

test('a fingerprint that opens one-to-one mail to two different people is nobody', () => {
  const msgs = [
    { recipientCount: 1, recipient: 'a@x.com',
      events: [{ kind: 'open', classification: 'human', fingerprint: 'relay' }] },
    { recipientCount: 1, recipient: 'b@y.com',
      events: [{ kind: 'open', classification: 'human', fingerprint: 'relay' }] },
    { recipientCount: 2, recipient: 'c@z.com',
      events: [{ kind: 'open', classification: 'human', fingerprint: 'relay' }] },
  ];
  const out = annotate(msgs);
  assert.deepEqual(learnProfiles(msgs), {});
  assert.deepEqual(out[2].readers, { named: [], unnamed: 1 });
  assert.equal(out[2].events[0].classification, 'human', 'a relay is unnamed, not self');
});

// --- 2026-09-14: a real incident this pair of tests reproduces ---------------------------------
// A fingerprint was learned as one specific person from a single genuine 1:1 open, but the same
// device also opened a multi-recipient group thread whose reported recipients_json never
// included that person — and readersOf named them on it anyway, because a learned fingerprint
// used to be named on ANY message regardless of that message's own audience.

test('audienceOf reads the explicit recipients list over recipientCount', () => {
  const known = audienceOf({
    recipientCount: 3,
    recipient: 'alex@i.com',
    recipients: ['Alex <alex@i.com>', 'hello@j.com'],
  });
  assert.deepEqual(known, new Set(['alex@i.com', 'hello@j.com']));
});

test('audienceOf falls back to `recipient` only for a reported single recipient', () => {
  assert.deepEqual(audienceOf({ recipientCount: 1, recipient: 'lisa@g.com' }), new Set(['lisa@g.com']));
  assert.equal(audienceOf({ recipientCount: 3, recipient: 'lisa@g.com' }), null, 'no explicit list, count > 1: unknown');
  assert.equal(audienceOf({ recipientCount: 0, recipient: 'lisa@g.com' }), null);
});

test('a fingerprint learned from a real 1:1 open is NOT learned if it also opens a group message whose known audience excludes that person', () => {
  const msgs = [
    // one real 1:1 open — this is what taught the fingerprint "Priya" before the fix
    { recipientCount: 1, recipient: 'priya@k.com',
      events: [open('fp-priya')] },
    // the group thread: known audience, and Priya is not on it
    { recipientCount: 2, recipient: 'alex@i.com',
      recipients: ['alex@i.com', 'hello@j.com'],
      events: [open('fp-priya'), open('fp-priya'), open('fp-priya'), open('fp-priya'), open('fp-priya')] },
  ];
  const out = annotate(msgs);
  assert.deepEqual(learnProfiles(msgs), {}, 'the contradicted fingerprint must not be learned at all');
  assert.deepEqual(out[1].readers.named, [], 'Priya must not be named on the group thread');
  assert.equal(out[1].readers.unnamed, 1);
});

test('Rule A: a legitimately learned fingerprint is unnamed on a DIFFERENT message whose known audience excludes it', () => {
  // Constructed directly against readersOf (bypassing learnProfiles) so this pins Rule A on its
  // own, independent of whatever learnProfiles decides to keep.
  const profiles = { 'fp-mia': 'mia@guest.com' };
  const excludes = readersOf({
    recipientCount: 2,
    recipient: 'someone@else.com',
    recipients: ['someone@else.com', 'another@else.com'],
    events: [open('fp-mia')],
  }, profiles);
  assert.deepEqual(excludes.named, []);
  assert.equal(excludes.unnamed, 1);

  // Same profiles, a message whose known audience DOES include her: still named.
  const includes = readersOf({
    recipientCount: 2,
    recipient: 'mia@guest.com',
    recipients: ['mia@guest.com', 'other@else.com'],
    events: [open('fp-mia')],
  }, profiles);
  assert.deepEqual(includes.named, ['mia@guest.com']);
});

test('an unknown audience never blocks LEARNING — only a KNOWN, excluding one does (Rule B is unchanged)', () => {
  const msgs = [
    { recipientCount: 1, recipient: 'lisa@g.com', events: [open('fp-lisa')] },
    // group message, no recipients_json at all — audience unknown, not "known to exclude Lisa",
    // so it cannot contradict the candidate and the fingerprint is still learned.
    { recipientCount: 3, recipient: 'lisa@g.com', events: [open('fp-lisa')] },
  ];
  assert.deepEqual(learnProfiles(msgs), { 'fp-lisa': 'lisa@g.com' });

  // But naming (Rule A) is stricter than learning: the same unknown audience that can't block
  // learning also can't earn the message a name — see the dedicated test above.
  const out = annotate(msgs);
  assert.deepEqual(out[1].readers.named, []);
});
