// GENERATED FILE — do not edit by hand. Run `npm run build` after changing worker.js,
// handlers/, or lib/. See scripts/build.mjs for exactly how this is produced.

var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// lib/classify.js
var SCANNER_UA = /barracuda|mimecast|proofpoint|symantec|forcepoint|messagelabs|trendmicro|python-requests|curl\/|wget|Go-http-client|okhttp|HeadlessChrome|bot\b|crawler|spider/i;
var GOOGLE_PROXY_UA = /GoogleImageProxy/i;
var APPLE_PROXY_UA = /AppleMail-ImageProxy/i;
var APPLE_IP = /^17\./;
var SCANNER_WINDOW_SECONDS = 60;
function classify({ sentAt, at, userAgent = "", ip = "", isSelf = false }) {
  if (isSelf) return "self";
  if (APPLE_PROXY_UA.test(userAgent) || APPLE_IP.test(ip)) return "privacy-proxy";
  const gapSeconds = (new Date(at).getTime() - new Date(sentAt).getTime()) / 1e3;
  if (Number.isFinite(gapSeconds) && gapSeconds < SCANNER_WINDOW_SECONDS) return "scanner";
  if (SCANNER_UA.test(userAgent)) return "scanner";
  if (GOOGLE_PROXY_UA.test(userAgent)) return "human";
  if (!userAgent) return "unknown";
  return "human";
}

// lib/selftag.js
import { createHmac } from "node:crypto";
function selfTag(ip, secret = process.env.TRACKER_SECRET || "") {
  if (!ip || !secret) return "x";
  return createHmac("sha256", secret).update(String(ip)).digest("hex").slice(0, 12);
}
function isSelfFetch(tag, ip, secret = process.env.TRACKER_SECRET || "") {
  if (!tag || tag === "x") return false;
  return tag === selfTag(ip, secret);
}

// lib/selfips.js
import { createHmac as createHmac2 } from "node:crypto";

