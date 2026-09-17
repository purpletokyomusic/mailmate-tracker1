// The schema, embedded so the Worker can create it on a fresh D1 database with no manual
// step — see ensureSchema() below. schema.sql remains the single source of truth; this constant
// is a generated, byte-for-byte copy of it (test/schema.test.mjs fails loudly if they diverge).
//
// Regenerate after any change to schema.sql:
//   node scripts/embed-schema.mjs

export const SCHEMA_SQL = "-- The tracker's store, as a database rather than a pile of files.\n--\n-- What this replaces, and why it is the whole point of the port:\n--\n-- The Vercel Blob version had no database. It encoded every fact it needed into a FILE PATH,\n-- one file per message and one per event, filed in a folder per day. Answering \"what has\n-- happened in the last thirty days\" therefore meant listing sixty-two folders — thirty-one\n-- days of messages plus thirty-one of events — and every one of those listings was a billed\n-- storage operation. Vercel's free tier allows two thousand a month. A client polling that\n-- endpoint spent the entire monthly allowance in about half an hour.\n--\n-- Here the same question is two indexed queries, no matter how wide the window.\n\n-- One row per tracked message.\n--\n-- The token is the identity, which makes an AMEND a plain upsert. Amends are real: the Mac\n-- watcher stamps a hand-written email the moment the cursor reaches the body, which can be\n-- before the subject exists, then re-registers once the subject settles. The Blob version wrote\n-- a second file and had the reader prefer whichever record knew more; here the same rule lives\n-- in the ON CONFLICT clause in lib/db.js, so there is only ever one row to reason about.\nCREATE TABLE IF NOT EXISTS messages (\n  token           TEXT PRIMARY KEY,\n  day             TEXT NOT NULL,\n  recipient       TEXT NOT NULL DEFAULT '',\n  -- The FULL audience as JSON, when the client knows it. Attribution refuses to learn a\n  -- fingerprint without this — see lib/readers.js for why the `recipient` field alone is not\n  -- good enough. NULL means \"the client did not say\".\n  recipients_json TEXT,\n  subject         TEXT NOT NULL DEFAULT '',\n  source          TEXT NOT NULL DEFAULT 'unknown',\n  -- Audience SIZE, which is all the learning rule needs. 0 means \"not stated\", which makes the\n  -- message ineligible to teach.\n  recipient_count INTEGER NOT NULL DEFAULT 0,\n  registered_at   TEXT NOT NULL,\n  self_tag        TEXT NOT NULL DEFAULT '',\n  links_json      TEXT NOT NULL DEFAULT '[]'\n);\n\n-- The index that replaces sixty-two folder listings with one range scan. /events always asks\n-- \"every message registered at or after <timestamp>\", so this is the access path that matters.\nCREATE INDEX IF NOT EXISTS messages_registered_at ON messages (registered_at);\n\n-- Every pixel fetch and every link click, including the ones that are not opens.\n--\n-- Nothing is filtered on the way in. A scanner fetch, Apple's pre-fetch and Daniel's own\n-- compose window are all recorded and all carry their classification, because the difference\n-- between \"recorded\" and \"counted\" is the entire value of this service — see lib/classify.js.\nCREATE TABLE IF NOT EXISTS events (\n  id             INTEGER PRIMARY KEY AUTOINCREMENT,\n  token          TEXT NOT NULL,\n  at             TEXT NOT NULL,\n  kind           TEXT NOT NULL,           -- 'open' | 'click'\n  classification TEXT NOT NULL,           -- 'human' | 'self' | 'scanner' | 'privacy-proxy' | 'unknown'\n  -- One-way hash of network + device family. The raw address is never stored, here or anywhere.\n  fingerprint    TEXT,\n  device         TEXT,                    -- 'os|client', e.g. 'ios|safari'\n  destination    TEXT,                    -- clicks only\n  device_hint    TEXT\n);\n\n-- Events are always fetched for a known set of tokens, ordered by time.\nCREATE INDEX IF NOT EXISTS events_token_at ON events (token, at);\n\n-- The index /events actually runs on, and the reason it is a COVERING index.\n--\n-- /events used to ask for events by joining them to the messages registered in the window.\n-- SQLite answered that by reading every row in this table and looking its message up one at a\n-- time: 5,481 rows read to return 2,255. Asking for events by TIME instead lets the range scan\n-- do the work — but only if every column /events selects is IN the index, because otherwise\n-- SQLite reads the index AND then the row it points at, and bills for both. Measured against\n-- the live database: 5,481 rows read before, 2,261 after, for a byte-identical answer.\n--\n-- Keep this column list in step with the SELECT in eventsSince(). Adding a column there\n-- without adding it here silently doubles the cost of the busiest query in the service.\nCREATE INDEX IF NOT EXISTS events_at_covering\n  ON events (at, token, kind, classification, fingerprint, device);\n\n-- Networks that are provably the sender's own.\n--\n-- Any request to /register carried the tracker secret, so the address it came from is by\n-- definition one of his machines. Remembering them means him re-reading his own sent mail days\n-- later is recognised as him rather than counted as the recipient opening it. Stored as a\n-- one-way hash so the database never holds his addresses in the clear.\nCREATE TABLE IF NOT EXISTS self_ips (\n  hash       TEXT PRIMARY KEY,\n  first_seen TEXT NOT NULL\n);\n\n-- One number, bumped on every write, so a reader can ask \"has anything changed?\" for one row.\n--\n-- /events is polled far more often than anything is sent or opened — 755 times in the day this\n-- was measured, against 298 writes. Without this, every one of those polls recomputed an answer\n-- that was usually identical to the last one, and re-read the whole store to do it. With it, a\n-- poll reads this single row first and, when the number is unchanged, serves the answer it\n-- already has.\n--\n-- The version is bumped inside lib/db.js's write functions rather than by the callers, so a new\n-- write path cannot forget to do it. It must move for AMENDS too, not just inserts: the Mac\n-- watcher registers a message before its subject exists and completes it seconds later, and the\n-- panel matches messages by subject — a cached answer holding the pre-amend blank would make a\n-- just-sent message unfindable.\nCREATE TABLE IF NOT EXISTS store_version (\n  id      INTEGER PRIMARY KEY CHECK (id = 1),\n  version INTEGER NOT NULL DEFAULT 0\n);\nINSERT OR IGNORE INTO store_version (id, version) VALUES (1, 0);\n";

