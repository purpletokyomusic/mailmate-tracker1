// The set of networks that are provably the sender's own.
//
// Any request to /register carries the tracker secret, so the address it came from is by
// definition one of his machines. Remembering those means a later fetch of the same pixel from
// the same network — him re-reading his own sent mail in Apple Mail, hours or days later — is
// recognised as him and never counted as the recipient opening it.
//
// Stored as a one-way hash: the store never holds his addresses in the clear.
//
// What changed in the port. The Blob version could not ask "is this hash known?", only "list
// everything filed under self/", so it listed the whole set and cached it for a minute to make
// that affordable. A database answers the real question directly, with an indexed lookup on the
// primary key, so the whole-set listing and its TTL are gone.

import { createHmac } from 'node:crypto';
import { rememberSelfHash, isKnownSelfHash } from './db.js';

// Positive answers only, and they never expire.
//
// A hash that has once been proven to be the sender's own cannot stop being his, so caching a
// `true` is always safe. Caching a `false` would not be: the very next register call can make
// it true. This also preserves the old behaviour that a failed lookup must never silently turn
// him into a recipient — anything already known stays known even if the database is unreachable.
const knownSelf = new Set();

export function ipHash(ip, secret) {
  return createHmac('sha256', String(secret || '')).update(String(ip || '')).digest('hex').slice(0, 24);
}

/** Called on every register. Idempotent — the hash is the primary key. */
export async function rememberSelfIp(db, ip, secret) {
  if (!ip) return;
  const h = ipHash(ip, secret);
  if (knownSelf.has(h)) return;
  await rememberSelfHash(db, h);
  knownSelf.add(h);
}

export async function isKnownSelfIp(db, ip, secret) {
  if (!ip) return false;
  const h = ipHash(ip, secret);
  if (knownSelf.has(h)) return true;
  try {
    const hit = await isKnownSelfHash(db, h);
    if (hit) knownSelf.add(h);
    return hit;
  } catch {
    // Unreachable store: fall back to "not known". The per-message signed tag in lib/selftag.js
    // still catches the case this protects against most often — his own compose window fetching
    // the pixel seconds after registering — so a failure here degrades rather than misreports.
    return false;
  }
}
