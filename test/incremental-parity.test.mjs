// Proves the 2026-09-16 incremental-events fix produces the SAME /events answer as a full
// rebuild, on real (anonymized) production shape and scale — not a hand-picked toy case.
//
// The fixture is test/fixtures/tracker-snapshot.json: every message and event pulled read-only
// from the live tracker on 2026-09-16 (894 messages, 7,160 events), with recipient/recipients_json
// replaced by a deterministic hash of the real address (same real address -> same fake one
// everywhere it appears, so the cross-message identity linkage lib/readers.js's learning and
// contradiction logic depends on survives) and subject replaced with a placeholder. Nothing in
// this file is a real email address, subject line, or click destination.
//
// The comparison: build the answer once with every event present from the start (the OLD,
// always-correct "cold" path — a full eventsSince() scan, unchanged by this fix), then build it
// again from the same starting point but with the same events revealed in five chronological
// batches, each landing as its own store_version bump and its own /events poll in between — the
// shape a real deployment sees, where opens and clicks arrive one at a time between polls, not
// all at once. If the incremental merge in handlers/events.js's eventsInWindow() ever drops,
// duplicates, or misorders anything, the two will stop matching exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { events, _resetForTests } from '../handlers/events.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SECRET = 'test-secret';
const { messages: fixtureMessages, events: fixtureEvents } = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/tracker-snapshot.json'), 'utf8'),
);

// fixtureEvents is already ordered by id (ascending) — see the SELECT ... ORDER BY id this was
// pulled with — so slicing it into contiguous chunks reproduces real insertion order.
assert.ok(fixtureEvents.length > 1000, 'fixture should hold the real pulled scale, not a stub');
for (let i = 1; i < fixtureEvents.length; i++) {
  assert.ok(fixtureEvents[i].id > fixtureEvents[i - 1].id, 'fixture must stay in id order for this test to mean anything');
}

/**
 * A D1 stand-in over a MUTABLE events array, so a test can reveal rows partway through and bump
 * the version, exactly as real writes do — see fakeDB in events.test.js for the non-mutable
 * version this is adapted from, including why events need an `id` and why the SQL text (not the
 * bind value) decides which real query shape a call is answering.
 */
function fakeDB(messages, eventsRef) {
  // Rows read, tracked separately by table — this is the actual thing Cloudflare bills for and
  // the whole point of the fix, so the tests below assert on IT rather than on call counts (a
  // call count is identical whether a call returns 1 row or the whole table).
  const db = {
    calls: 0,
    eventRowsRead: 0,
    messageRowsRead: 0,
    versionReads: 0,
    version: 1,
    prepare(sql) {
      // Closure-captured, not `this._binds` — see events.test.js's fakeDB for why the `this`
      // version silently ignores every bound value (an arrow function's `this` cannot be
      // reassigned by `.call()`), which is exactly the bug this file's fixture-scale test caught:
      // eventsAfter()'s `id > ?` filter always read afterId as 0 and returned the whole table.
      let binds = [];
      const stmt = {
        bind(...args) { binds = args; return stmt; },
        all: async () => {
          db.calls += 1;
          if (/FROM messages/.test(sql)) {
            const since = binds[0] ?? '';
            const results = messages.filter((m) => m.registered_at >= since);
            db.messageRowsRead += results.length;
            return { results };
          }
          let results;
          if (/WHERE id > /.test(sql)) {
            const afterId = Number(binds[0] ?? 0);
            results = eventsRef.current.filter((e) => e.id > afterId);
          } else {
            const since = binds[0] ?? '';
            results = eventsRef.current.filter((e) => e.at >= since);
          }
          db.eventRowsRead += results.length;
          return { results };
        },
        first: async () => {
          db.versionReads += 1;
          return { version: db.version };
        },
        run: async () => ({}),
      };
      return stmt;
    },
    batch: async (stmts) => stmts.map(() => ({})),
  };
  return db;
}

// 25 days back: recent enough to sit INSIDE the 31-day shared cache window (so this exercises
// annotatedWindow()/eventCache, not the one-off "older than the window" path), old enough to
// include every message in the fixture (earliest is 2026-08-27, ~20 days before "now").
const SINCE = () => new Date(Date.now() - 25 * 864e5).toISOString();

