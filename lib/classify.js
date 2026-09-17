// Classify a single pixel or click fetch.
//
// The whole point of this file: an "open" is NOT the same thing as a person reading the email.
// Apple pre-fetches images on delivery, corporate mail scanners fetch them within seconds, and
// Daniel's own Mail compose window fetches the pixel while he is still writing. All three look
// identical to a real open unless they are named and set aside.
//
// `isSelf` is decided by the caller from a signed tag in the pixel URL rather than by looking
// anything up — see lib/selftag.js.

const SCANNER_UA = /barracuda|mimecast|proofpoint|symantec|forcepoint|messagelabs|trendmicro|python-requests|curl\/|wget|Go-http-client|okhttp|HeadlessChrome|bot\b|crawler|spider/i;
const GOOGLE_PROXY_UA = /GoogleImageProxy/i;
const APPLE_PROXY_UA = /AppleMail-ImageProxy/i;

// Apple owns 17.0.0.0/8 outright; iCloud Private Relay and Mail Privacy Protection egress from
// it. A heuristic, not a guarantee — Apple also uses partner ranges indistinguishable from an
// ordinary client. Under-detecting means an Apple pre-fetch occasionally reads as `human`,
// which is the honest failure direction: better to understate certainty than invent a read.
const APPLE_IP = /^17\./;

const SCANNER_WINDOW_SECONDS = 60;

export function classify({ sentAt, at, userAgent = '', ip = '', isSelf = false }) {
  // 1. Daniel's own machine. Wins over everything — including the 60s rule, because his compose
  //    window fetches the pixel the instant the draft is pasted in.
  if (isSelf) return 'self';

  // 2. Apple's privacy proxy. Real delivery, but it says nothing about a human.
  if (APPLE_PROXY_UA.test(userAgent) || APPLE_IP.test(ip)) return 'privacy-proxy';

  // 3. Anything fetching within a minute of send is machinery, not a reader.
  const gapSeconds = (new Date(at).getTime() - new Date(sentAt).getTime()) / 1000;
  if (Number.isFinite(gapSeconds) && gapSeconds < SCANNER_WINDOW_SECONDS) return 'scanner';

  // 4. Named security scanners and scripted fetchers, at any distance from send.
  if (SCANNER_UA.test(userAgent)) return 'scanner';

  // 5. Gmail proxies images for its users; the fetch is triggered by a real open. (Location is
  //    Google's, not the reader's, so the UI suppresses location for these.)
  if (GOOGLE_PROXY_UA.test(userAgent)) return 'human';

  // 6. No user agent at all is not evidence of a person.
  if (!userAgent) return 'unknown';

  return 'human';
}

/** The only classification the UI is allowed to call an open. */
export function countsAsOpen(classification) {
  return classification === 'human';
}
