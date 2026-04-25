// Random useless facts — uselessfacts.jsph.pl. Each call returns one fact;
// we do a small batch in parallel so the dino has variety per refresh.

import { condense, fetchJson } from "./util.mjs";

const RANDOM = "https://uselessfacts.jsph.pl/api/v2/facts/random?language=en";
const TODAY = "https://uselessfacts.jsph.pl/api/v2/facts/today?language=en";
const RANDOM_BATCH_SIZE = 4;

export const Facts = {
  name: "useless-facts",
  refreshEveryMs: 25 * 60_000,
  /** @param {AbortSignal} signal */
  async fetchItems(signal) {
    const settled = await Promise.allSettled([
      fetchJson(TODAY, signal),
      ...Array.from({ length: RANDOM_BATCH_SIZE }, () => fetchJson(RANDOM, signal)),
    ]);
    const seen = new Set();
    const out = [];
    for (const r of settled) {
      if (r.status !== "fulfilled") continue;
      const f = r.value;
      if (!f?.id || !f.text || seen.has(f.id)) continue;
      seen.add(f.id);
      out.push({
        id: `fact:${f.id}`,
        kind: "fact",
        text: condense(f.text, 180),
        href: typeof f.source_url === "string" ? f.source_url : undefined,
        linkLabel: typeof f.source_url === "string" ? "source" : undefined,
        publishedAt: Date.now(),
        score: 0.4,
      });
    }
    return out;
  },
};