/**
 * SCHEMA_SQL split into individual statements, comments stripped.
 *
 * D1's db.exec() takes newline-separated statements and does not document comment support (see
 * the Cloudflare Workers D1 API docs), so this strips every '--' line comment first and splits
 * on ';' rather than relying on exec() to make sense of the raw file. Safe here because
 * schema.sql has no semicolon inside a string literal or identifier — every ';' in it terminates
 * a statement.
 */
export function statementsOf(sql) {
  return sql
    .split('\n')
    .map((line) => {
      const i = line.indexOf('--');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Memoized per D1 BINDING OBJECT, not globally: the first call keyed to a given `db` creates
// the promise, and every later call with that SAME object — from any handler, on any later
// request this isolate serves — gets it back, so schema readiness is checked at most once per
// isolate lifetime (one isolate holds one stable env.DB for its whole life). A resolved promise
// awaits in a microtask, so the cost after the first request is effectively zero.
//
// Keying on object identity rather than a single module-level variable is also what makes this
// safe to unit-test: two tests that each build their own fake D1 stand-in get independent memo
// entries for free, with no manual reset required between them (a WeakMap never pins a fake db
// alive past its test either). See test/schema.test.mjs.
const readyByDb = new WeakMap();

/**
 * Idempotent schema setup: CREATE TABLE/INDEX IF NOT EXISTS, run as one batch (one transaction,
 * one round trip). A no-op on Daniel's own database, which already has every table — the cheap
 * existence check below finds store_version and returns without writing anything.
 *
 * This is what makes a freshly-provisioned D1 database (a friend's own, or the throwaway one a
 * verification run creates) work with ZERO manual 'wrangler d1 execute' step: the very first
 * request this isolate serves creates every table before touching one.
 */
export function ensureSchema(db) {
  let ready = readyByDb.get(db);
  if (!ready) {
    ready = initSchema(db);
    readyByDb.set(db, ready);
  }
  return ready;
}

async function initSchema(db) {
  // One cheap existence check before ever considering the 8-statement batch below. On an
  // established database (Daniel's own) this is the ENTIRE cost of every isolate's first request.
  const row = await db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'store_version'`)
    .first()
    .catch(() => null);
  if (row) return;

  const statements = statementsOf(SCHEMA_SQL).map((sql) => db.prepare(sql));
  await db.batch(statements);
}

/**
 * Test-only: forget the memoized promise for one db object. Rarely needed — a fresh fakeDb()
 * already gets its own entry — but here for a test that deliberately reuses one db object across
 * cases and wants to re-observe the first-call behaviour.
 */
export function _resetSchemaForTests(db) {
  readyByDb.delete(db);
}
