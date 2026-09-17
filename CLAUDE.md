# MailMate tracker — deploying this for someone

This file is written for an AI coding agent (Claude Code on someone's own Mac, or a claude.ai
chat with file/shell access) deploying this on a person's behalf, at their request. If you are
that agent, follow these steps in order. If you are a person reading this yourself, the README
has the same steps in plainer language — either works.

**The rule that matters most: everyone runs their OWN copy of this tracker.** It sees who a
person emails and when they read it, and the secret you are about to create is a master key —
anyone holding it can read every message ever recorded. Never point two people's MailMate (or
Gmail extension) at the same deployed worker, and never hand your secret to anyone else.

**This is one of three ways to set this up** — see the README's "Set this up" section for all
three, in the order a person should try them: (1) MailMate's own automatic setup (coming in
1.37.0 — a free Cloudflare account and one API token, no terminal), (2) this file, followed by
you or by a person directly, and (3) the "Deploy to Cloudflare" button, which needs a GitHub or
GitLab account because Cloudflare copies this repository's code into one before it can build and
redeploy it. Following this file needs neither GitHub nor GitLab — just a Cloudflare account and
a terminal.

## What you're deploying

A Cloudflare Worker plus a Cloudflare D1 (SQLite) database. Both are free at ordinary email
volumes, on Cloudflare's own free tier, in the person's own Cloudflare account. Nothing here
talks to Daniel Kelleghan's infrastructure or reads his data — this is a template.

## Prerequisites

- Node.js 20 or later (`node --version`). If it's missing or older, install it before continuing
  — this whole flow assumes `node` and `npm` work.
- A Cloudflare account. Free — if the person doesn't have one, they create it at
  [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) before you go further, since
  the next step needs one to log into.
- This repository, cloned or downloaded, with you running commands from its root (where this
  file and `package.json` live).

You do not need to install `wrangler` globally — `npx wrangler` downloads and runs the right
version automatically, and every command below uses it that way. If `npm install` hasn't been
run yet in this folder, run it first: `npm install`.

## Steps

### 1. Log in to Cloudflare

```
npx wrangler login
```

This opens a browser window. **The person approves it there, in their own Cloudflare account —
you cannot do this step for them and should not ask for their Cloudflare password.** Wait for
the terminal to report a successful login before continuing.

### 2. Create their D1 database

```
npx wrangler d1 create mailmate-tracker
```

This prints a block that includes a `database_id` — a UUID like
`a1b2c3d4-5678-90ab-cdef-1234567890ab`. Copy it.

### 3. Put the database id in the config

Open `wrangler.jsonc` and find the `d1_databases` block. Replace the placeholder
`00000000-0000-0000-0000-000000000000` with the real `database_id` from step 2. Nothing else in
that file needs to change — leave `database_name`, `binding`, and everything above it exactly as
it is.

Do not create a NEW config file for this and do not touch `wrangler.daniel.jsonc` if you happen
to see it — that one file is a different person's real deployment and is not part of this setup.

### 4. Deploy the Worker

```
npx wrangler deploy
```

Wrangler prints the deployed address at the end, something like
`https://mailmate-tracker.<their-subdomain>.workers.dev`. That is the address this person pastes
into MailMate. Keep it — you'll need it again in step 6.

You do **not** need to run any database migration or schema command. The Worker creates its own
tables on its first real request — see "What NOT to do" below for why nothing should be run by
hand here.

### 5. Set the secret

First, generate one. If the person doesn't already have a tracker secret from a previous setup,
make one:

```
openssl rand -hex 24
```

That prints a 48-character random string — long enough, and openssl is on every Mac and most
Linux systems with no install step. Then set it on the deployed Worker:

```
npx wrangler secret put TRACKER_SECRET
```

Wrangler will prompt for the value interactively — paste the string `openssl` printed. This
stores it on Cloudflare only; it is never written to any file in this repository and never
committed.

### 6. Verify it worked

Open the address from step 4 in a browser, or:

```
curl https://mailmate-tracker.<their-subdomain>.workers.dev/
```

It should say **"Secret: set ✓"**. If it says **"Secret: NOT SET"**, step 5 didn't take — run
`npx wrangler secret put TRACKER_SECRET` again and re-check.

