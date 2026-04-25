// DEV.to top articles — second voice for the news bin.

import { condense, fetchJson, logScore } from "./util.mjs";

const URL = "https://dev.to/api/articles?per_page=12&top=7";

export const DevTo = {
  name: "dev.to",
  refreshEveryMs: 10 * 60_000,
  /** @param {AbortSignal} signal */
  async fetchItems(signal) {
    const articles = await fetchJson(URL, signal);
    const out = [];
    for (const a of articles) {
      if (!a?.title || !a.url) continue;
      out.push({
        id: `dev:${a.id}`,
        kind: "news",
        text: condense(a.title),
        href: a.url,
        linkLabel: "read post",
        publishedAt: a.published_at ? Date.parse(a.published_at) : Date.now(),
        score: logScore(a.positive_reactions_count ?? 0, 2.6),
      });
    }
    return out;
  },
};
