import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { isValidToken } from '../lib/token.js';

// The failure this guards: a hand-written email stamped when the cursor reached the body but
// BEFORE the subject was typed registered with subject '' — its pixel worked, but the Sent
// window and panel match by subject, so a live, recording message displayed as "Not tracked".
//
// This used to read api/register.js and api/events.js. The Cloudflare port deleted both, so the
// file threw ENOENT and the whole suite has been red since 2026-09-04 — the assertions were not
// wrong, they were pointed at files that no longer exist. The rule now lives in the ON CONFLICT
// clause in lib/db.js, which is where this looks for it.
const registerSrc = fs.readFileSync('handlers/register.js', 'utf8');
const dbSrc = fs.readFileSync('lib/db.js', 'utf8');

test('register accepts a caller-supplied token for amends, validated against the token format', () => {
  assert.match(registerSrc, /isValidToken\(item\.token\)\s*\?\s*item\.token\s*:\s*newToken\(\)/);
  assert.ok(isValidToken('20260904T120000-Abcdefghijkm'), 'a well-formed token is accepted');
  assert.ok(!isValidToken('not-a-token'), 'anything else falls back to a freshly minted one');
});

test('when one token is registered twice, the record that knows the subject wins', () => {
  assert.match(
    dbSrc,
    /subject\s*=\s*CASE WHEN excluded\.subject\s*!= ''\s*THEN excluded\.subject\s*ELSE messages\.subject\s*END/,
    'an amend carrying a subject must overwrite the blank one, and never the other way round',
  );
});

test('an amend keeps the earliest registration time, which is when the message was sent', () => {
  assert.match(dbSrc, /registered_at\s*=\s*MIN\(messages\.registered_at, excluded\.registered_at\)/);
});
