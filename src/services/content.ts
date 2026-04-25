// A pluggable content-source abstraction. Anything dino can talk about goes
// behind this interface — news, weather, jokes, fortune cookies, whatever.
// The narrator picks one item at a time based on score + recency.

export type ContentKind = "news" | "weather" | "fact" | "thought";

export interface ContentItem {
  /** Stable ID — used to avoid repeating the same item. */
  id: string;
  kind: ContentKind;
  /** Short, dino-mouth-friendly text. Keep ≤ 160 chars. */
  text: string;
  /** Optional follow-up link. */
  href?: string;
  linkLabel?: string;
  /** When the source thinks the item became known (epoch ms). */
  publishedAt: number;
  /** 0..1 — higher = juicier. Used by the ranker. */
  score: number;
}

export interface ContentSource {
  readonly name: string;
  /** How often (ms) the orchestrator should ask this source to refresh. */
  readonly refreshEveryMs: number;
  /** Returns a snapshot of items the source currently knows about. */
  fetchItems(signal: AbortSignal): Promise<ContentItem[]>;
}
