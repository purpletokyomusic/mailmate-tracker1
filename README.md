# MailMate tracker

The open- and click-tracking service behind MailMate's "someone opened your email" panel — the
Chrome/Gmail extension uses the same service.

**Everyone runs their own copy.** That's the whole design: this service sees who you email and
when they read it, so it belongs to you and nobody else. Two people sharing one tracker share
that data, and the secret it uses is a master key to all of it — so don't share it, and don't
share a deployment.

Free to run, on Cloudflare's own free tier (a Worker plus a small D1 database) at ordinary email
volumes.

## Set this up

Three ways to get your own tracker running. Try them in this order:

### 1. Automatic — MailMate does it for you (coming in MailMate 1.37.0)

You create a free Cloudflare account and one API token; MailMate's Settings → Email Tracking
does the rest — creates your D1 database, uploads the Worker, sets your secret, and fills in its
own settings with the resulting address. No terminal, no repository to clone.

Not shipped yet as of this writing — use option 2 or 3 below until it lands, then switch to this
one for any future updates.

### 2. Let Claude do it (no GitHub account needed)

This works from a plain clone or download of this repository — nothing to sign in to except
Cloudflare itself. Open a chat with Claude (Claude Code on your own computer, or a claude.ai chat
with file/computer access) in this project's folder and paste:

> Read CLAUDE.md in this repository and deploy this tracker for me on Cloudflare. I'll approve
> the Cloudflare login in my browser when you ask; generate a random secret if I don't already
> have one. When you're done, tell me the tracker address and the secret so I can paste them
> into MailMate.

It walks through logging into your own Cloudflare account (you approve that step yourself — no
agent can or should do it for you), creating your database, deploying, and setting your secret.
[`CLAUDE.md`](./CLAUDE.md) is the exact script it follows — the same steps also work for a
person to run by hand, one command at a time, no agent required.

### 3. The "Deploy to Cloudflare" button (needs a GitHub or GitLab account)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dankelleghan-ops/mailmate-tracker)

**This button needs a GitHub or GitLab account.** Cloudflare's deploy flow works by copying this
repository's code into an account of yours first — that's what lets it rebuild your copy
automatically if this project ever pushes an update — so it asks you to sign in with GitHub or
GitLab before it will provision anything. If you'd rather not create one, use option 1 or 2
instead; they need nothing beyond a Cloudflare account.

If you do use it: sign in, follow the prompts — Cloudflare provisions your own Worker and your
own database and asks you for one thing: a secret. If you don't have one yet, generate one
first:

```
openssl rand -hex 24
```

Paste that in when asked. When it finishes, you'll have an address that looks like
`https://mailmate-tracker.<your-subdomain>.workers.dev`.

Then:

1. **Open that address.** It should say "Your MailMate tracker is running" and "Secret: set ✓".
2. **Paste the address and the secret into MailMate** — Settings → Email Tracking → "Test
   connection".
3. **Using the Gmail extension too?** Paste the same two values into its options page.

That's it — no database to create by hand, no schema to run, no environment variables to hunt
down afterward. The Worker sets up its own tables on its first real request.

#### If the button can't ask for your secret

