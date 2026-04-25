// Wikipedia "On this day" — events from today's date in history.

import { condense, fetchJson } from "./util.mjs";

const ENDPOINT = (mm, dd) =>
  `https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${mm}/${dd}`;
const MAX_EVENTS = 8;

export const History = {
  name: "wiki-on-this-day",
  refreshEveryMs: 6 * 60 * 60_000,
  /** @param {AbortSignal} signal */
  async fetchItems(signal) {
    const now = new Date();
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(now.getUTCDate()).padStart(2, "0");
    const data = await fetchJson(ENDPOINT(mm, dd), signal);
    const events = data.events ?? [];
    const picked = pickSpread(events, MAX_EVENTS);
    const dayKey = `${mm}-${dd}`;
    const out = [];
    for (const e of picked) {
      if (!e?.text || typeof e.year !== "number") continue;
      const page = e.pages?.[0];
      const href = page?.content_urls?.desktop?.page;
      out.push({
        id: `wiki:${dayKey}:${e.year}:${slug(e.text)}`,
        kind: "history",
        text: condense(`${e.year} — ${e.text}`, 180),
        href,
        linkLabel: href ? "wikipedia" : undefined,
        publishedAt: Date.now(),
        score: 0.45,
      });
    }
    return out;
  },
};

function pickSpread(items, n) {
  if (items.length <= n) return items.slice();
  const step = items.length / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(items[Math.floor(i * step)]);
  return out;
}

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}
