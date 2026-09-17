// Everything the reader needs lives in the pathname, so listing a day is one request instead of
// hundreds of content fetches. The blob body still holds the full record for debugging.
//
// Encoding is url-safe base64 with no padding, because pathnames must survive URL routing and
// subjects contain anything a human can type.

export function enc(s) {
  // An empty value must still occupy its path segment: '' would put two slashes side by side,
  // which the blob store collapses, shifting every later segment when the path is read back —
  // a recipient-less registration came back with its SOURCE in the subject position.
  if (String(s ?? '') === '') return '~';
  return Buffer.from(String(s ?? ''), 'utf8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function dec(s) {
  if (String(s ?? '') === '~') return '';
  try {
    return Buffer.from(String(s ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch { return ''; }
}

const SUBJECT_LIMIT = 120;   // keeps pathnames well inside Vercel Blob's 1024-char ceiling

export function messagePath({ day, token, recipient, subject, source, recipientCount = 0 }) {
  // The audience SIZE rides in the pathname because the learning rule needs exactly that and
  // nothing more, and pathnames are what a day listing returns for free. 0 means "the client
  // did not say", which makes the message ineligible to teach.
  return `msg/${day}/${token}/${enc(recipient)}/${enc(String(subject).slice(0, SUBJECT_LIMIT))}/${enc(source)}/${recipientCount}.json`;
}

export function parseMessagePath(pathname) {
  // The count segment is optional so messages registered before it existed still parse.
  const m = /^msg\/([\d-]{10})\/([^/]+)\/([^/]*)\/([^/]*)\/([^/]*?)(?:\/(\d+))?\.json$/.exec(pathname);
  if (!m) return null;
  return { day: m[1], token: m[2], recipient: dec(m[3]), subject: dec(m[4]), source: dec(m[5]),
           recipientCount: m[6] ? Number(m[6]) : 0 };
}

export function eventPath({ day, token, at, kind, classification, fingerprint = 'na', device = '', nonce }) {
  const stamp = at.replace(/[-:.]/g, '');
  // The fingerprint — and now the device family — ride in the pathname like everything else
  // the reader needs, so listing a day still costs zero content fetches. The device is what
  // lets the panel say "iPhone · 12:10 PM" instead of a bare count.
  const dev = device ? `${device}__` : '';
  return `ev/${day}/${token}/${stamp}__${kind}__${classification}__${fingerprint}__${dev}${nonce}.json`;
}

export function parseEventPath(pathname) {
  // The fingerprint segment is optional: events written before per-reader tracking existed have
  // no such segment, and dropping them would silently erase a day of history.
  // Three vintages parse: no fingerprint (day one), fingerprint only, fingerprint + device.
  // Each optional group requires its own trailing __, which is what keeps them unambiguous.
  const m = /^ev\/([\d-]{10})\/([^/]+)\/(\d{8}T\d{6})(\d*)Z?__([a-z]+)__([a-z-]+)__(?:([a-z0-9-]+)__)?(?:([a-z]+~[a-z]+)__)?[^/]+\.json$/.exec(pathname);
  if (!m) return null;
  const s = m[3];
  const at = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;
  return { day: m[1], token: m[2], at, kind: m[5], classification: m[6],
           fingerprint: m[7] || null, device: m[8] ? m[8].replace('~', '|') : null };
}
