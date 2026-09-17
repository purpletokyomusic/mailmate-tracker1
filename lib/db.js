// The store, as SQL. This file replaces lib/blob.js.
//
// The old file had two operations, `put` and `list`, and no way to ask a question — so the
// reader asked the only question it could: "give me the names of everything filed under this
// day", once per day per kind. Thirty days of history cost sixty-two of those, every single
// request, and each one was billed. This file exists so that same question costs two queries.
//
// Everything here takes the D1 binding as its first argument rather than reaching for a global.
// That is what lets the whole store be tested against a real SQLite database in `wrangler dev`
// without an account, and it is why none of these functions read `env` themselves.

/**
 * Every message registered at or after `sinceISO`, newest last.
 *
 * One indexed range scan over messages_registered_at. This single query is the entire reason
 * for the port.
 */
export async function messagesSince(db, sinceISO) {
  const { results } = await db
    .prepare(
      `SELECT token, day, recipient, recipients_json, subject, source,
              recipient_count, registered_at
         FROM messages
        WHERE registered_at >= ?1
        ORDER BY registered_at`,
    )
    .bind(sinceISO)
    .all();
  return (results || []).map(rowToMessage);
}

/**
 * Every event recorded at or after `sinceISO`, oldest first.
 *
 * This used to join events to the messages registered in the window, which read the ENTIRE
 * events table on every call — SQLite has no way to start from a message's date and walk to its
 * events, so it walked every event and looked its message up instead. Measured on the live
 * database: 5,481 rows read to return 2,255.
 *
 * Asking by event time reads exactly what it returns (2,261 for 2,261), because
 * events_at_covering holds every column named here. See the note on that index in schema.sql
 * before adding a column to this SELECT.
 *
 * `id` rides along too. It costs nothing extra — `id` is this table's rowid (see the PRIMARY KEY
 * in schema.sql), and SQLite always carries a row's rowid inside every one of its index entries,
 * so reading it back is free from any index scan, covering or not (confirmed against the live
 * schema with EXPLAIN QUERY PLAN before this line was added: still "SEARCH events USING COVERING
 * INDEX events_at_covering"). handlers/events.js uses it as a high-water mark so a later rebuild
 * can ask for only the rows inserted since the last one, instead of this whole window again.
 *
 * The two questions are not identical: this one also returns events belonging to messages
 * registered BEFORE the window — an old thread opened today. handlers/events.js files each
 * event under its message and silently drops any without one, which is what the join used to do
 * by never fetching them, so the answer sent to a client is unchanged. Events cannot go the
 * other way and predate their own message: the pixel URL only exists once /register has minted
 * it, so nothing is lost by filtering on event time.
 */
export async function eventsSince(db, sinceISO) {
  const { results } = await db
    .prepare(
      `SELECT id, token, at, kind, classification, fingerprint, device
         FROM events
        WHERE at >= ?1
        ORDER BY at`,
    )
    .bind(sinceISO)
    .all();
  return results || [];
}

/**
 * Every event inserted after `afterId`, oldest first — the incremental half of the pair above.
 *
 * Safe only because `events` is append-only: insertEvent() below never updates or deletes a row,
 * so a row's id is assigned once and its columns never change afterwards. That makes "everything
 * already known, plus everything with a higher id" exactly the same set a full eventsSince() scan
 * would return for the same window — see handlers/events.js for the merge and why it costs so
 * much less. `id > ?` is a direct rowid-range seek (`id` IS the rowid here), not an index lookup,
 * so it reads nothing when there is nothing new: confirmed with EXPLAIN QUERY PLAN as "SEARCH
 * events USING INTEGER PRIMARY KEY (rowid>?)".
 */
export async function eventsAfter(db, afterId) {
  const { results } = await db
    .prepare(
      `SELECT id, token, at, kind, classification, fingerprint, device
         FROM events
        WHERE id > ?1
        ORDER BY id`,
    )
    .bind(afterId)
    .all();
  return results || [];
}

/**
 * How many times the store has been written to. One row, read by primary key.
 *
 * This is what lets /events answer a repeat poll without re-reading the store — see the
 * store_version note in schema.sql for why it exists and what it costs.
 *
 * Returns 0 when the row is absent, which is only true of a database that has never been
 * written to. That is safe because the bump below CREATES the row, so the very first write
 * moves the number off 0 and invalidates anything cached against it.
 */
export async function storeVersion(db) {
  const row = await db.prepare(`SELECT version FROM store_version WHERE id = 1`).first();
  return Number(row?.version ?? 0);
}

