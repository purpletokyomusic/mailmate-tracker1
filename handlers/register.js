// POST /register  {recipient, subject, source, links?}  — one message or an array of them.
//
// Returns the pixel URL to embed. The URL carries a signed tag identifying the registering
// machine, so the pixel endpoint can spot the sender's own compose-window fetch without a
// lookup.

import { upsertMessage } from '../lib/db.js';
import { newToken, dayOf, isValidToken } from '../lib/token.js';
import { selfTag } from '../lib/selftag.js';
import { rememberSelfIp } from '../lib/selfips.js';
import { clientIp, authorized, json } from '../lib/http.js';
import { ensureSchema } from '../lib/schema.js';

export function pixelURL(base, token, tag) {
  return `${base}/p/${token}.${tag}.gif`;
}

export async function register(request, env) {
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401);

  let parsed;
  try {
    parsed = await request.json();
  } catch {
    return json({ error: 'bad JSON' }, 400);
  }

  const isBatch = Array.isArray(parsed) || Array.isArray(parsed?.messages);
  const items = Array.isArray(parsed) ? parsed : (parsed?.messages || [parsed]);
  if (!items.length) return json({ error: 'nothing to register' }, 400);

  const base = (env.TRACKER_BASE_URL || new URL(request.url).origin).replace(/\/$/, '');
  const secret = env.TRACKER_SECRET || '';
  const ip = clientIp(request);
  const tag = selfTag(ip, secret);

  try {
    // A fresh deployment's D1 database starts life with no tables at all — this is what lets a
    // "Deploy to Cloudflare" click or a brand-new `wrangler d1 create` reach a working tracker
    // with no manual schema step. Memoized in lib/schema.js, so only the first request any given
    // isolate serves pays for the check, and Daniel's own already-initialized database is a
    // single cheap SELECT away from confirming there is nothing to do.
    await ensureSchema(env.DB);

    // This request carried the secret, so this network is his. Remember it, so a later fetch of
    // any pixel from here is recognised as him rather than as a recipient.
    await rememberSelfIp(env.DB, ip, secret).catch(() => {});

    const out = [];
    for (const item of items) {
      // A caller may supply the token to AMEND an existing registration — the Mac watcher
      // stamps a hand-written email the moment the cursor reaches the body, which can be before
      // the subject exists, and re-registers once the subject settles. Where the Blob version
      // wrote a second record and left the reader to prefer the completer one, the upsert in
      // lib/db.js now folds them into a single row.
      const token = isValidToken(item.token) ? item.token : newToken();

      // The full audience, de-duplicated, counted. Only the SIZE is used by the learning rule,
      // and a 0 means "the client did not say" — which makes the message ineligible to teach.
      const audience = Array.isArray(item.recipients)
        ? new Set(
            item.recipients
              .flatMap((r) => String(r).split(',').map((x) => x.trim().toLowerCase()))
              .filter(Boolean),
          )
        : null;

      await upsertMessage(env.DB, {
        token,
        day: dayOf(token),
        recipient: item.recipient || '',
        recipients: Array.isArray(item.recipients) ? item.recipients : null,
        subject: item.subject || '',
        source: item.source || 'unknown',
        recipientCount: audience ? audience.size : 0,
        registeredAt: new Date().toISOString(),
        selfTag: tag,
        links: Array.isArray(item.links) ? item.links : [],
      });

      // `tag` is returned so callers can also build tracked LINK urls, which is how outreach is
      // tracked: the Gmail connector strips externally-hosted images (re-confirmed 2026-08-27)
      // but leaves hrefs alone.
      out.push({ token, tag, pixel: pixelURL(base, token, tag), linkBase: `${base}/l/${token}.${tag}` });
    }

    return json(isBatch ? { registered: out } : out[0]);
  } catch (err) {
    console.error('[register] failed', err);
    return json({ error: 'store unavailable' }, 503);
  }
}