// lib/db.js
async function messagesSince(db, sinceISO) {
  const { results } = await db.prepare(
    `SELECT token, day, recipient, recipients_json, subject, source,
              recipient_count, registered_at
         FROM messages
        WHERE registered_at >= ?1
        ORDER BY registered_at`
  ).bind(sinceISO).all();
  return (results || []).map(rowToMessage);
}
async function eventsSince(db, sinceISO) {
  const { results } = await db.prepare(
    `SELECT id, token, at, kind, classification, fingerprint, device
         FROM events
        WHERE at >= ?1
        ORDER BY at`
  ).bind(sinceISO).all();
  return results || [];
}
async function eventsAfter(db, afterId) {
  const { results } = await db.prepare(
    `SELECT id, token, at, kind, classification, fingerprint, device
         FROM events
        WHERE id > ?1
        ORDER BY id`
  ).bind(afterId).all();
  return results || [];
}
async function storeVersion(db) {
  const row = await db.prepare(`SELECT version FROM store_version WHERE id = 1`).first();
  return Number(row?.version ?? 0);
}
function bumpVersion(db) {
  return db.prepare(
    `INSERT INTO store_version (id, version) VALUES (1, 1)
     ON CONFLICT(id) DO UPDATE SET version = store_version.version + 1`
  );
}
async function upsertMessage(db, m) {
  const write = db.prepare(
    `INSERT INTO messages
         (token, day, recipient, recipients_json, subject, source,
          recipient_count, registered_at, self_tag, links_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT(token) DO UPDATE SET
         recipient       = CASE WHEN excluded.recipient != '' THEN excluded.recipient ELSE messages.recipient END,
         recipients_json = COALESCE(excluded.recipients_json, messages.recipients_json),
         subject         = CASE WHEN excluded.subject   != '' THEN excluded.subject   ELSE messages.subject   END,
         source          = CASE WHEN excluded.source != 'unknown' THEN excluded.source ELSE messages.source END,
         recipient_count = MAX(messages.recipient_count, excluded.recipient_count),
         registered_at   = MIN(messages.registered_at, excluded.registered_at),
         links_json      = CASE WHEN excluded.links_json != '[]' THEN excluded.links_json ELSE messages.links_json END`
  ).bind(
    m.token,
    m.day,
    m.recipient || "",
    m.recipients ? JSON.stringify(m.recipients) : null,
    m.subject || "",
    m.source || "unknown",
    Number(m.recipientCount || 0),
    m.registeredAt,
    m.selfTag || "",
    JSON.stringify(Array.isArray(m.links) ? m.links : [])
  );
  return db.batch([write, bumpVersion(db)]);
}
async function insertEvent(db, e) {
  const insert = db.prepare(
    `INSERT INTO events (token, at, kind, classification, fingerprint, device, destination, device_hint)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
  ).bind(
    e.token,
    e.at,
    e.kind,
    e.classification,
    e.fingerprint || null,
    e.device || null,
    e.destination || null,
    e.deviceHint || null
  );
  return db.batch([insert, bumpVersion(db)]);
}
async function rememberSelfHash(db, hash, at = (/* @__PURE__ */ new Date()).toISOString()) {
  return db.prepare(`INSERT INTO self_ips (hash, first_seen) VALUES (?1, ?2) ON CONFLICT(hash) DO NOTHING`).bind(hash, at).run();
}
async function isKnownSelfHash(db, hash) {
  const row = await db.prepare(`SELECT 1 AS hit FROM self_ips WHERE hash = ?1`).bind(hash).first();
  return Boolean(row);
}
function rowToMessage(r) {
  return {
    token: r.token,
    day: r.day,
    recipient: r.recipient || "",
    subject: r.subject || "",
    source: r.source || "unknown",
    recipientCount: Number(r.recipient_count || 0),
    recipients: parseJSON(r.recipients_json, null),
    sentAt: r.registered_at,
    events: []
  };
}
function parseJSON(s, fallback) {
  if (s == null) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

// lib/selfips.js
var knownSelf = /* @__PURE__ */ new Set();
function ipHash(ip, secret) {
  return createHmac2("sha256", String(secret || "")).update(String(ip || "")).digest("hex").slice(0, 24);
}
async function rememberSelfIp(db, ip, secret) {
  if (!ip) return;
  const h = ipHash(ip, secret);
  if (knownSelf.has(h)) return;
  await rememberSelfHash(db, h);
  knownSelf.add(h);
}
async function isKnownSelfIp(db, ip, secret) {
  if (!ip) return false;
  const h = ipHash(ip, secret);
  if (knownSelf.has(h)) return true;
  try {
    const hit = await isKnownSelfHash(db, h);
    if (hit) knownSelf.add(h);
    return hit;
  } catch {
    return false;
  }
}

// lib/token.js
var ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newToken(now = /* @__PURE__ */ new Date()) {
  const iso = now.toISOString();
  const stamp = iso.slice(0, 19).replace(/[-:]/g, "");
  const bytes = new Uint8Array(12);
  (globalThis.crypto ?? __require("node:crypto").webcrypto).getRandomValues(bytes);
  let rand = "";
  for (const b of bytes) rand += ALPHABET[b % ALPHABET.length];
  return `${stamp}-${rand}`;
}
function dayOf(tok) {
  const m = /^(\d{4})(\d{2})(\d{2})T\d{6}-/.exec(tok || "");
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function sentAtOf(tok) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})-/.exec(tok || "");
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return /* @__PURE__ */ new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
}
function isValidToken(tok) {
  return /^\d{8}T\d{6}-[A-Za-z2-9]{12}$/.test(tok || "");
}

// lib/fingerprint.js
import { createHmac as createHmac3 } from "node:crypto";
var SHARED_BUCKETS = { GMAIL: "gmail-proxy", APPLE: "apple-proxy" };
function deviceFamily(userAgent = "") {
  const ua = String(userAgent);
  const os = /Windows/i.test(ua) ? "windows" : /iPhone|iPad|iOS/i.test(ua) ? "ios" : /Android/i.test(ua) ? "android" : /Mac OS X|Macintosh/i.test(ua) ? "mac" : /Linux/i.test(ua) ? "linux" : "unknown";
  const client = /Edg\//i.test(ua) ? "edge" : /OutlookMobile|Outlook/i.test(ua) ? "outlook" : /Thunderbird/i.test(ua) ? "thunderbird" : /Chrome\//i.test(ua) ? "chrome" : /Firefox\//i.test(ua) ? "firefox" : /Safari\//i.test(ua) ? "safari" : "unknown";
  return `${os}|${client}`;
}
function fingerprint({ ip = "", userAgent = "", secret = process.env.TRACKER_SECRET || "" }) {
  const ua = String(userAgent);
  if (/GoogleImageProxy/i.test(ua)) return SHARED_BUCKETS.GMAIL;
  if (/AppleMail-ImageProxy/i.test(ua) || /^17\./.test(ip)) return SHARED_BUCKETS.APPLE;
  if (!ip && !ua) return "unknown";
  return createHmac3("sha256", secret).update(`${ip}|${deviceFamily(ua)}`).digest("hex").slice(0, 10);
}
function isSharedBucket(fp) {
  return fp === SHARED_BUCKETS.GMAIL || fp === SHARED_BUCKETS.APPLE || fp === "unknown";
}

// lib/http.js
function clientIp(request) {
  const cf = request.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return "";
}
function secretsMatch(a, b) {
  const x = String(a ?? "");
  const y = String(b ?? "");
  if (x.length === 0 || y.length === 0) return false;
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    diff |= x.charCodeAt(i % x.length) ^ y.charCodeAt(i % y.length);
  }
  return diff === 0;
}
function authorized(request, env) {
  const secret = env?.TRACKER_SECRET;
  if (!secret) return false;
  const given = request.headers.get("x-tracker-secret");
  if (!given) return false;
  return secretsMatch(given, secret);
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

// lib/schema.js
var SCHEMA_SQL = `-- The tracker's store, as a database rather than a pile of files.
--
-- What this replaces, and why it is the whole point of the port:
--
-- The Vercel Blob version had no database. It encoded every fact it needed into a FILE PATH,
-- one file per message and one per event, filed in a folder per day. Answering "what has
-- happened in the last thirty days" therefore meant listing sixty-two folders — thirty-one
-- days of messages plus thirty-one of events — and every one of those listings was a billed
-- storage operation. Vercel's free tier allows two thousand a month. A client polling that
-- endpoint spent the entire monthly allowance in about half an hour.
--
-- Here the same question is two indexed queries, no matter how wide the window.

-- One row per tracked message.
--
-- The token is the identity, which makes an AMEND a plain upsert. Amends are real: the Mac
-- watcher stamps a hand-written email the moment the cursor reaches the body, which can be
-- before the subject exists, then re-registers once the subject settles. The Blob version wrote
-- a second file and had the reader prefer whichever record knew more; here the same rule lives
-- in the ON CONFLICT clause in lib/db.js, so there is only ever one row to reason about.
CREATE TABLE IF NOT EXISTS messages (
  token           TEXT PRIMARY KEY,
  day             TEXT NOT NULL,
  recipient       TEXT NOT NULL DEFAULT '',
  -- The FULL audience as JSON, when the client knows it. Attribution refuses to learn a
  -- fingerprint without this — see lib/readers.js for why the \`recipient\` field alone is not
  -- good enough. NULL means "the client did not say".
  recipients_json TEXT,
  subject         TEXT NOT NULL DEFAULT '',
  source          TEXT NOT NULL DEFAULT 'unknown',
  -- Audience SIZE, which is all the learning rule needs. 0 means "not stated", which makes the
  -- message ineligible to teach.
  recipient_count INTEGER NOT NULL DEFAULT 0,
  registered_at   TEXT NOT NULL,
  self_tag        TEXT NOT NULL DEFAULT '',
  links_json      TEXT NOT NULL DEFAULT '[]'
);

-- The index that replaces sixty-two folder listings with one range scan. /events always asks
-- "every message registered at or after <timestamp>", so this is the access path that matters.
CREATE INDEX IF NOT EXISTS messages_registered_at ON messages (registered_at);

-- Every pixel fetch and every link click, including the ones that are not opens.
--
-- Nothing is filtered on the way in. A scanner fetch, Apple's pre-fetch and Daniel's own
-- compose window are all recorded and all carry their classification, because the difference
-- between "recorded" and "counted" is the entire value of this service — see lib/classify.js.
CREATE TABLE IF NOT EXISTS events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  token          TEXT NOT NULL,
  at             TEXT NOT NULL,
  kind           TEXT NOT NULL,           -- 'open' | 'click'
  classification TEXT NOT NULL,           -- 'human' | 'self' | 'scanner' | 'privacy-proxy' | 'unknown'
  -- One-way hash of network + device family. The raw address is never stored, here or anywhere.
  fingerprint    TEXT,
  device         TEXT,                    -- 'os|client', e.g. 'ios|safari'
  destination    TEXT,                    -- clicks only
  device_hint    TEXT
);

-- Events are always fetched for a known set of tokens, ordered by time.
CREATE INDEX IF NOT EXISTS events_token_at ON events (token, at);

-- The index /events actually runs on, and the reason it is a COVERING index.
--
-- /events used to ask for events by joining them to the messages registered in the window.
-- SQLite answered that by reading every row in this table and looking its message up one at a
-- time: 5,481 rows read to return 2,255. Asking for events by TIME instead lets the range scan
-- do the work — but only if every column /events selects is IN the index, because otherwise
-- SQLite reads the index AND then the row it points at, and bills for both. Measured against
-- the live database: 5,481 rows read before, 2,261 after, for a byte-identical answer.
--
-- Keep this column list in step with the SELECT in eventsSince(). Adding a column there
-- without adding it here silently doubles the cost of the busiest query in the service.
CREATE INDEX IF NOT EXISTS events_at_covering
  ON events (at, token, kind, classification, fingerprint, device);

-- Networks that are provably the sender's own.
--
-- Any request to /register carried the tracker secret, so the address it came from is by
-- definition one of his machines. Remembering them means him re-reading his own sent mail days
-- later is recognised as him rather than counted as the recipient opening it. Stored as a
-- one-way hash so the database never holds his addresses in the clear.
CREATE TABLE IF NOT EXISTS self_ips (
  hash       TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL
);

-- One number, bumped on every write, so a reader can ask "has anything changed?" for one row.
--
-- /events is polled far more often than anything is sent or opened — 755 times in the day this
-- was measured, against 298 writes. Without this, every one of those polls recomputed an answer
-- that was usually identical to the last one, and re-read the whole store to do it. With it, a
-- poll reads this single row first and, when the number is unchanged, serves the answer it
-- already has.
--
-- The version is bumped inside lib/db.js's write functions rather than by the callers, so a new
-- write path cannot forget to do it. It must move for AMENDS too, not just inserts: the Mac
-- watcher registers a message before its subject exists and completes it seconds later, and the
-- panel matches messages by subject — a cached answer holding the pre-amend blank would make a
-- just-sent message unfindable.
CREATE TABLE IF NOT EXISTS store_version (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO store_version (id, version) VALUES (1, 0);
`;
function statementsOf(sql) {
  return sql.split("\n").map((line) => {
    const i = line.indexOf("--");
    return i === -1 ? line : line.slice(0, i);
  }).join("\n").split(";").map((s) => s.trim()).filter(Boolean);
}
var readyByDb = /* @__PURE__ */ new WeakMap();
function ensureSchema(db) {
  let ready = readyByDb.get(db);
  if (!ready) {
    ready = initSchema(db);
    readyByDb.set(db, ready);
  }
  return ready;
}
async function initSchema(db) {
  const row = await db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'store_version'`).first().catch(() => null);
  if (row) return;
  const statements = statementsOf(SCHEMA_SQL).map((sql) => db.prepare(sql));
  await db.batch(statements);
}

// handlers/pixel.js
var GIF = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="),
  (c) => c.charCodeAt(0)
);
var HEADERS = {
  "content-type": "image/gif",
  "content-length": String(GIF.length),
  "cache-control": "no-store, no-cache, must-revalidate, max-age=0, private",
  pragma: "no-cache"
};
function pixel(request, env, ctx, raw) {
  ctx.waitUntil(
    log(request, env, raw).catch((err) => console.error("[pixel] logging failed", err))
  );
  return new Response(GIF, { status: 200, headers: HEADERS });
}
async function log(request, env, raw) {
  const trimmed = String(raw || "").replace(/\.gif$/i, "");
  const lastDot = trimmed.lastIndexOf(".");
  const token = lastDot === -1 ? trimmed : trimmed.slice(0, lastDot);
  const tag = lastDot === -1 ? "" : trimmed.slice(lastDot + 1);
  if (!isValidToken(token)) {
    console.warn("[pixel] unrecognised token", token);
    return;
  }
  await ensureSchema(env.DB);
  const secret = env.TRACKER_SECRET || "";
  const at = (/* @__PURE__ */ new Date()).toISOString();
  const ip = clientIp(request);
  const userAgent = request.headers.get("user-agent") || "";
  const isSelf = isSelfFetch(tag, ip, secret) || await isKnownSelfIp(env.DB, ip, secret);
  const classification = classify({
    sentAt: sentAtOf(token).toISOString(),
    at,
    userAgent,
    ip,
    isSelf
  });
  await insertEvent(env.DB, {
    token,
    at,
    kind: "open",
    classification,
    // Who fetched it, as a one-way hash — the raw address is never stored.
    fingerprint: fingerprint({ ip, userAgent, secret }),
    device: deviceFamily(userAgent),
    deviceHint: userAgent.slice(0, 120)
  });
}

// lib/paths.js
function dec(s) {
  if (String(s ?? "") === "~") return "";
  try {
    return Buffer.from(String(s ?? "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return "";
  }
}

// handlers/click.js
function click(request, env, ctx, raw, encodedDest) {
  const trimmed = String(raw || "");
  const lastDot = trimmed.lastIndexOf(".");
  const token = lastDot === -1 ? trimmed : trimmed.slice(0, lastDot);
  const tag = lastDot === -1 ? "" : trimmed.slice(lastDot + 1);
  let destination = env.TRACKER_FALLBACK_URL || "https://example.com/";
  const decoded = dec(String(encodedDest || ""));
  if (/^https?:\/\//i.test(decoded)) destination = decoded;
  ctx.waitUntil(
    logClick(request, env, { token, tag, destination }).catch((err) => console.error("[click] logging failed", err))
  );
  return new Response(null, {
    status: 302,
    headers: { location: destination, "cache-control": "no-store" }
  });
}
async function logClick(request, env, { token, tag, destination }) {
  if (!isValidToken(token)) return;
  await ensureSchema(env.DB);
  const secret = env.TRACKER_SECRET || "";
  const at = (/* @__PURE__ */ new Date()).toISOString();
  const ip = clientIp(request);
  const userAgent = request.headers.get("user-agent") || "";
  const isSelf = isSelfFetch(tag, ip, secret) || await isKnownSelfIp(env.DB, ip, secret);
  const classification = classify({
    sentAt: sentAtOf(token).toISOString(),
    at,
    userAgent,
    ip,
    isSelf
  });
  await insertEvent(env.DB, {
    token,
    at,
    kind: "click",
    classification,
    fingerprint: fingerprint({ ip, userAgent, secret }),
    device: deviceFamily(userAgent),
    destination,
    deviceHint: userAgent.slice(0, 120)
  });
}

// handlers/register.js
function pixelURL(base, token, tag) {
  return `${base}/p/${token}.${tag}.gif`;
}
async function register(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
  let parsed;
  try {
    parsed = await request.json();
  } catch {
    return json({ error: "bad JSON" }, 400);
  }
  const isBatch = Array.isArray(parsed) || Array.isArray(parsed?.messages);
  const items = Array.isArray(parsed) ? parsed : parsed?.messages || [parsed];
  if (!items.length) return json({ error: "nothing to register" }, 400);
  const base = (env.TRACKER_BASE_URL || new URL(request.url).origin).replace(/\/$/, "");
  const secret = env.TRACKER_SECRET || "";
  const ip = clientIp(request);
  const tag = selfTag(ip, secret);
  try {
    await ensureSchema(env.DB);
    await rememberSelfIp(env.DB, ip, secret).catch(() => {
    });
    const out = [];
    for (const item of items) {
      const token = isValidToken(item.token) ? item.token : newToken();
      const audience = Array.isArray(item.recipients) ? new Set(
        item.recipients.flatMap((r) => String(r).split(",").map((x) => x.trim().toLowerCase())).filter(Boolean)
      ) : null;
      await upsertMessage(env.DB, {
        token,
        day: dayOf(token),
        recipient: item.recipient || "",
        recipients: Array.isArray(item.recipients) ? item.recipients : null,
        subject: item.subject || "",
        source: item.source || "unknown",
        recipientCount: audience ? audience.size : 0,
        registeredAt: (/* @__PURE__ */ new Date()).toISOString(),
        selfTag: tag,
        links: Array.isArray(item.links) ? item.links : []
      });
      out.push({ token, tag, pixel: pixelURL(base, token, tag), linkBase: `${base}/l/${token}.${tag}` });
    }
    return json(isBatch ? { registered: out } : out[0]);
  } catch (err) {
    console.error("[register] failed", err);
    return json({ error: "store unavailable" }, 503);
  }
}

// lib/readers.js
function addressesIn(recipient = "") {
  return String(recipient).split(",").map((part) => {
    const t = part.trim();
    const m = /<([^>]+)>/.exec(t);
    return (m ? m[1] : t).trim().toLowerCase();
  }).filter((a) => a.includes("@"));
}
function audienceOf(message) {
  if (Array.isArray(message.recipients) && message.recipients.length) {
    const out = /* @__PURE__ */ new Set();
    for (const r of message.recipients) for (const a of addressesIn(r)) out.add(a);
    return out;
  }
  if (message.recipientCount === 1) {
    const to = addressesIn(message.recipient);
    if (to.length === 1) return new Set(to);
  }
  return null;
}
function selfFingerprints(messages) {
  const fps = /* @__PURE__ */ new Set();
  for (const m of messages) {
    for (const e of m.events || []) {
      if (e.classification === "self" && e.fingerprint && !isSharedBucket(e.fingerprint)) {
        fps.add(e.fingerprint);
      }
    }
  }
  return fps;
}
function ambiguousFingerprints(messages) {
  const seenFor = /* @__PURE__ */ new Map();
  for (const m of messages) {
    if (m.recipientCount !== 1) continue;
    const to = addressesIn(m.recipient);
    if (to.length !== 1) continue;
    for (const e of m.events || []) {
      if (e.kind !== "open" || e.classification !== "human") continue;
      if (!e.fingerprint || isSharedBucket(e.fingerprint)) continue;
      if (!seenFor.has(e.fingerprint)) seenFor.set(e.fingerprint, /* @__PURE__ */ new Set());
      seenFor.get(e.fingerprint).add(to[0]);
    }
  }
  const out = /* @__PURE__ */ new Set();
  for (const [fp, people] of seenFor) if (people.size >= 2) out.add(fp);
  return out;
}
function learnProfiles(messages) {
  const self = selfFingerprints(messages);
  const ambiguous = ambiguousFingerprints(messages);
  const candidates = {};
  for (const m of messages) {
    if (m.recipientCount !== 1) continue;
    const to = addressesIn(m.recipient);
    if (to.length !== 1) continue;
    for (const e of m.events || []) {
      if (e.kind !== "open" || e.classification !== "human") continue;
      if (!e.fingerprint || isSharedBucket(e.fingerprint)) continue;
      if (self.has(e.fingerprint) || ambiguous.has(e.fingerprint)) continue;
      candidates[e.fingerprint] = to[0];
    }
  }
  if (Object.keys(candidates).length === 0) return candidates;
  const opensByFp = /* @__PURE__ */ new Map();
  for (const m of messages) {
    for (const e of m.events || []) {
      if (e.kind !== "open" || e.classification !== "human" || !e.fingerprint) continue;
      if (!(e.fingerprint in candidates)) continue;
      if (!opensByFp.has(e.fingerprint)) opensByFp.set(e.fingerprint, []);
      opensByFp.get(e.fingerprint).push(m);
    }
  }
  const profiles = {};
  for (const [fp, person] of Object.entries(candidates)) {
    const contradicted = (opensByFp.get(fp) || []).some((m) => {
      const audience = audienceOf(m);
      return audience && !audience.has(person);
    });
    if (!contradicted) profiles[fp] = person;
  }
  return profiles;
}
function readersOf(message, profiles) {
  const named = [];
  const unnamed = /* @__PURE__ */ new Set();
  const audience = audienceOf(message);
  for (const e of message.events || []) {
    if (e.kind !== "open" || e.classification !== "human") continue;
    let person = e.fingerprint && !isSharedBucket(e.fingerprint) ? profiles[e.fingerprint] : null;
    if (!audience || !person || !audience.has(person)) person = null;
    if (person) {
      if (!named.includes(person)) named.push(person);
    } else {
      unnamed.add(e.fingerprint || "unknown");
    }
  }
  return { named, unnamed: unnamed.size };
}
function annotate(messages) {
  const self = selfFingerprints(messages);
  for (const m of messages) {
    for (const e of m.events || []) {
      if (e.classification === "human" && e.fingerprint && self.has(e.fingerprint)) {
        e.classification = "self";
      }
    }
  }
  const profiles = learnProfiles(messages);
  for (const m of messages) m.readers = readersOf(m, profiles);
  return messages;
}

// lib/quoted-opens.js
var TOGETHER_MS = 15e3;
function demoteQuotedOpens(messages) {
  const sentAt = /* @__PURE__ */ new Map();
  for (const m of messages) sentAt.set(m.token, Date.parse(m.sentAt) || 0);
  const byReader = /* @__PURE__ */ new Map();
  for (const m of messages) {
    for (const e of m.events || []) {
      if (e.kind !== "open" || e.classification !== "human") continue;
      const reader = e.fingerprint || "unknown";
      if (!byReader.has(reader)) byReader.set(reader, []);
      byReader.get(reader).push({ token: m.token, event: e, at: Date.parse(e.at) || 0 });
    }
  }
  for (const opens of byReader.values()) {
    opens.sort((a, b) => a.at - b.at);
    let cluster = [];
    const settle = () => {
      if (cluster.length > 1) {
        let keep = cluster[0];
        for (const c of cluster) {
          if ((sentAt.get(c.token) || 0) > (sentAt.get(keep.token) || 0)) keep = c;
        }
        for (const c of cluster) {
          if (c !== keep) c.event.classification = "quoted";
        }
      }
      cluster = [];
    };
    for (const open of opens) {
      if (cluster.length && open.at - cluster[cluster.length - 1].at > TOGETHER_MS) settle();
      cluster.push(open);
    }
    settle();
  }
  return messages;
}

// handlers/events.js
var DEFAULT_WINDOW_MS = 30 * 864e5;
var CACHE_WINDOW_MS = 31 * 864e5;
var memo = null;
var eventCache = null;
async function annotatedWindow(db) {
  const version = await storeVersion(db);
  if (memo && memo.version === version) return memo.messages;
  const sinceISO = new Date(Date.now() - CACHE_WINDOW_MS).toISOString();
  const messages = await messagesSince(db, sinceISO);
  attach(messages, await eventsInWindow(db, sinceISO));
  const built = annotate(demoteQuotedOpens(messages));
  memo = { version, messages: built };
  return built;
}
async function eventsInWindow(db, sinceISO) {
  if (!eventCache) {
    const rows = await eventsSince(db, sinceISO);
    eventCache = { rawEvents: rows, maxEventId: maxId(rows) };
    return rows;
  }
  const fresh = (await eventsAfter(db, eventCache.maxEventId)).filter((e) => e.at >= sinceISO);
  const kept = eventCache.rawEvents.filter((e) => e.at >= sinceISO);
  const merged = kept.concat(fresh);
  eventCache = { rawEvents: merged, maxEventId: fresh.length ? maxId(fresh) : eventCache.maxEventId };
  return merged;
}
function maxId(rows) {
  let max = 0;
  for (const r of rows) if (r.id > max) max = r.id;
  return max;
}
function attach(messages, rawEvents) {
  const byToken = new Map(messages.map((m) => [m.token, m]));
  for (const e of rawEvents) {
    byToken.get(e.token)?.events.push({
      at: e.at,
      kind: e.kind,
      classification: e.classification,
      fingerprint: e.fingerprint,
      device: e.device
    });
  }
}
async function build(db, sinceISO) {
  const messages = await messagesSince(db, sinceISO);
  attach(messages, await eventsSince(db, sinceISO));
  return annotate(demoteQuotedOpens(messages));
}
async function events(request, env) {
  if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
  const since = new URL(request.url).searchParams.get("since") || "";
  const sinceDate = since ? new Date(since) : new Date(Date.now() - DEFAULT_WINDOW_MS);
  if (Number.isNaN(sinceDate.getTime())) return json({ error: "bad since" }, 400);
  const sinceISO = sinceDate.toISOString();
  try {
    await ensureSchema(env.DB);
    const older = sinceDate.getTime() < Date.now() - CACHE_WINDOW_MS;
    const all = older ? await build(env.DB, sinceISO) : await annotatedWindow(env.DB);
    const messages = all.filter((m) => m.sentAt >= sinceISO);
    return json({ since: sinceISO, count: messages.length, messages });
  } catch (err) {
    console.error("[events] failed", err);
    return json({ error: "store unavailable" }, 503);
  }
}

// handlers/landing.js
var STYLE = `
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  max-width: 40em; margin: 3em auto; padding: 0 1.5em; color: #1a1a1a; background: #fff;
`;
function landing(request, env) {
  const origin = new URL(request.url).origin;
  const hasSecret = Boolean(env.TRACKER_SECRET);
  const secretLine = hasSecret ? "<p>Secret: <strong>set ✓</strong></p>" : "<p>Secret: <strong>NOT SET</strong> — add <code>TRACKER_SECRET</code> under your Worker's <strong>Settings → Variables and Secrets</strong>, as a Secret (not a plain text Variable). Until then, MailMate and the Gmail extension can be pointed at this address but every request will be refused.</p>";
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
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
  });
}

// worker.js
var worker_default = {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/") return landing(request, env);
    const p = /^\/p\/(.+)$/.exec(pathname);
    if (p) return pixel(request, env, ctx, p[1]);
    const l = /^\/l\/([^/]+)\/(.*)$/.exec(pathname);
    if (l) return click(request, env, ctx, l[1], l[2]);
    if (pathname === "/register") return register(request, env);
    if (pathname === "/events") return events(request, env);
    return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  }
};
export {
  worker_default as default
};
