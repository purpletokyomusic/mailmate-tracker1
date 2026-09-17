// What stands at the old address after the tracker moved to Cloudflare.
//
// Every email sent before 2026-09-04 — 431 of them — carries a pixel and link pointing at
// tracker-chi-orpin.vercel.app, baked into mail that has already left. Those URLs cannot be
// changed, and hotel outreach means those threads keep being reopened for weeks. Switching
// MailMate to the Worker without leaving something here would silently stop recording opens on
// every message already sent.
//
// So this forwards, and does nothing else. It reads nothing, writes nothing, and touches no
// storage — which is the point: the Blob operations that forced the paid plan drop to zero
// while the old addresses keep working.
//
// Why a redirect rather than a proxy. A 302 makes the mail client fetch the Worker ITSELF, so
// Cloudflare sees the real requester. A server-side proxy would put this function's address in
// front of every fetch, and since a reader's fingerprint is a hash of their network, every
// forwarded open would collapse into one fake reader and the attribution would quietly become
// nonsense. Mail clients and image proxies — Gmail's included — follow redirects.

const TARGET = process.env.TRACKER_FORWARD_TO || 'https://mailmate-tracker.kelleghan.workers.dev';

// A 1×1 transparent GIF, for the one case where redirecting is not safe.
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');

export default function handler(req, res) {
  const path = String(req.url || '/');

  // /events and /register are the CLIENT endpoints. They carry the secret in a header, and a
  // redirect is not guaranteed to carry headers across hosts — so rather than half-forward them
  // and produce a confusing 401, say plainly that the client is pointed at the wrong address.
  // Nothing should ever hit these here: MailMate and the extension are configured directly.
  if (path.startsWith('/events') || path.startsWith('/register')) {
    res.status(410).json({
      error: 'This tracker has moved.',
      moved_to: TARGET,
      fix: 'Update the tracker address in MailMate → Settings → Tracking, and in the Chrome extension options.',
    });
    return;
  }

  // Pixels and clicks: forward, preserving the whole path so the token, the signed self-tag and
  // the encoded destination all arrive intact.
  if (path.startsWith('/p/') || path.startsWith('/l/')) {
    res.writeHead(302, {
      Location: TARGET + path,
      // Never let a redirect for a tracking pixel be cached: a cached 302 is harmless, but a
      // cached response of any kind on this path risks a mail client reusing an old answer
      // instead of fetching, which would lose the open.
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0, private',
    });
    res.end();
    return;
  }

  // Anything else gets a valid pixel rather than an error. If some URL shape is being requested
  // that was not anticipated, a working transparent GIF is a far better outcome than a broken
  // image icon in somebody's inbox.
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Content-Length', String(GIF.length));
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');
  res.status(200).end(GIF);
}
