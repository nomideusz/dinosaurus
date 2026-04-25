// DEV.to top articles. Public REST API, generous CORS, no auth required.
// Adds a second voice to the "news" bin so HN doesn't dominate it.

import type { ContentItem, ContentSource } from "./content.js";
import { condense, fetchJson, logScore } from "./util.js";

const URL = "https://dev.to/api/articles?per_page=12&top=7";

interface DevToArticle {
  id: number;
  title?: string;
  url?: string;
  positive_reactions_count?: number;
  published_at?: string;
}

export class DevToSource implements ContentSource {
  readonly name = "dev.to";
  readonly refreshEveryMs = 10 * 60_000;

  async fetchItems(signal: AbortSignal): Promise<ContentItem[]> {
    const articles = await fetchJson<DevToArticle[]>(URL, signal);
    const out: ContentItem[] = [];
    for (const a of articles) {
      if (!a.title || !a.url) continue;
      out.push({
        id: `dev:${a.id}`,
        kind: "news",
        text: condense(a.title),
        href: a.url,
        linkLabel: "read post",
        publishedAt: a.published_at ? Date.parse(a.published_at) : Date.now(),
        // DEV.to reactions are typically smaller than HN points, so use a
        // gentler ceiling so popular posts don't get crowded out.
        score: logScore(a.positive_reactions_count ?? 0, 2.6),
      });
    }
    return out;
  }
}
