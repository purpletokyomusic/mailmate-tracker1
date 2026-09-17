// GET /l/<token>.<tag>/<base64url destination>  →  302 to the destination, click logged.
//
// The destination travels in the URL rather than in the store, so a click redirect never waits
// on a lookup and never breaks if the store is slow or unreachable. Someone clicked a link in
// an email; they get to where they were going regardless of what this service is doing.

import { classify } from '../lib/classify.js';
import { isSelfFetch } from '../lib/selftag.js';
import { isKnownSelfIp } from '../lib/selfips.js';
import { insertEvent } from '../lib/db.js';
import { dec } from '../lib/paths.js';
import { sentAtOf, isValidToken } from '../lib/token.js';
import { fingerprint, deviceFamily } from '../lib/fingerprint.js';
import { clientIp } from '../lib/http.js';
import { ensureSchema } from '../lib/schema.js';

export function click(request, env, ctx, raw, encodedDest) {
  const trimmed = String(raw || '');
  const lastDot = trimmed.lastIndexOf('.');
  const token = lastDot === -1 ? trimmed : trimmed.slice(0, lastDot);
  const tag = lastDot === -1 ? '' : trimmed.slice(lastDot + 1);

  // Where a click goes when the destination is missing or malformed. Configurable because every
  // deployment belongs to a different person; the default is deliberately inert rather than
  // somebody else's website.
  let destination = env.TRACKER_FALLBACK_URL || 'https://example.com/';
  const decoded = dec(String(encodedDest || ''));
  if (/^https?:\/\//i.test(decoded)) destination = decoded;

  // Logged after the redirect is issued, not before it. The Vercel version had to finish the
  // write first — racing a 1.2-second deadline while a person sat waiting on the redirect —
  // because work left running after the response might never execute there. Here the redirect
  // goes out immediately and the write still completes.
  ctx.waitUntil(
    logClick(request, env, { token, tag, destination })
      .catch((err) => console.error('[click] logging failed', err)),
  );

  return new Response(null, {
    status: 302,
    headers: { location: destination, 'cache-control': 'no-store' },
  });
}

async function logClick(request, env, { token, tag, destination }) {
  if (!isValidToken(token)) return;

  // Runs after the redirect has already gone out — see register.js for why this exists and why
  // it is safe to await here.
  await ensureSchema(env.DB);

  const secret = env.TRACKER_SECRET || '';
  const at = new Date().toISOString();
  const ip = clientIp(request);
  const userAgent = request.headers.get('user-agent') || '';
  const isSelf = isSelfFetch(tag, ip, secret) || await isKnownSelfIp(env.DB, ip, secret);

  const classification = classify({
    sentAt: sentAtOf(token).toISOString(), at, userAgent, ip, isSelf,
  });

  await insertEvent(env.DB, {
    token,
    at,
    kind: 'click',
    classification,
    fingerprint: fingerprint({ ip, userAgent, secret }),
    device: deviceFamily(userAgent),
    destination,
    deviceHint: userAgent.slice(0, 120),
  });
}
