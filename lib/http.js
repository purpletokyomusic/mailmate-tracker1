// Request helpers, for the Workers runtime.
//
// The Vercel version read `req.headers['x-forwarded-for']` and `req.socket.remoteAddress`.
// Neither exists here: a Worker is handed a standard `Request`, so headers come from
// `request.headers.get(...)` and there is no socket at all.

/**
 * The requesting address.
 *
 * `CF-Connecting-IP` is set by Cloudflare on every request and cannot be spoofed by the caller,
 * which makes it strictly better than the `X-Forwarded-For` this used to read — that header is
 * caller-supplied, and a forged one would have let a stranger impersonate the sender's own
 * network and have their opens written off as `self`. X-Forwarded-For is kept only as a
 * fallback for local `wrangler dev`, where Cloudflare's own header is absent.
 */
export function clientIp(request) {
  const cf = request.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return '';
}

/**
 * Constant-time string comparison.
 *
 * A plain `===` on a secret leaks its length and its matching prefix through how long the
 * comparison takes. The window is narrow over the internet, but this is the only thing between
 * a stranger and the entire event store, and comparing every character costs nothing.
 */
export function secretsMatch(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (x.length === 0 || y.length === 0) return false;
  // Length is folded in as data rather than taken as an early return, so a wrong-length guess
  // walks the same path as a wrong-value one.
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    diff |= x.charCodeAt(i % x.length) ^ y.charCodeAt(i % y.length);
  }
  return diff === 0;
}

/**
 * Does this request carry the tracker secret?
 *
 * Fails closed on an unset secret: an unconfigured deployment must refuse to hand over the
 * event store, never serve it to everyone.
 */
export function authorized(request, env) {
  const secret = env?.TRACKER_SECRET;
  if (!secret) return false;
  const given = request.headers.get('x-tracker-secret');
  if (!given) return false;
  return secretsMatch(given, secret);
}

/** JSON response, with the store's no-caching rule already applied. */
export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