### 7. Tell the person what to paste where

Give them, in plain text (never as a screenshot of a terminal that might catch other output):

- **The address** from step 4 — e.g. `https://mailmate-tracker.<their-subdomain>.workers.dev`
- **The secret** from step 5 — the exact string, once. If they lose it, generate a new one and
  run step 5 again with the new value; the old one stops working immediately.

They paste both into:

- **MailMate → Settings → Email Tracking** (address + secret, then "Test connection")
- **The Gmail tracker extension's options page**, if they use Gmail too (same two values)

"Test connection" — or a re-fetch of the address from step 6 — is the confirmation that both
values were entered correctly.

## Using an API token instead of browser login

Step 1 above (`npx wrangler login`) is a browser-based OAuth flow, and it's the right choice for
a person following this file interactively. Some situations call for an API token instead — a
headless environment with no browser to approve in, or a script (this is what MailMate's own
automatic setup, coming in 1.37.0, will use — it talks to the Cloudflare API directly rather than
shelling out to `wrangler`). If that's you, create the token first and set it as
`CLOUDFLARE_API_TOKEN` in the environment before any `wrangler` command; wrangler and the
Cloudflare API both accept it in place of an interactive login, with no other change to the
steps above.

Create it at **[dash.cloudflare.com](https://dash.cloudflare.com/) → My Profile → API Tokens →
Create Token → Create Custom Token**. Researched against Cloudflare's own docs
(`developers.cloudflare.com/fundamentals/api/reference/permissions/` and
`.../reference/template/`) because the closest built-in template, **"Edit Cloudflare Workers,"
does NOT include D1** — a token made from it will log into wrangler fine and then fail the
moment anything touches the database. Use a custom token with exactly these permissions instead:

| Scope | Permission | Why |
|---|---|---|
| Account | **Workers Scripts** — Edit | Upload/update the Worker script itself, and enable the workers.dev subdomain — both are Workers Scripts sub-resources, so this one permission covers both; there is no separate "subdomain" permission group. |
| Account | **D1** — Edit | Create the database (step 2) and let the Worker read/write it. |
| Account | **Account Settings** — Read | Read the account ID, which every other call above needs to address the account at all. |

Set **Account Resources** to the one Cloudflare account this token is for — never "All accounts."
No Zone or User permissions are needed for a workers.dev-only deployment (skip Workers Routes —
that's for attaching a Worker to a custom domain's zone, not for workers.dev). Give the token an
expiration if the dashboard offers one; it only needs to exist for the length of this setup.

Cloudflare's dashboard is the source of truth for exact permission names and may present them
slightly differently by the time you read this — if a listed permission isn't there under that
exact wording, look for the nearest equivalent (Workers Scripts / D1 / Account Settings, each at
the Edit or Read level as shown) rather than guessing at a broader one "to be safe." Broader
tokens are a bigger liability if one ever leaks, not a convenience.

## What NOT to do

- **Never commit a secret, an API token, or a real `database_id` belonging to a specific
  person's private tracker into this repository or into `wrangler.jsonc`.** The committed
  `wrangler.jsonc` must always carry the placeholder database id, not a real one — that's what
  keeps this repo safe to hand to the next person.
- **Never edit `schema.sql` by hand on a running deployment**, and never run `wrangler d1
  execute --file=./schema.sql` as a "just in case" step — it isn't needed (the Worker
  self-initializes, see step 4) and D1 has no protection against a bad hand-run migration
  clobbering live data. If `schema.sql` genuinely needs to change, that's a code change to this
  repository, not a per-deployment operational step.
- **Never point two different people's MailMate or Gmail extension at the same Worker address.**
  One tracker per person, always — see the rule at the top of this file.
- **Never reveal what `TRACKER_SECRET` actually is** in a status page, a log line, or an error
  message. The landing page at `/` only ever says whether one is set, never its value — keep it
  that way if you touch that code.
- **Never guess or invent a `database_id`.** If step 2 fails or the person already has a
  database from a previous attempt, run `npx wrangler d1 list` to find its real id rather than
  making one up — a wrong id fails loudly (see the comment in `wrangler.jsonc`), which is the
  point, but there's no reason to trigger it on purpose.
