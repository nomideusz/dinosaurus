// Hacker News content source. Public, no API key, generous CORS.
// We pull the top story IDs, then hydrate a handful of them.

import type { ContentItem, ContentSource } from "./content.js";
import { condense, fetchJson, logScore } from "./util.js";

const HN_TOP = "https://hacker-news.firebaseio.com/v0/topstories.json";
const HN_ITEM = (id: number) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;

interface HNItem {
  id: number;
  title?: string;
  url?: string;
  score?: number;
  by?: string;
  time?: number; // seconds
  type?: string;
  descendants?: number;
}

const FETCH_COUNT = 12;

export class HackerNewsSource implements ContentSource {
  readonly name = "hacker-news";
  readonly refreshEveryMs = 6 * 60_000; // 6 minutes

  async fetchItems(signal: AbortSignal): Promise<ContentItem[]> {
    const ids = (await fetchJson<number[]>(HN_TOP, signal)).slice(0, FETCH_COUNT);
    const stories = await Promise.allSettled(
      ids.map((id) => fetchJson<HNItem>(HN_ITEM(id), signal))
    );

    const out: ContentItem[] = [];
    for (const r of stories) {
      if (r.status !== "fulfilled") continue;
      const s = r.value;
      if (!s || !s.title || s.type !== "story") continue;

      const text = condenseHnTitle(s.title);
      const href = s.url ?? `https://news.ycombinator.com/item?id=${s.id}`;
      const score = logScore(s.score ?? 0);
      out.push({
        id: `hn:${s.id}`,
        kind: "news",
        text,
        href,
        linkLabel: "read more",
        publishedAt: (s.time ?? 0) * 1000,
        score,
      });
    }
    return out;
  }
}

/** Strip HN-specific prefixes for a more natural reading voice. */
function condenseHnTitle(title: string): string {
  return condense(title.replace(/^(Show|Ask|Tell)\s+HN[:：]?\s*/i, ""));
}
