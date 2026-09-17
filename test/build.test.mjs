import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { buildOnly, sha256Hex, versionManifest } from '../scripts/build.mjs';
import { parseJsonc } from '../scripts/jsonc.mjs';

// dist/worker.bundle.js is committed so it can be fetched raw from GitHub (MailMate's automatic
// Cloudflare-API setup downloads it directly — see CLAUDE.md). Nothing else regenerates it at
// commit time, so a code change with no `npm run build` afterward would ship a bundle that no
// longer matches worker.js/handlers/lib — silently, since the committed file still "looks" fine.
// These tests are what makes that fail the suite instead.

test('dist/worker.bundle.js matches a fresh build of worker.js, byte-for-byte', async () => {
  const committed = readFileSync(new URL('../dist/worker.bundle.js', import.meta.url), 'utf8');
  const fresh = await buildOnly();
  assert.equal(
    committed,
    fresh,
    'dist/ is stale — run `npm run build` after changing worker.js, handlers/, or lib/'
  );
});

test('dist/worker.bundle.sha256 matches the committed bundle', async () => {
  const committed = readFileSync(new URL('../dist/worker.bundle.js', import.meta.url), 'utf8');
  const shaFile = readFileSync(new URL('../dist/worker.bundle.sha256', import.meta.url), 'utf8').trim();
  assert.match(shaFile, /^[0-9a-f]{64}$/, 'expected a lowercase 64-char hex sha256 digest');
  assert.equal(shaFile, sha256Hex(committed), 'run `npm run build` to regenerate the sha256 file');
});

test("dist/version.json's compatibility fields match wrangler.jsonc", () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const wranglerConfig = parseJsonc(
    readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
  );
  const version = JSON.parse(readFileSync(new URL('../dist/version.json', import.meta.url), 'utf8'));
  const expected = versionManifest({ packageJson, wranglerConfig });

  assert.deepEqual(version, expected, 'run `npm run build` to regenerate dist/version.json');

  // Pinned expectations too, not just "matches whatever versionManifest() computes" — a future
  // edit to versionManifest() that quietly drops a field should still be caught here.
  assert.equal(version.version, packageJson.version);
  assert.equal(version.compatibility_date, wranglerConfig.compatibility_date);
  assert.deepEqual(version.compatibility_flags, wranglerConfig.compatibility_flags);
  assert.equal(version.main, 'worker.bundle.js');
  assert.deepEqual(version.bindings, [{ type: 'd1', name: wranglerConfig.d1_databases[0].binding }]);
  assert.deepEqual(version.secrets, ['TRACKER_SECRET']);
});

test('the committed bundle is valid, importable ESM that exports a fetch handler', async () => {
  // A syntax or resolution error here would mean the "MailMate downloads and uploads this
  // directly" story in CLAUDE.md is broken — this is the cheapest possible check that the file
  // is actually a working Worker script, short of running it under workerd (see the manual
  // `wrangler dev --local` verification recorded in CLAUDE.md/README.md).
  const mod = await import('../dist/worker.bundle.js');
  assert.equal(typeof mod.default, 'object');
  assert.equal(typeof mod.default.fetch, 'function');
});

test('stripJsonComments leaves a "//" inside a string literal alone', async () => {
  const { stripJsonComments } = await import('../scripts/jsonc.mjs');
  const text = '{"url": "https://example.com", "n": 1 /* trailing */}';
  const stripped = stripJsonComments(text);
  assert.deepEqual(JSON.parse(stripped), { url: 'https://example.com', n: 1 });
});
