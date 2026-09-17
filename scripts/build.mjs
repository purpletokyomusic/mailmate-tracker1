// Bundles worker.js and everything it imports into ONE self-contained ES module.
//
// Why this exists: MailMate's automatic setup (coming in 1.37.0) talks to the Cloudflare API
// directly — it does not clone this repo, run `npm install`, or shell out to `wrangler deploy`.
// It downloads a script and uploads it. `dist/worker.bundle.js` is that script: worker.js plus
// every handler and lib/ file it statically imports, folded into one file with no bare `import
// './handlers/pixel.js'` left for a bundler-less uploader to trip over. `dist/version.json`
// tells the uploader everything else it needs (compatibility settings, the D1 binding, which
// secret to ask for) without it having to parse wrangler.jsonc itself.
//
// Regenerate after any change to worker.js, handlers/, or lib/:
//   npm run build
// test/build.test.mjs runs this same build in memory and fails the suite if the committed
// dist/ has drifted — a stale bundle would otherwise ship silently, since nothing else reads it
// at commit time.

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { parseJsonc } from './jsonc.mjs';

/**
 * Bundles worker.js with esbuild and returns the result in memory (no disk writes) so
 * test/build.test.mjs can compare a fresh build against the committed dist/ without needing its
 * own copy of these options. buildOnly() is the single source of truth for how the bundle is
 * produced — the CLI path below and the test both call it.
 *
 * Settings, and why:
 * - bundle: true, format 'esm' — Cloudflare Workers load one ES module; every relative import
 *   under handlers/ and lib/ has to be folded in.
 * - platform 'neutral', target 'es2022' — this is workerd, not a browser and not Node. 'neutral'
 *   is what lets `external` below take exact effect instead of esbuild guessing at Node- or
 *   browser-specific globals.
 * - external: ['node:crypto'] — the only Node built-in this codebase imports (fingerprint.js,
 *   selfips.js, selftag.js; see wrangler.jsonc's comment on nodejs_compat). Cloudflare's
 *   `nodejs_compat` flag serves it natively at runtime, so it must stay an import, never get
 *   bundled or polyfilled. (`Buffer`, used in lib/paths.js, is referenced as a bare global with
 *   no import statement, so esbuild never touches it — nodejs_compat provides it directly.)
 * - minify: false — Daniel's rule for anything an agent or a person is meant to review before
 *   trusting it on a live account: this file has to stay readable, not just syntactically valid.
 * - charset 'utf8' — without this esbuild escapes every non-ASCII character (em dashes, curly
 *   quotes) as \uXXXX, which is technically correct and unreadable; this repo's comments and
 *   copy use plain UTF-8 punctuation throughout.
 */
export async function buildOnly() {
  const result = await build({
    entryPoints: ['worker.js'],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    conditions: ['workerd', 'worker'],
    external: ['node:crypto'],
    minify: false,
    charset: 'utf8',
    legalComments: 'none',
    write: false,
    banner: {
      js:
        '// GENERATED FILE — do not edit by hand. Run `npm run build` after changing worker.js,\n' +
        '// handlers/, or lib/. See scripts/build.mjs for exactly how this is produced.\n',
    },
  });
  if (result.outputFiles.length !== 1) {
    throw new Error(`expected exactly one output file, got ${result.outputFiles.length}`);
  }
  return result.outputFiles[0].text;
}

/** sha256 of the bundle text, as a lowercase hex string. */
export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The exact contents of dist/version.json — everything MailMate's Cloudflare-API uploader needs
 * to know that isn't baked into the bundle itself: which compatibility settings to pass with the
 * script, what to bind, and which secret to prompt for. Compatibility fields are read straight
 * out of wrangler.jsonc rather than duplicated by hand, so the two can never quietly disagree —
 * test/build.test.mjs checks that agreement independently.
 */
export function versionManifest({ packageJson, wranglerConfig }) {
  return {
    version: packageJson.version,
    compatibility_date: wranglerConfig.compatibility_date,
    compatibility_flags: wranglerConfig.compatibility_flags,
    main: 'worker.bundle.js',
    bindings: [{ type: 'd1', name: wranglerConfig.d1_databases[0].binding }],
    secrets: ['TRACKER_SECRET'],
  };
}

async function main() {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  const wranglerConfig = parseJsonc(readFileSync('wrangler.jsonc', 'utf8'));

  const bundle = await buildOnly();
  const manifest = versionManifest({ packageJson, wranglerConfig });

  mkdirSync('dist', { recursive: true });
  writeFileSync('dist/worker.bundle.js', bundle);
  writeFileSync('dist/worker.bundle.sha256', sha256Hex(bundle) + '\n');
  writeFileSync('dist/version.json', JSON.stringify(manifest, null, 2) + '\n');

  console.log('wrote dist/worker.bundle.js,', bundle.length, 'bytes');
  console.log('wrote dist/worker.bundle.sha256');
  console.log('wrote dist/version.json:', JSON.stringify(manifest));
}

// Only run the CLI path when invoked directly (`node scripts/build.mjs` / `npm run build`), not
// when test/build.test.mjs imports buildOnly()/sha256Hex()/versionManifest() for its own checks.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
