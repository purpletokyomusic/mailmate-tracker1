// GET /p/<token>.<selfTag>.gif  →  the invisible pixel.
//
// ALWAYS 200 with a valid GIF, for any input, even when logging fails. A broken tracker must
// never put a broken-image icon in someone's inbox.
//
// No reads on the critical path. The send time comes out of the token and "is this the sender's
// own machine" comes out of the signed tag in the URL, so nothing about the store's speed or
// availability can change how a fetch is classified.

import { classify } from '../lib/classify.js';
import { isSelfFetch } from '../lib/selftag.js';
import { isKnownSelfIp } from '../lib/selfips.js';
import { insertEvent } from '../lib/db.js';
import { sentAtOf, isValidToken } from '../lib/token.js';
import { fingerprint, deviceFamily } from '../lib/fingerprint.js';
import { clientIp } from '../lib/http.js';
import { ensureSchema } from '../lib/schema.js';

// A 1×1 transparent GIF. Decoded once at module load, not per request.
const GIF = Uint8Array.from(
  atob('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='),
  (c) => c.charCodeAt(0),
);

const HEADERS = {
  'content-type': 'image/gif',
  'content-length': String(GIF.length),
  'cache-control': 'no-store, no-cache, must-revalidate, max-age=0, private',
  pragma: 'no-cache',
};

export function pixel(request, env, ctx, raw) {
  // The single best thing the Workers runtime gives this service.
  //
  // On Vercel the function could be frozen the instant it responded, so anything still running
  // after the response might simply never happen — which is exactly how the first version of
  // this silently recorded nothing. The workaround was to finish the write BEFORE replying,
  // raced against a 2.5-second deadline, so every reader paid for the store's latency and a
  // slow write was thrown away. `waitUntil` keeps the request alive after the response instead,
  // so the image returns immediately AND the write always gets its full chance.
  ctx.waitUntil(
    log(request, env, raw).catch((err) => console.error('[pixel] logging failed', err)),
  );
  return new Response(GIF, { status: 200, headers: HEADERS });
}

async function log(request, env, raw) {
  // Path shape: <token>.<tag>.gif
  const trimmed = String(raw || '').replace(/\.gif$/i, '');
  const lastDot = trimmed.lastIndexOf('.');
  const token = lastDot === -1 ? trimmed : trimmed.slice(0, lastDot);
  const tag = lastDot === -1 ? '' : trimmed.slice(lastDot + 1);

  if (!isValidToken(token)) { console.warn('[pixel] unrecognised token', token); return; }

  // Runs inside ctx.waitUntil, after the GIF has already gone out — see the doc comment above.
  // A fresh database has no tables at all until this runs once; see register.js for the fuller
  // explanation of why this makes a "Deploy to Cloudflare" click work with no manual step.
  await ensureSchema(env.DB);

  const secret = env.TRACKER_SECRET || '';
  const at = new Date().toISOString();
  const ip = clientIp(request);
  const userAgent = request.headers.get('user-agent') || '';

  // Two independent ways of recognising the sender: the tag minted for THIS message (covers the
  // compose window fetching the pixel as he writes), and the set of networks that have ever
  // registered a message (covers him re-reading his own sent mail days later).
  const isSelf = isSelfFetch(tag, ip, secret) || await isKnownSelfIp(env.DB, ip, secret);

  const classification = classify({
    sentAt: sentAtOf(token).toISOString(), at, userAgent, ip, isSelf,
  });

  await insertEvent(env.DB, {
    token,
    at,
    kind: 'open',
    classification,
    // Who fetched it, as a one-way hash — the raw address is never stored.
    fingerprint: fingerprint({ ip, userAgent, secret }),
    device: deviceFamily(userAgent),
    deviceHint: userAgent.slice(0, 120),
  });
}
