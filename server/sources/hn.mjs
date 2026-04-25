// Hacker News — public Firebase API, no auth.

import { condense, fetchJson, logScore } from "./util.mjs";

const HN_TOP = "https://hacker-news.firebaseio.com/v0/topstories.json";
const HN_ITEM = (id) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;
const FETCH_COUNT = 12;

export const HackerNews = {
  name: "hacker-news",
  refreshEveryMs: 6 * 60_000,
  /** @param {AbortSignal} signal */
  async fetchItems(signal) {
    const ids = (await fetchJson(HN_TOP, signal)).slice(0, FETCH_COUNT);
    const stories = await Promise.allSettled(ids.map((id) => fetchJson(HN_ITEM(id), signal)));
    const out = [];
    for (const r of stories) {
      if (r.status !== "fulfilled") continue;
      const s = r.value;
      if (!s || !s.title || s.type !== "story") continue;
      const text = condense(String(s.title).replace(/^(Show|Ask|Tell)\s+HN[:：]?\s*/i, ""));
      const href = s.url ?? `https://news.ycombinator.com/item?id=${s.id}`;
      out.push({
        id: `hn:${s.id}`,
        kind: "news",
        text,
        href,
        linkLabel: "read more",
        publishedAt: (s.time ?? 0) * 1000,
        score: logScore(s.score ?? 0),
      });
    }
    return out;
  },
};
