import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { SCHEMA_SQL, statementsOf, ensureSchema, _resetSchemaForTests } from '../lib/schema.js';

test('the embedded schema is a byte-for-byte copy of schema.sql', () => {
  // lib/schema.js exists because a Worker cannot read a file off disk at runtime — the schema
  // has to travel as a JS string. This is the one thing standing between that and silent drift:
  // if schema.sql changes and nobody regenerates lib/schema.js (scripts/embed-schema.mjs), a
  // fresh deploy would create tables that no longer match what the rest of the code expects.
  const onDisk = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  assert.equal(SCHEMA_SQL, onDisk, 'run `node scripts/embed-schema.mjs` after editing schema.sql');
});

test('statementsOf splits the real schema into exactly the statements schema.sql defines', () => {
  const stmts = statementsOf(SCHEMA_SQL);
  assert.equal(stmts.length, 8);
  assert.match(stmts[0], /^CREATE TABLE IF NOT EXISTS messages/);
  assert.match(stmts[1], /^CREATE INDEX IF NOT EXISTS messages_registered_at/);
  assert.match(stmts[2], /^CREATE TABLE IF NOT EXISTS events/);
  assert.match(stmts[3], /^CREATE INDEX IF NOT EXISTS events_token_at/);
  assert.match(stmts[4], /^CREATE INDEX IF NOT EXISTS events_at_covering/);
  assert.match(stmts[5], /^CREATE TABLE IF NOT EXISTS self_ips/);
  assert.match(stmts[6], /^CREATE TABLE IF NOT EXISTS store_version/);
  assert.match(stmts[7], /^INSERT OR IGNORE INTO store_version/);
  // No leftover comment lines and no stray blank statements.
  for (const s of stmts) {
    assert.ok(!s.includes('--'), `a comment leaked into a statement: ${s.slice(0, 40)}`);
    assert.ok(s.length > 0);
  }
});

/** A minimal fake D1 binding: enough of `.prepare().first()` and `.batch()` to test ensureSchema. */
function fakeDb({ hasTable = false } = {}) {
  const calls = { batches: 0, checks: 0 };
  return {
    calls,
    prepare(sql) {
      return {
        sql,
        bind: () => this,
        first: async () => {
          calls.checks++;
          return hasTable ? { ok: 1 } : null;
        },
      };
    },
    batch(statements) {
      calls.batches++;
      return Promise.resolve(statements.map(() => ({ success: true })));
    },
  };
}

test('ensureSchema runs the batch on a fresh database', async () => {
  const db = fakeDb({ hasTable: false });
  await ensureSchema(db);
  assert.equal(db.calls.checks, 1);
  assert.equal(db.calls.batches, 1, 'a fresh database gets the 8-statement batch');
});

test('ensureSchema is a no-op when store_version already exists (Daniel\'s own database)', async () => {
  const db = fakeDb({ hasTable: true });
  await ensureSchema(db);
  assert.equal(db.calls.checks, 1);
  assert.equal(db.calls.batches, 0, 'an established database is never batch-written to');
});

test('ensureSchema is memoized: a second call on the same db object does not touch it again', async () => {
  const db = fakeDb({ hasTable: false });
  await ensureSchema(db);
  await ensureSchema(db);
  await ensureSchema(db);
  assert.equal(db.calls.checks, 1, 'only the first call ever queries sqlite_master');
  assert.equal(db.calls.batches, 1);
});

test('ensureSchema deduplicates concurrent first calls into one check and one batch', async () => {
  const db = fakeDb({ hasTable: false });
  await Promise.all([ensureSchema(db), ensureSchema(db), ensureSchema(db)]);
  assert.equal(db.calls.checks, 1, 'concurrent callers share the same in-flight promise');
  assert.equal(db.calls.batches, 1);
});

test('two independent db objects get independent memo entries — no cross-test leakage', async () => {
  const dbA = fakeDb({ hasTable: false });
  const dbB = fakeDb({ hasTable: false });
  await ensureSchema(dbA);
  assert.equal(dbB.calls.checks, 0, 'a different db object has never been touched');
  await ensureSchema(dbB);
  assert.equal(dbB.calls.checks, 1);
});

test('_resetSchemaForTests forgets one db object so its first-call behaviour can be re-observed', async () => {
  const db = fakeDb({ hasTable: false });
  await ensureSchema(db);
  assert.equal(db.calls.batches, 1);
  _resetSchemaForTests(db);
  await ensureSchema(db);
  assert.equal(db.calls.batches, 2, 'forgetting the memo makes the next call check again');
});