Occasionally Cloudflare's deploy flow finishes without prompting for `TRACKER_SECRET` (it
depends on how you're deployed). If your new tracker's landing page says **"Secret: NOT SET"**,
open your Worker in the [Cloudflare dashboard](https://dash.cloudflare.com/) → your Worker →
**Settings → Variables and Secrets** → **Add** → name it `TRACKER_SECRET`, type **Secret** (not
Text), paste the value, and save. Reload the landing page to confirm it now says "set ✓".

## Privacy

Everything this tracker records lives in **your own** Cloudflare account, in a database only you
control — not on any shared server, not in this repository, and not visible to Daniel or to
anyone else's tracker. No recipient's IP address is ever stored in readable form; see
`lib/fingerprint.js` and `lib/selfips.js`, which one-way hash them before anything touches the
database.

## What an "open" actually means

Very little on its own, and the code is deliberately conservative about it — see
`lib/classify.js`. Fetches from your own network (`self`), inside 60 seconds of sending
(`scanner`), from Apple's Mail Privacy Protection relay (`privacy-proxy`), and from named
security scanners are all recorded but never counted as a person reading the email. Only
`human` counts, and even that is a fetch of an image, not proof anyone read a word.

**The absence of events is never evidence that a message went unread.** Plenty of mail clients
never load images at all.

## Environment variables

| Var | Required | Meaning |
|---|---|---|
| `TRACKER_SECRET` | yes | Shared secret for `/register` and `/events`. Unset = the whole service refuses to run, which is the safe default. Set with `wrangler secret put TRACKER_SECRET` — never written to a file in this repo. |
| `TRACKER_BASE_URL` | no | Only needed if the pixel should be served from a custom domain. Unset, `/register` builds pixel URLs from whichever origin the request actually arrived on. |
| `TRACKER_FALLBACK_URL` | no | Where a click redirect goes if its destination is unreadable. Defaults to `https://example.com/` — deliberately inert rather than someone else's website. |

## Endpoints

| Route | Purpose |
|---|---|
| `GET /` | Status page. No auth. Confirms the deploy worked and whether a secret is set — never reveals the secret's value. |
| `GET /p/<token>.<tag>.gif` | The pixel. Always 200, always a valid GIF, even when logging fails. |
| `GET /l/<token>.<tag>/<base64url dest>` | Click redirect to the registered destination. |
| `POST /register` | Register a message (or a batch) before it goes out. Auth: `x-tracker-secret` header. |
| `GET /events?since=ISO` | Read messages and events back. Auth: `x-tracker-secret` header. |

## Troubleshooting

**"Secret: NOT SET" on the landing page.** See "If the button can't ask for your secret" above.

**MailMate's "Test connection" fails.** It tells you which of the address or the secret is
wrong. The most common cause is a typo in one of the two, or copying the address with a trailing
slash — either is fine, but make sure both MailMate and the landing page agree on what's set.

**"D1 binding 'DB' references database '00000000-…' which was not found."** You (or your agent)
deployed straight from a clone without creating your own D1 database first, so `wrangler.jsonc`
still has its committed placeholder id. Use the Deploy button above instead, or follow
`CLAUDE.md`'s manual steps — step 2 creates your database and step 3 puts its real id in.

**You lost your secret.** There's no way to look it up — Cloudflare stores it, not this repo.
Generate a new one and run `wrangler secret put TRACKER_SECRET` again; the old one stops working
the moment you do. Update MailMate and the Gmail extension with the new value.

**You want to see what changed recently, or read the code.** Start at `worker.js` — it's the
whole routing table in about a dozen lines — then follow into `handlers/` and `lib/`. Every file
carries a comment explaining the real bug or platform constraint that shaped it.

## The bundled Worker artifact (`dist/`)

`dist/worker.bundle.js` is `worker.js` plus everything under `handlers/` and `lib/`, folded by
esbuild into one self-contained ES module — the source, not a rewrite of it. It exists so
something that isn't running `npm install` and `wrangler deploy` can still deploy this Worker:
Cloudflare's own "upload a script" API takes one file, and MailMate's automatic setup (option 1
above) downloads this one straight from GitHub and uploads it as-is.

Alongside it:

- `dist/worker.bundle.sha256` — the bundle's sha256, so a downloader can confirm it got the exact
  bytes this repository published.
- `dist/version.json` — everything else an automated uploader needs to know: the compatibility
  date and flags to deploy with, the D1 binding to create, and which secret to ask for. It's
  generated from `package.json` and `wrangler.jsonc`, never hand-edited.

Both files are committed on purpose, specifically so they're fetchable at a stable raw GitHub
URL without a build step on the other end. `npm run build` regenerates them after any change to
`worker.js`, `handlers/`, or `lib/`; `npm test` fails if the committed copy has drifted from a
fresh build, so a stale `dist/` can't ship unnoticed.

Nobody following options 2 or 3 above needs to think about this file at all — `wrangler deploy`
and the Deploy button both build from source the normal way. It matters only for option 1 and
for anyone else scripting a direct Cloudflare API upload.

## Tests

```
npm test
```

`npm run build` regenerates `dist/`; `npm test` includes a check that it's still in sync with
`worker.js`/`handlers/`/`lib/` (see above), so run `npm run build` first if you've changed any of
those and want a clean test run.
