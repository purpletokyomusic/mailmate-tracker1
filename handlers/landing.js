// GET /  →  a plain, unauthenticated status page.
//
// This exists because the deploy is otherwise silent: a friend who clicks "Deploy to
// Cloudflare" (or hands this to their own Claude) lands on a bare workers.dev URL with nothing
// to look at, and no way to tell whether the one manual step — setting TRACKER_SECRET — is
// still outstanding. This page answers both questions and touches no auth and no store, so it
// works even before the secret is set and even if D1 is unreachable.
//
// Never reveals the secret's VALUE, only whether one is configured — the same rule /events and
// /register already enforce by requiring it in a header rather than accepting it in a query
// string that could end up in a server log.

const STYLE = `
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  max-width: 40em; margin: 3em auto; padding: 0 1.5em; color: #1a1a1a; background: #fff;
`;

export function landing(request, env) {
  const origin = new URL(request.url).origin;
  const hasSecret = Boolean(env.TRACKER_SECRET);

  const secretLine = hasSecret
    ? '<p>Secret: <strong>set ✓</strong></p>'
    : '<p>Secret: <strong>NOT SET</strong> — add <code>TRACKER_SECRET</code> under your Worker\'s '
      + '<strong>Settings → Variables and Secrets</strong>, as a Secret (not a plain text Variable). '
      + 'Until then, MailMate and the Gmail extension can be pointed at this address but every '
      + 'request will be refused.</p>';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MailMate tracker</title>
<style>body { ${STYLE} } code { background: #f2f2f2; padding: 0.15em 0.4em; border-radius: 3px; }</style>
</head>
<body>
<h1>Your MailMate tracker is running.</h1>
<p>Address to paste into MailMate: <code>${origin}</code></p>
${secretLine}
<p>This page needs no login, on purpose — MailMate's own docs point people here first to confirm
the deploy worked. Nothing else on this service is readable without the secret.</p>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
