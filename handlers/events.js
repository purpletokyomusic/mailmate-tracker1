// GET /events?since=ISO  →  messages and their events.
//
// This is the endpoint the whole port was for.
//
// It used to answer by listing one storage folder per day per kind — about sixty-two billed
// operations for a thirty-day window, on every single request, whether or not anything had
// changed. Two caches sat in front of it to make that affordable, and both were workarounds
// rather than features: a 15-second response cache, and a per-day message cache that only
// helped while a serverless instance stayed warm and could never cover event days at all,
// because an event is filed under the message's day and so a past day keeps changing.
//
// Two queries answer it now, no matter how wide the window, so both caches are gone and the
// data is always current.

import { messagesSince, eventsSince, eventsAfter, storeVersion } from '../lib/db.js';
import { annotate } from '../lib/readers.js';
import { demoteQuotedOpens } from '../lib/quoted-opens.js';
import { authorized, json } from '../lib/http.js';
import { ensureSchema } from '../lib/schema.js';

const DEFAULT_WINDOW_MS = 30 * 864e5;

// The window every cached answer is computed over. Wider than any client asks for — the Mac
// panel wants 14 days and the Chrome extension 30 — so one stored answer can serve both, and a
// narrower request is a filter over it rather than another trip to the database.
const CACHE_WINDOW_MS = 31 * 864e5;

// The last answer computed, and the store version it was computed from. Module scope, so it
// outlives a request and is reused by the next one this isolate handles.
//
// Best effort by design: an isolate can be recycled at any moment and a colo can run more than
// one, so a miss is normal and costs only what this endpoint used to cost every time. What
// makes it SAFE rather than merely fast is that the key is the store version — not a clock — so
// a stale answer cannot outlive the write that contradicts it. Nothing here is ever mutated
// after it is stored; callers filter and serialise it, and must keep doing only that.
let memo = null;   // { version, messages }

// The raw events behind the last answer, kept so the NEXT miss can extend them instead of
// re-reading the window from scratch.
//
// Measured 2026-09-16: after the 09-09 fix, a version mismatch was still re-reading essentially
// the whole 31-day events table on almost every miss (avg 4,659 of ~4,973 rows) — 6.9M of the
// 7.95M rows read by the two rebuild queries over 7 days. store_version bumps on every single
// write, including a self-open or a message amend that touches no event at all, so misses are
// frequent and were each paying for the full window regardless of how small the actual change
// was. This is what makes that safe to fix instead of just observed: `events` is append-only
// (insertEvent() in lib/db.js only ever INSERTs — never UPDATEs or DELETEs a row), so a row's id
// is assigned once, in insertion order, and never invalidated afterwards. That means "everything
// already merged, plus everything with a higher id" is exactly the set a full re-scan of the
// window would return — not an approximation of it — so this cuts cost without changing the
// answer. See test/incremental-parity.test.mjs for the proof against a real pulled snapshot.
//
// Messages are NOT cached this way and are still read in full on every miss: the table is a
// fraction of the size (704 avg rows vs 4,659) and, unlike events, an amend UPDATES an existing
// row without moving its registered_at (see the ON CONFLICT clause in lib/db.js) — an
// id/high-water-mark scheme would silently miss it. Not worth the risk for the smaller cost.
let eventCache = null; // { rawEvents, maxEventId }

/** Test-only: clear module state between cases that construct their own fake store. */
export function _resetForTests() {
  memo = null;
  eventCache = null;
}

/**
 * Every message of the last CACHE_WINDOW_MS with its events attached and attribution computed,
 * served from memory when the store has not changed since it was last built.
 */
async function annotatedWindow(db) {
  // Read the version FIRST, before the rows it will label.
  //
  // The other order looks equivalent and is not: a write landing between the queries and the
  // version read would stamp the NEW number onto an answer assembled before it, and every later
  // poll would match that number and serve the stale answer until something else was written.
  // Read first and the same race merely labels a fresh answer with an old number, which costs
  // one extra rebuild on the next poll and loses nothing.
  const version = await storeVersion(db);
  if (memo && memo.version === version) return memo.messages;

  const sinceISO = new Date(Date.now() - CACHE_WINDOW_MS).toISOString();
  const messages = await messagesSince(db, sinceISO);
  attach(messages, await eventsInWindow(db, sinceISO));

  const built = annotate(demoteQuotedOpens(messages));
  memo = { version, messages: built };
  return built;
}

