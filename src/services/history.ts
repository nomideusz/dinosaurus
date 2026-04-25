// Wikipedia "On this day" — historical events keyed to today's date.
// Uses the public REST API (CORS-friendly, no auth). The endpoint takes a
// fixed (month, day), so we re-fetch around midnight to pick up the new day.

import type { ContentItem, ContentSource } from "./content.js";
import { condense, fetchJson } from "./util.js";

const ENDPOINT = (mm: string, dd: string) =>
  `https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${mm}/${dd}`;
const MAX_EVENTS = 8;

interface OnThisDayResponse {
  events?: OnThisDayEvent[];
}

interface OnThisDayEvent {
  text: string;
  year: number;
  pages?: Array<{
    titles?: { canonical?: string };
    content_urls?: { desktop?: { page?: string } };
  }>;
}

export class HistorySource implements ContentSource {
  readonly name = "wiki-on-this-day";
  // Refresh every ~6h. The day rolls over at midnight UTC server-side; this
  // cadence gets us within a few hours of the day boundary without spamming.
  readonly refreshEveryMs = 6 * 60 * 60_000;

  async fetchItems(signal: AbortSignal): Promise<ContentItem[]> {
    const now = new Date();
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(now.getUTCDate()).padStart(2, "0");
    const data = await fetchJson<OnThisDayResponse>(ENDPOINT(mm, dd), signal);
    const events = data.events ?? [];
    // Pick a varied slice — the API returns events sorted newest first; take
    // a few from across the list so we don't always get only modern events.
    const picked = pickSpread(events, MAX_EVENTS);
    const dayKey = `${mm}-${dd}`;
    const out: ContentItem[] = [];
    for (const e of picked) {
      if (!e.text || typeof e.year !== "number") continue;
      const page = e.pages?.[0];
      const href = page?.content_urls?.desktop?.page;
      out.push({
        id: `wiki:${dayKey}:${e.year}:${slug(e.text)}`,
        kind: "history",
        text: condense(`${e.year} — ${e.text}`, 180),
        href,
        linkLabel: href ? "wikipedia" : undefined,
        publishedAt: Date.now(),
        // Older / unique events feel a bit more striking; keep it middling.
        score: 0.45,
      });
    }
    return out;
  }
}

function pickSpread<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items.slice();
  const step = items.length / n;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.floor(i * step)]);
  return out;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}
