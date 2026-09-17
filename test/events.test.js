// What /events must keep doing now that it answers repeat polls from memory.
//
// The endpoint is polled far more often than the store is written to — 755 times against 298
// writes on the day this was measured — and it used to re-read the whole store for every one of
// those polls. These tests pin the two halves of the fix that can break silently: that an
// unchanged store is not read again, and that a changed one always is.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { events, _resetForTests } from '../handlers/events.js';

const SECRET = 'test-secret';
const DAY = 864e5;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

// The incremental events cache added 2026-09-16 lives at module scope, same as `memo` always
// has. Every test here builds its own fake store, so without this reset a later test could read
// leftover events (or a leftover high-water mark) from an EARLIER test's completely different
// store — the same hazard `memo` avoids by using a version number no earlier test could have
// left behind, but there's no equivalent trick for an event id sequence that restarts at 1 in
// every fakeDB(). Reset both so each test starts cold, exactly as a fresh isolate would.
beforeEach(() => _resetForTests());

/**
 * A D1 stand-in that records which tables each request touched, in order.
 *
 * The order is the point: reading the version AFTER the rows would let a write that landed in
 * between stamp a new number onto an old answer, and every later poll would match that number
 * and serve it. A fake that only counted calls could not tell the two apart.
 *
 * Events carry an auto-assigned `id` (1, 2, 3… in array order) so the fake can answer BOTH real
 * event query shapes: `WHERE at >= ?` (a full scan) and `WHERE id > ?` (lib/db.js's eventsAfter,
 * the incremental half) — matched by which bound placeholder the SQL text actually uses, not by
 * guessing from bind value shape.
 */
