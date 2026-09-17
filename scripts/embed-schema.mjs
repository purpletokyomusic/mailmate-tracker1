import { readFileSync, writeFileSync } from 'node:fs';

const sql = readFileSync('schema.sql', 'utf8');
const embedded = JSON.stringify(sql);

const out = `// The schema, embedded so the Worker can create it on a fresh D1 database with no manual
// step — see ensureSchema() below. schema.sql remains the single source of truth; this constant
// is a generated, byte-for-byte copy of it (test/schema.test.mjs fails loudly if they diverge).
//
// Regenerate after any change to schema.sql:
//   node scripts/embed-schema.mjs

export const SCHEMA_SQL = ${embedded};

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
    .split('\\n')
    .map((line) => {
      const i = line.indexOf('--');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Memoized per D1 BINDING OBJECT, not globally: the first call keyed to a given \`db\` creates
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
    .prepare(\`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'store_version'\`)
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
`;

writeFileSync('lib/schema.js', out);
console.log('wrote lib/schema.js,', out.length, 'bytes');
