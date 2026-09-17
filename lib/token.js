// Tokens carry their own send time.
//
// This is load-bearing, not a nicety. Vercel Blob is eventually consistent — a blob written a
// second ago may not be readable yet — so the pixel endpoint must never need to look anything
// up in order to classify a fetch. Everything it needs (when the message was sent, and whether
// this fetch is Daniel's own machine) travels in the URL.

const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** `YYYYMMDDTHHMMSS-<12 chars>` — sortable, shardable by day, and self-dating. */
export function newToken(now = new Date()) {
  const iso = now.toISOString();
  const stamp = iso.slice(0, 19).replace(/[-:]/g, '');   // 20260827T173455
  const bytes = new Uint8Array(12);
  (globalThis.crypto ?? require('node:crypto').webcrypto).getRandomValues(bytes);
  let rand = '';
  for (const b of bytes) rand += ALPHABET[b % ALPHABET.length];
  return `${stamp}-${rand}`;
}

/** The day shard, e.g. "2026-08-27". Null if the token is not one of ours. */
export function dayOf(tok) {
  const m = /^(\d{4})(\d{2})(\d{2})T\d{6}-/.exec(tok || '');
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** When the message was registered, read straight out of the token. */
export function sentAtOf(tok) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})-/.exec(tok || '');
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
}

export function isValidToken(tok) {
  return /^\d{8}T\d{6}-[A-Za-z2-9]{12}$/.test(tok || '');
}