function fakeDB({ messages = [], events: evts = [], version = 1 } = {}) {
  const events2 = evts.map((e, i) => ({ id: i + 1, ...e }));
  const db = {
    calls: [],
    version,
    prepare(sql) {
      // A closure variable, not `this._binds` on the returned statement object: `all` used to be
      // an arrow function reading `this`, and an arrow function's `this` is fixed at the point it
      // is DEFINED, not at the call site — so wrapping it in `async () => all.call(stmt)` below
      // was a no-op, and `this` inside it was always `db`, which never had a `_binds` property.
      // Every bound value silently read back as undefined. Harmless for the original tests (the
      // real request-level filter in handlers/events.js is what they actually check), but fatal
      // for eventsAfter()'s `id > ?` filter: `afterId` always came back 0, so every "incremental"
      // fetch silently returned the WHOLE table again — found via the 2026-09-16 parity test
      // duplicating events under real load before this fix.
      let binds = [];
      const stmt = {
        bind(...args) { binds = args; return stmt; },
        all: async () => {
          if (/FROM messages/.test(sql)) {
            db.calls.push('messages');
            const since = binds[0] ?? '';
            return { results: messages.filter((m) => m.registered_at >= since) };
          }
          db.calls.push('events');
          if (/WHERE id > /.test(sql)) {
            const afterId = Number(binds[0] ?? 0);
            return { results: events2.filter((e) => e.id > afterId) };
          }
          const since = binds[0] ?? '';
          return { results: events2.filter((e) => e.at >= since) };
        },
        first: async () => {
          // ensureSchema() (lib/schema.js) probes sqlite_master before anything else touches the
          // db — every handler calls it now, including events(). This fake represents an
          // already-migrated store, so that probe is answered as "already set up" without being
          // logged: these tests are about the version-cache behaviour below it, not schema
          // self-init, which has its own dedicated coverage in test/schema.test.mjs.
          if (/sqlite_master/.test(sql)) return { ok: 1 };
          db.calls.push('version');
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

const message = (token, daysAgo, extra = {}) => ({
  token, day: '2026-09-01', recipient: `${token}@example.com`, recipients_json: null,
  subject: `Subject ${token}`, source: 'test', recipient_count: 1,
  registered_at: iso(daysAgo * DAY), ...extra,
});

const openEvent = (token, daysAgo) => ({
  token, at: iso(daysAgo * DAY), kind: 'open', classification: 'human',
  fingerprint: `fp-${token}`, device: 'mac|mail',
});

const call = (db, since) => events(
  new Request(`https://tracker.test/events${since ? `?since=${encodeURIComponent(since)}` : ''}`,
              { headers: { 'x-tracker-secret': SECRET } }),
  { DB: db, TRACKER_SECRET: SECRET },
);

test('an unchanged store is not read a second time', async () => {
  const db = fakeDB({
    version: 101,
    messages: [message('a', 1), message('b', 3)],
    events: [openEvent('a', 1)],
  });

  const since = iso(14 * DAY);
  const first = await (await call(db, since)).json();
  assert.equal(first.count, 2);
  assert.deepEqual(db.calls, ['version', 'messages', 'events'],
    'the first poll reads the version, then the rows');

  const second = await (await call(db, since)).json();
  assert.deepEqual(second, first, 'the same answer, byte for byte');
  assert.deepEqual(db.calls, ['version', 'messages', 'events', 'version'],
    'the second poll reads the version and stops there');
});

test('a write is always picked up', async () => {
  const db = fakeDB({ version: 201, messages: [message('a', 1)], events: [] });
  await call(db, iso(14 * DAY));
  db.calls.length = 0;

  db.version = 202;                       // something was written
  const after = await (await call(db, iso(14 * DAY))).json();

  assert.deepEqual(db.calls, ['version', 'messages', 'events'],
    'a changed version rebuilds from the store rather than serving the old answer');
  assert.equal(after.count, 1);
});

test('the version is read before the rows it labels', async () => {
  const db = fakeDB({ version: 301, messages: [message('a', 1)], events: [] });
  await call(db, iso(14 * DAY));
  assert.equal(db.calls[0], 'version',
    'reading it afterwards would stamp a new number onto an answer built before the write');
});

test('a narrower window is a filter over the shared answer, not another query', async () => {
  const db = fakeDB({
    version: 401,
    messages: [message('recent', 2), message('older', 20)],
    events: [openEvent('recent', 1), openEvent('older', 19)],
  });

  const wide = await (await call(db, iso(30 * DAY))).json();
  assert.deepEqual(wide.messages.map((m) => m.token).sort(), ['older', 'recent']);

  db.calls.length = 0;
  const narrow = await (await call(db, iso(5 * DAY))).json();
  assert.deepEqual(narrow.messages.map((m) => m.token), ['recent'],
    'the 20-day-old message is outside a 5-day window');
  assert.deepEqual(db.calls, ['version'], 'and answering it cost one row');
});

test('a request reaching past the shared window is answered from the store', async () => {
  const db = fakeDB({ version: 501, messages: [message('ancient', 60)], events: [] });
  const body = await (await call(db, iso(90 * DAY))).json();

  assert.deepEqual(db.calls, ['messages', 'events'],
    'too wide to serve from the shared answer, so it goes straight to the store');
  assert.equal(body.count, 1, 'and it still gets the 60-day-old message');
});

test('an event whose message is outside the window is dropped, not attached', async () => {
  const db = fakeDB({
    version: 601,
    messages: [message('kept', 1)],
    events: [openEvent('kept', 1), openEvent('vanished-message', 2)],
  });

  const body = await (await call(db, iso(14 * DAY))).json();
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].events.length, 1,
    'querying events by time can return orphans; they must not land on another message');
});

test('an unconfigured or wrong secret is still refused', async () => {
  const db = fakeDB({ version: 701 });
  const res = await events(
    new Request('https://tracker.test/events', { headers: { 'x-tracker-secret': 'wrong' } }),
    { DB: db, TRACKER_SECRET: SECRET },
  );
  assert.equal(res.status, 401);
  assert.deepEqual(db.calls, [], 'and it never reaches the store');
});
