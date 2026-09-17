// One reader, one email, several pixels.
//
// Replying to a thread quotes the previous message — and if that message was tracked, its
// pixel is quoted along with it. So opening ONE new reply fetches the new pixel AND every
// older pixel buried in the quoted history. Left alone, an old message's open count climbs
// every time a later reply in the thread is read: the "Opened 24×" on a two-day-old message
// was mostly this, not twenty-four readings.
//
// Discovered 2026-08-29 by pulling a stamped draft out of Gmail and finding two pixels in it
// with different tokens, the older one inside the quoted section.
//
// The fix has to live here rather than in the mail clients, because the quoted pixel is inside
// text Mail composes and neither app can edit it. When the same reader fetches several pixels
// within seconds of each other, exactly one email was opened — the NEWEST token. The rest are
// quoted history: still recorded, never counted.

const TOGETHER_MS = 15_000;

/**
 * Demotes opens that were only fetched because they were quoted inside a newer message.
 * Mutates and returns the same message objects.
 */
export function demoteQuotedOpens(messages) {
  // token → sentAt, so "newest" means the most recently SENT message, not the one whose pixel
  // happened to load first.
  const sentAt = new Map();
  for (const m of messages) sentAt.set(m.token, Date.parse(m.sentAt) || 0);

  // Every human open across all messages, grouped by who fetched it.
  const byReader = new Map();
  for (const m of messages) {
    for (const e of m.events || []) {
      if (e.kind !== 'open' || e.classification !== 'human') continue;
      const reader = e.fingerprint || 'unknown';
      if (!byReader.has(reader)) byReader.set(reader, []);
      byReader.get(reader).push({ token: m.token, event: e, at: Date.parse(e.at) || 0 });
    }
  }

  for (const opens of byReader.values()) {
    opens.sort((a, b) => a.at - b.at);
    let cluster = [];
    const settle = () => {
      if (cluster.length > 1) {
        // The newest message wins; everything else in the burst was quoted inside it.
        let keep = cluster[0];
        for (const c of cluster) {
          if ((sentAt.get(c.token) || 0) > (sentAt.get(keep.token) || 0)) keep = c;
        }
        for (const c of cluster) {
          if (c !== keep) c.event.classification = 'quoted';
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
