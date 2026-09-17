// Who opened what — computed once, on the server, for every surface.
//
// This logic used to live only in the Mac app, which meant Gmail in the browser could never
// show it, and any second implementation would have drifted from the first. Daniel's rule is
// that a feature ships to BOTH surfaces, so the attribution lives here and the clients render.
//
// The method: attribution is CERTAIN only on a one-to-one email — one recipient, one reader.
// Those messages teach each person's fingerprint, and the learned fingerprints are then
// recognised on group emails, where the marker alone could never say who opened it.
//
// Group emails never teach. That is how you would invent a confident wrong answer.

import { isSharedBucket } from './fingerprint.js';

/** Bare addresses out of a recipient field, however it was written. */
export function addressesIn(recipient = '') {
  return String(recipient)
    .split(',')
    .map((part) => {
      const t = part.trim();
      const m = /<([^>]+)>/.exec(t);
      return (m ? m[1] : t).trim().toLowerCase();
    })
    .filter((a) => a.includes('@'));
}

/**
 * The message's known audience as a Set of bare lowercase addresses, or null when we don't
 * actually know who it went to.
 *
 * `message.recipients` (from `recipients_json`) is the client's explicit, full address list —
 * the only thing that can tell "one person" apart from "one person cc'd to eight" (see the note
 * on learnProfiles below). When it's present and non-empty, it IS the audience, regardless of
 * recipientCount. When it's absent, the only safe reading of `recipient` is a message the client
 * itself reported as going to exactly one address — recipientCount === 1 — because that's the
 * one case where `recipient` cannot be hiding a wider audience. Anything else is unknown, not
 * "assumed small": a 3-recipient message with no explicit list could contain anyone.
 */
export function audienceOf(message) {
  if (Array.isArray(message.recipients) && message.recipients.length) {
    const out = new Set();
    for (const r of message.recipients) for (const a of addressesIn(r)) out.add(a);
    return out;
  }
  if (message.recipientCount === 1) {
    const to = addressesIn(message.recipient);
    if (to.length === 1) return new Set(to);
  }
  return null;
}

/**
 * Fingerprints that are the sender's OWN devices: anything that has ever produced a `self` open.
 *
 * The self-IP list only knows networks that have registered something. When the sender's own IP
 * changes, the first opens of the day can arrive from an address the tracker has never seen,
 * get classified human, and land on a one-to-one email — so the tracker learns that the
 * sender's own device is that recipient, then names that person as a reader on somebody else's
 * thread (a real incident this guards against, 2026-09-02). The fingerprint is a hash of the
 * device, not the address, and it stays the same when the IP moves: once it has been seen as
 * `self` even once, every open it ever produced was the sender's own.
 */
export function selfFingerprints(messages) {
  const fps = new Set();
  for (const m of messages) {
    for (const e of m.events || []) {
      if (e.classification === 'self' && e.fingerprint && !isSharedBucket(e.fingerprint)) {
        fps.add(e.fingerprint);
      }
    }
  }
  return fps;
}

/**
 * Fingerprints that opened one-to-one mail addressed to two DIFFERENT people. One device that
 * reads mail sent to two different recipients is a relay, a scanner, or the sender's own machine
 * — never a person. Naming it as either person would be wrong for at least one of them.
 */
export function ambiguousFingerprints(messages) {
  const seenFor = new Map(); // fingerprint → Set(recipient address)
  for (const m of messages) {
    if (m.recipientCount !== 1) continue;
    const to = addressesIn(m.recipient);
    if (to.length !== 1) continue;
    for (const e of m.events || []) {
      if (e.kind !== 'open' || e.classification !== 'human') continue;
      if (!e.fingerprint || isSharedBucket(e.fingerprint)) continue;
      if (!seenFor.has(e.fingerprint)) seenFor.set(e.fingerprint, new Set());
      seenFor.get(e.fingerprint).add(to[0]);
    }
  }
  const out = new Set();
  for (const [fp, people] of seenFor) if (people.size >= 2) out.add(fp);
  return out;
}

