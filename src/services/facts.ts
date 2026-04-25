// Random useless facts. Public, no auth, CORS-friendly.
// Each fetch returns one random fact; we call it a few times in parallel
// so the dino has a small batch to choose from per refresh.

import type { ContentItem, ContentSource } from "./content.js";
import { condense, fetchJson } from "./util.js";

const RANDOM = "https://uselessfacts.jsph.pl/api/v2/facts/random?language=en";
const TODAY = "https://uselessfacts.jsph.pl/api/v2/facts/today?language=en";
const RANDOM_BATCH_SIZE = 4;

interface UselessFact {
  id: string;
  text: string;
  source_url?: string;
}

export class FactsSource implements ContentSource {
  readonly name = "useless-facts";
  readonly refreshEveryMs = 25 * 60_000;

  async fetchItems(signal: AbortSignal): Promise<ContentItem[]> {
    const requests: Promise<UselessFact>[] = [
      fetchJson<UselessFact>(TODAY, signal),
      ...Array.from({ length: RANDOM_BATCH_SIZE }, () =>
        fetchJson<UselessFact>(RANDOM, signal)
      ),
    ];
    const settled = await Promise.allSettled(requests);
    const seen = new Set<string>();
    const out: ContentItem[] = [];
    for (const r of settled) {
      if (r.status !== "fulfilled") continue;
      const f = r.value;
      if (!f?.id || !f.text || seen.has(f.id)) continue;
      seen.add(f.id);
      out.push({
        id: `fact:${f.id}`,
        kind: "fact",
        text: condense(f.text, 180),
        href: f.source_url,
        linkLabel: f.source_url ? "source" : undefined,
        publishedAt: Date.now(),
        score: 0.4,
      });
    }
    return out;
  }
}