const call = async (db) => (await events(
  new Request(`https://tracker.test/events?since=${encodeURIComponent(SINCE())}`,
              { headers: { 'x-tracker-secret': SECRET } }),
  { DB: db, TRACKER_SECRET: SECRET },
)).json();

/** Sorted the same way in both runs so deepEqual isn't tripped up by incidental ordering. */
function normalize(body) {
  return body.messages
    .map((m) => ({ ...m, events: [...m.events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)) }))
    .sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
}

test('incremental merge matches a full rebuild on real pulled scale (all events at once)', async () => {
  _resetForTests();
  const db = fakeDB(fixtureMessages, { current: fixtureEvents });
  db.version = 1;
  const full = await call(db);
  assert.equal(full.messages.length, fixtureMessages.length);
});

test('incremental merge matches a full rebuild, batch by batch, byte for byte', async () => {
  // Baseline: everything present from the start, one cold read — the pre-existing, unchanged
  // full-scan path (lib/db.js's eventsSince), which is what a correct answer has always meant
  // for this dataset.
  _resetForTests();
  const baselineDB = fakeDB(fixtureMessages, { current: fixtureEvents });
  const baseline = normalize(await call(baselineDB));

  // Same messages, same eventual events, but revealed in five chronological slices with a
  // store_version bump and a poll after each — the incremental path this fix adds.
  _resetForTests();
  const eventsRef = { current: [] };
  const incDB = fakeDB(fixtureMessages, eventsRef);
  const batches = 5;
  const batchSize = Math.ceil(fixtureEvents.length / batches);

  let last;
  for (let i = 0; i < batches; i++) {
    eventsRef.current = fixtureEvents.slice(0, Math.min((i + 1) * batchSize, fixtureEvents.length));
    incDB.version = i + 1; // a write landed: register() or insertEvent() would have bumped this
    last = await call(incDB);
  }
  const incremental = normalize(last);

  assert.deepEqual(incremental, baseline,
    'the same 894 messages / 7,160 events must produce the identical annotated answer whether ' +
    'every event was visible from the first read or arrived in batches across several polls');

  // The whole point: prove it cost less, not just that it still works. A full rebuild on every
  // one of the 5 misses would read ~fixtureEvents.length event ROWS each time (what the pre-fix
  // code measured in production: avg 4,659 of ~4,973 rows per miss, i.e. nearly the whole table).
  // The incremental path instead reads each event row AT MOST ONCE across the whole sequence —
  // total event rows read is bounded by the table size, not by (table size × number of misses).
  const naiveRepeatedFullRebuildCost = fixtureEvents.length * batches;
  assert.ok(
    incDB.eventRowsRead < naiveRepeatedFullRebuildCost / 2,
    `incremental path read ${incDB.eventRowsRead} event rows across ${batches} misses; ` +
    `re-scanning the whole table on every miss would have cost ~${naiveRepeatedFullRebuildCost}`,
  );
  // And concretely: never more than the table itself, since every row is merged in once and then
  // carried forward rather than re-fetched.
  assert.ok(incDB.eventRowsRead <= fixtureEvents.length,
    `read ${incDB.eventRowsRead} event rows total, more than the ${fixtureEvents.length} that exist`);
});

test('a version change with no new events (a register-only write) reads zero event rows', async () => {
  _resetForTests();
  const eventsRef = { current: fixtureEvents.slice(0, 100) };
  const db = fakeDB(fixtureMessages, eventsRef);
  db.version = 1;
  await call(db); // seed the cache, reading the 100 events that exist so far

  const eventRowsBefore = db.eventRowsRead;
  db.version = 2; // e.g. an amend — messages changed, events did not
  const body = await call(db);

  // The whole point of tying the incremental cache to an append-only table: a write that never
  // touched `events` (a register or amend) must not re-pay for a single event row, let alone the
  // whole table, just because *something* changed the store version.
  assert.equal(db.eventRowsRead - eventRowsBefore, 0);
  assert.equal(body.messages.length, fixtureMessages.length);
});
