import { test } from 'node:test';
import assert from 'node:assert';
import { fingerprint, deviceFamily, isSharedBucket, SHARED_BUCKETS } from '../lib/fingerprint.js';

const S = 'test-secret';
const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36';
const CHROME_WIN_NEWER = CHROME_WIN.replace('109.0.0.0', '131.0.0.0');
const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';

test('the same person on the same network fingerprints the same', () => {
  assert.equal(fingerprint({ ip: '72.152.1.4', userAgent: CHROME_WIN, secret: S }),
               fingerprint({ ip: '72.152.1.4', userAgent: CHROME_WIN, secret: S }));
});

test('a browser update does not turn a known reader into a stranger', () => {
  assert.equal(fingerprint({ ip: '72.152.1.4', userAgent: CHROME_WIN, secret: S }),
               fingerprint({ ip: '72.152.1.4', userAgent: CHROME_WIN_NEWER, secret: S }));
});

test('two different people on the same network are told apart by device', () => {
  assert.notEqual(fingerprint({ ip: '72.152.1.4', userAgent: CHROME_WIN, secret: S }),
                  fingerprint({ ip: '72.152.1.4', userAgent: SAFARI_MAC, secret: S }));
});

test('the same device on a different network is a different fingerprint', () => {
  assert.notEqual(fingerprint({ ip: '72.152.1.4', userAgent: CHROME_WIN, secret: S }),
                  fingerprint({ ip: '9.9.9.9', userAgent: CHROME_WIN, secret: S }));
});

test('no IP address survives into the fingerprint', () => {
  const fp = fingerprint({ ip: '72.152.1.4', userAgent: CHROME_WIN, secret: S });
  assert.ok(!fp.includes('72'), `fingerprint ${fp} leaks the address`);
  assert.match(fp, /^[0-9a-f]{10}$/);
});

test('every Gmail reader collapses into one honest bucket', () => {
  const a = fingerprint({ ip: '74.125.1.1', userAgent: 'Mozilla/5.0 (via ggpht.com GoogleImageProxy)', secret: S });
  const b = fingerprint({ ip: '66.249.9.9', userAgent: 'Mozilla/5.0 (via ggpht.com GoogleImageProxy)', secret: S });
  assert.equal(a, SHARED_BUCKETS.GMAIL);
  assert.equal(a, b, 'Gmail readers must not be presented as distinct people');
  assert.ok(isSharedBucket(a));
});

test("Apple's privacy relay collapses the same way", () => {
  assert.equal(fingerprint({ ip: '17.58.20.4', userAgent: SAFARI_MAC, secret: S }), SHARED_BUCKETS.APPLE);
  assert.ok(isSharedBucket(SHARED_BUCKETS.APPLE));
});

test('a real reader is never treated as a shared bucket', () => {
  assert.ok(!isSharedBucket(fingerprint({ ip: '72.152.1.4', userAgent: CHROME_WIN, secret: S })));
});

test('device family drops versions but keeps OS and client', () => {
  assert.equal(deviceFamily(CHROME_WIN), 'windows|chrome');
  assert.equal(deviceFamily(SAFARI_MAC), 'mac|safari');
  assert.equal(deviceFamily(''), 'unknown|unknown');
});