/**
 * The raw events inside `sinceISO..now`, extending the previous merge rather than re-reading it
 * when there is one to extend.
 */
async function eventsInWindow(db, sinceISO) {
  if (!eventCache) {
    const rows = await eventsSince(db, sinceISO);
    eventCache = { rawEvents: rows, maxEventId: maxId(rows) };
    return rows;
  }

  // Trim what aged out of the window as it slid forward, then add only what is new. Filtering
  // the fresh rows too, rather than trusting that anything just inserted is inside the window by
  // construction, is what keeps this identical to a full scan even in a pathological case (e.g.
  // a much narrower CACHE_WINDOW_MS in the future) rather than merely "true in practice today".
  const fresh = (await eventsAfter(db, eventCache.maxEventId)).filter((e) => e.at >= sinceISO);
  const kept = eventCache.rawEvents.filter((e) => e.at >= sinceISO);
  const merged = kept.concat(fresh);

  eventCache = { rawEvents: merged, maxEventId: fresh.length ? maxId(fresh) : eventCache.maxEventId };
  return merged;
}

function maxId(rows) {
  let max = 0;
  for (const r of rows) if (r.id > max) max = r.id;
  return max;
}

/** One lookup table, then one pass over the events, onto the message each belongs to. */
function attach(messages, rawEvents) {
  const byToken = new Map(messages.map((m) => [m.token, m]));
  // Events whose message falls outside the window have nowhere to land and are dropped here —
  // see eventsSince() in lib/db.js.
  for (const e of rawEvents) {
    byToken.get(e.token)?.events.push({
      at: e.at,
      kind: e.kind,
      classification: e.classification,
      fingerprint: e.fingerprint,
      device: e.device,
    });
  }
}

async function build(db, sinceISO) {
  const messages = await messagesSince(db, sinceISO);
  attach(messages, await eventsSince(db, sinceISO));

  // Attribution is computed HERE, once, so the Mac app and the Chrome extension can never
  // disagree about who opened something.
  //
  // Computing it over the shared window rather than each caller's own is what finally makes
  // that true. The two clients ask for different spans, and a fingerprint is learned from the
  // one-to-one mail in the set being annotated — so the same message really could come back
  // named on one surface and unnamed on the other. Now both read the same answer.
  //
  // Quoted pixels are demoted BEFORE attribution, so a reader who only ever appears via a pixel
  // quoted inside a newer reply is never learned as the older message's reader.
  return annotate(demoteQuotedOpens(messages));
}

export async function events(request, env) {
  if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401);

  const since = new URL(request.url).searchParams.get('since') || '';
  const sinceDate = since ? new Date(since) : new Date(Date.now() - DEFAULT_WINDOW_MS);
  if (Number.isNaN(sinceDate.getTime())) return json({ error: 'bad since' }, 400);
  const sinceISO = sinceDate.toISOString();

  try {
    // Same fresh-deployment concern as register.js — see the comment there. A brand-new database
    // could otherwise answer its very first /events poll with a "no such table" 503 instead of
    // an honest empty result.
    await ensureSchema(env.DB);

    // A request reaching further back than the shared window is answered directly. Nobody
    // ships a client that does this, but widening the cached answer to fit one caller would
    // quietly change what every other caller is told.
    const older = sinceDate.getTime() < Date.now() - CACHE_WINDOW_MS;
    const all = older ? await build(env.DB, sinceISO) : await annotatedWindow(env.DB);

    // The same string comparison SQLite was doing when this was a WHERE clause, so a message
    // sits on the same side of the boundary as it always has.
    const messages = all.filter((m) => m.sentAt >= sinceISO);

    return json({ since: sinceISO, count: messages.length, messages });
  } catch (err) {
    console.error('[events] failed', err);
    return json({ error: 'store unavailable' }, 503);
  }
}
