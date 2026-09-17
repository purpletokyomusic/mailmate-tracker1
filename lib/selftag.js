// "Is this fetch Daniel's own machine?" answered with no database lookup.
//
// At registration the tracker sees the sender's IP and stamps a short HMAC of it into the pixel
// URL. When the pixel is fetched, it recomputes the HMAC of the requester's IP and compares.
// Same machine → same tag → `self`, and the fetch is recorded but never counted as an open.
//
// This exists because Apple Mail's compose window loads the pixel while the draft is being
// written (proven by the 2026-08-27 spike). Without it, every message would show as opened
// seconds after it was sent.
//
// It is an HMAC and not the raw IP so the recipient-facing URL leaks nothing about the sender's
// network, and it is truncated because 12 hex characters is ample to tell two IPs apart.

import { createHmac } from 'node:crypto';

export function selfTag(ip, secret = process.env.TRACKER_SECRET || '') {
  if (!ip || !secret) return 'x';
  return createHmac('sha256', secret).update(String(ip)).digest('hex').slice(0, 12);
}

export function isSelfFetch(tag, ip, secret = process.env.TRACKER_SECRET || '') {
  if (!tag || tag === 'x') return false;
  return tag === selfTag(ip, secret);
}
