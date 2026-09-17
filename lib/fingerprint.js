// A stable, one-way identifier for "whoever fetched this pixel".
//
// One email to nine people carries ONE marker with ONE address, so a fetch never says which
// recipient made it. What it does carry is a network and a device, and those are stable enough
// per person to (a) tell two readers of the same message apart and (b) recognise the same
// reader again on a different message. That is the whole basis of per-recipient attribution —
// inference, not identity.
//
// The address itself is never stored: the fingerprint is an HMAC, so matching works while the
// server holds no client's real IP (Daniel's choice, 2026-08-27).
//
// Two readers are DELIBERATELY collapsed into shared buckets:
//   - Gmail's image proxy: every Gmail reader fetches through Google with the same device
//     string, so they are genuinely indistinguishable. Pretending otherwise would invent
//     precision that does not exist.
//   - Apple's privacy relay: same.

import { createHmac } from 'node:crypto';

export const SHARED_BUCKETS = { GMAIL: 'gmail-proxy', APPLE: 'apple-proxy' };

/**
 * A coarse device family — OS plus mail client — with every version number removed, so a
 * browser update does not turn a known reader into a stranger.
 */
export function deviceFamily(userAgent = '') {
  const ua = String(userAgent);
  const os =
    /Windows/i.test(ua) ? 'windows' :
    /iPhone|iPad|iOS/i.test(ua) ? 'ios' :
    /Android/i.test(ua) ? 'android' :
    /Mac OS X|Macintosh/i.test(ua) ? 'mac' :
    /Linux/i.test(ua) ? 'linux' : 'unknown';
  const client =
    /Edg\//i.test(ua) ? 'edge' :
    /OutlookMobile|Outlook/i.test(ua) ? 'outlook' :
    /Thunderbird/i.test(ua) ? 'thunderbird' :
    /Chrome\//i.test(ua) ? 'chrome' :
    /Firefox\//i.test(ua) ? 'firefox' :
    /Safari\//i.test(ua) ? 'safari' : 'unknown';
  return `${os}|${client}`;
}

export function fingerprint({ ip = '', userAgent = '', secret = process.env.TRACKER_SECRET || '' }) {
  const ua = String(userAgent);
  if (/GoogleImageProxy/i.test(ua)) return SHARED_BUCKETS.GMAIL;
  if (/AppleMail-ImageProxy/i.test(ua) || /^17\./.test(ip)) return SHARED_BUCKETS.APPLE;
  if (!ip && !ua) return 'unknown';
  return createHmac('sha256', secret)
    .update(`${ip}|${deviceFamily(ua)}`)
    .digest('hex').slice(0, 10);
}

/** True for buckets that stand for "one or more people we cannot tell apart". */
export function isSharedBucket(fp) {
  return fp === SHARED_BUCKETS.GMAIL || fp === SHARED_BUCKETS.APPLE || fp === 'unknown';
}