/**
 * fingerprint → email, learned from every single-recipient message in the set.
 *
 * Learning requires an EXPLICIT recipient list from the client. The `recipient` field alone is
 * not enough and must never be used: it holds whoever the message was primarily addressed to,
 * so a reply sent to one person and cc'd to eight looks exactly like a one-to-one email. That
 * happened on 2026-08-27 — a nine-recipient thread taught a fingerprint as belonging to the
 * person in the To field, which could as easily have been any of the eight. Without the list,
 * we learn nothing, which is the right failure: a wrong name on a client's email is far worse
 * than no name.
 *
 * A candidate learned this way is then checked against EVERY message that fingerprint ever
 * opened, not just the one that taught it (2026-09-14). The bug, seen in real use: a fingerprint
 * was learned as one specific person from a single genuine 1:1 open, but the same device also
 * opened an unrelated multi-recipient thread whose reported audience never included that
 * person — so the device was never actually theirs (almost certainly the sender's own machine
 * from a not-yet-known IP, the same class of bug as the self-fingerprint case above). A
 * fingerprint whose own opens contradict a known audience is not a person we can name — it's
 * dropped from `profiles` entirely, the same fail-closed choice as the self/ambiguous guards
 * below. A message with an UNKNOWN audience can never contradict anything (see audienceOf) — it
 * simply has nothing to say.
 */
export function learnProfiles(messages) {
  const self = selfFingerprints(messages);
  const ambiguous = ambiguousFingerprints(messages);

  // Candidates, exactly as before: one address per fingerprint, from one-to-one mail only.
  const candidates = {};
  for (const m of messages) {
    // recipientCount is 0 when the client did not report its audience — never teach then.
    if (m.recipientCount !== 1) continue;
    const to = addressesIn(m.recipient);
    if (to.length !== 1) continue;
    for (const e of m.events || []) {
      if (e.kind !== 'open' || e.classification !== 'human') continue;
      if (!e.fingerprint || isSharedBucket(e.fingerprint)) continue;
      if (self.has(e.fingerprint) || ambiguous.has(e.fingerprint)) continue;
      candidates[e.fingerprint] = to[0];
    }
  }
  if (Object.keys(candidates).length === 0) return candidates;

  // Every message each candidate fingerprint ever produced a human open on, so a name learned
  // from one 1:1 email can be checked against everything else that device did (Rule B, above).
  const opensByFp = new Map();
  for (const m of messages) {
    for (const e of m.events || []) {
      if (e.kind !== 'open' || e.classification !== 'human' || !e.fingerprint) continue;
      if (!(e.fingerprint in candidates)) continue;
      if (!opensByFp.has(e.fingerprint)) opensByFp.set(e.fingerprint, []);
      opensByFp.get(e.fingerprint).push(m);
    }
  }

  const profiles = {};
  for (const [fp, person] of Object.entries(candidates)) {
    const contradicted = (opensByFp.get(fp) || []).some((m) => {
      const audience = audienceOf(m); // null (unknown) can never contradict — see audienceOf
      return audience && !audience.has(person);
    });
    if (!contradicted) profiles[fp] = person;
  }
  return profiles;
}

/**
 * Readers of one message: the people we can name, and how many we cannot.
 *
 * Distinct readers are counted by fingerprint, so one person opening five times is one reader.
 * Each shared bucket counts as exactly ONE unnamed reader — there may be more people behind it,
 * and stating a number would be inventing one.
 *
 * Rule A (2026-09-14, tightened same day): a recipient can only fetch a pixel of mail they were
 * actually sent, so a learned fingerprint is named here only if this message's audience is
 * KNOWN and includes that person. An unknown audience — most older messages, which report only
 * a `recipient` string and a count, before the client started sending `recipients_json` — says
 * nothing either way, and "says nothing" must print as unnamed, not as a guess. The first cut of
 * this rule only blocked a KNOWN, excluding audience and left an unknown one naming freely; a
 * 31-day replay showed that was cheap to tighten — only 2 of 50 named-reader instances in the
 * whole window sat on an unknown audience, both from 2026-08-31, before recipients_json existed
 * at all — so the file's own principle (a wrong name is worse than no name) wins the tie.
 */
export function readersOf(message, profiles) {
  const named = [];
  const unnamed = new Set();
  const audience = audienceOf(message);
  for (const e of message.events || []) {
    if (e.kind !== 'open' || e.classification !== 'human') continue;
    let person = e.fingerprint && !isSharedBucket(e.fingerprint) ? profiles[e.fingerprint] : null;
    if (!audience || !person || !audience.has(person)) person = null;
    if (person) {
      if (!named.includes(person)) named.push(person);
    } else {
      unnamed.add(e.fingerprint || 'unknown');
    }
  }
  return { named, unnamed: unnamed.size };
}

export function annotate(messages) {
  // A device that has ever been the sender's own is the sender's own everywhere: its "human"
  // opens are reclassified so no count, anywhere, includes him reading his own sent mail.
  const self = selfFingerprints(messages);
  for (const m of messages) {
    for (const e of m.events || []) {
      if (e.classification === 'human' && e.fingerprint && self.has(e.fingerprint)) {
        e.classification = 'self';
      }
    }
  }
  const profiles = learnProfiles(messages);
  for (const m of messages) m.readers = readersOf(m, profiles);
  return messages;
}