/**
 * The statement that moves the version on. An upsert rather than an UPDATE so a database that
 * predates the store_version table repairs itself on its first write instead of silently
 * leaving every reader on a version that can never change.
 */
function bumpVersion(db) {
  return db.prepare(
    `INSERT INTO store_version (id, version) VALUES (1, 1)
     ON CONFLICT(id) DO UPDATE SET version = store_version.version + 1`,
  );
}

/**
 * Register a message, or complete one already registered.
 *
 * An AMEND is real and routine: the Mac watcher stamps a hand-written email the moment the
 * cursor reaches the body, which can be before the subject exists, then registers again once
 * the subject settles. The Blob version wrote a second file and left the reader to prefer
 * whichever record knew more. Here that preference is the ON CONFLICT clause, so there is only
 * ever one row and no reader has to know the rule.
 *
 * The rule, unchanged from the old reader: a non-empty value beats an empty one, a larger
 * stated audience beats a smaller one, and `registered_at` keeps the EARLIEST of the two —
 * that is when the message was actually sent, which is what the quoted-open logic sorts on.
 */
export async function upsertMessage(db, m) {
  const write = db
    .prepare(
      `INSERT INTO messages
         (token, day, recipient, recipients_json, subject, source,
          recipient_count, registered_at, self_tag, links_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT(token) DO UPDATE SET
         recipient       = CASE WHEN excluded.recipient != '' THEN excluded.recipient ELSE messages.recipient END,
         recipients_json = COALESCE(excluded.recipients_json, messages.recipients_json),
         subject         = CASE WHEN excluded.subject   != '' THEN excluded.subject   ELSE messages.subject   END,
         source          = CASE WHEN excluded.source != 'unknown' THEN excluded.source ELSE messages.source END,
         recipient_count = MAX(messages.recipient_count, excluded.recipient_count),
         registered_at   = MIN(messages.registered_at, excluded.registered_at),
         links_json      = CASE WHEN excluded.links_json != '[]' THEN excluded.links_json ELSE messages.links_json END`,
    )
    .bind(
      m.token,
      m.day,
      m.recipient || '',
      m.recipients ? JSON.stringify(m.recipients) : null,
      m.subject || '',
      m.source || 'unknown',
      Number(m.recipientCount || 0),
      m.registeredAt,
      m.selfTag || '',
      JSON.stringify(Array.isArray(m.links) ? m.links : []),
    );
  return db.batch([write, bumpVersion(db)]);
}

/**
 * Record one pixel fetch or link click.
 *
 * Nothing is filtered on the way in — a scanner fetch, Apple's pre-fetch and the sender's own
 * compose window are all written, each carrying its classification. The difference between
 * "recorded" and "counted" is the whole value of this service.
 */
export async function insertEvent(db, e) {
  const insert = db
    .prepare(
      `INSERT INTO events (token, at, kind, classification, fingerprint, device, destination, device_hint)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      e.token,
      e.at,
      e.kind,
      e.classification,
      e.fingerprint || null,
      e.device || null,
      e.destination || null,
      e.deviceHint || null,
    );
  // One transaction, one round trip: an event that is recorded but not announced would be
  // invisible to every client until the next unrelated write happened to bump the version.
  return db.batch([insert, bumpVersion(db)]);
}

/** Remember a network as the sender's own. Idempotent — the hash is the key. */
export async function rememberSelfHash(db, hash, at = new Date().toISOString()) {
  return db
    .prepare(`INSERT INTO self_ips (hash, first_seen) VALUES (?1, ?2) ON CONFLICT(hash) DO NOTHING`)
    .bind(hash, at)
    .run();
}

/** True if this hash has ever registered a message. */
export async function isKnownSelfHash(db, hash) {
  const row = await db.prepare(`SELECT 1 AS hit FROM self_ips WHERE hash = ?1`).bind(hash).first();
  return Boolean(row);
}

/**
 * A D1 row in the shape the rest of the codebase already speaks.
 *
 * lib/readers.js and lib/quoted-opens.js are untouched by this port, which is only true because
 * what comes out of here is identical to what the Blob reader used to assemble out of pathnames.
 */
function rowToMessage(r) {
  return {
    token: r.token,
    day: r.day,
    recipient: r.recipient || '',
    subject: r.subject || '',
    source: r.source || 'unknown',
    recipientCount: Number(r.recipient_count || 0),
    recipients: parseJSON(r.recipients_json, null),
    sentAt: r.registered_at,
    events: [],
  };
}

function parseJSON(s, fallback) {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}
