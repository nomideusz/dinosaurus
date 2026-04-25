// The narrator pulls items from every registered ContentSource on a schedule,
// keeps a deduped pool, ranks them, and emits "say this next" events to the
// outside world. It also remembers what's been said so the dino doesn't loop.
//
// Adding a new source is one line in main.ts — see registerSource().

import type { ContentItem, ContentSource } from "./services/content.js";

interface SourceState {
  source: ContentSource;
  lastFetchedAt: number;
  inFlight: AbortController | null;
}

export interface NarratorOptions {
  /**
   * Called whenever the narrator wants to surface a new item. Return `false`
   * to tell the narrator the item could not be used (e.g. it's already in
   * the shared archive); the narrator will un-mark it and try again sooner.
   */
  onItem: (item: ContentItem) => boolean | void;
  /** Called whenever the *known* item list changes (used to populate the feed). */
  onPool?: (items: ContentItem[]) => void;
  /** Optional status hook (e.g. "fetching weather"). */
  onStatus?: (msg: string) => void;
  /** ms between bubble suggestions. */
  cadenceMs?: number;
}

export class Narrator {
  private sources: SourceState[] = [];
  private pool = new Map<string, ContentItem>();
  private spokenIds = new Set<string>();
  private lastSpokenKindAt: Partial<Record<string, number>> = {};
  private nextSayAt = 0;
  private destroyed = false;

  constructor(private opts: NarratorOptions) {}

  registerSource(source: ContentSource): void {
    this.sources.push({ source, lastFetchedAt: 0, inFlight: null });
  }

  start(): void {
    this.tick();
    // Independent fast loop — narrator decides if it's time to speak.
    const loop = () => {
      if (this.destroyed) return;
      this.maybeSpeak();
      window.setTimeout(loop, 1500);
    };
    loop();
  }

  destroy(): void {
    this.destroyed = true;
    for (const s of this.sources) s.inFlight?.abort();
  }

  /** Force a refresh of all due sources. */
  private tick(): void {
    if (this.destroyed) return;
    const now = Date.now();
    for (const s of this.sources) {
      if (s.inFlight) continue;
      if (now - s.lastFetchedAt < s.source.refreshEveryMs) continue;
      void this.refresh(s);
    }
    window.setTimeout(() => this.tick(), 60_000);
  }

  private async refresh(s: SourceState): Promise<void> {
    const ctrl = new AbortController();
    s.inFlight = ctrl;
    this.opts.onStatus?.(`fetching ${s.source.name}`);
    try {
      const items = await s.source.fetchItems(ctrl.signal);
      s.lastFetchedAt = Date.now();
      let changed = false;
      for (const it of items) {
        const prev = this.pool.get(it.id);
        if (!prev || prev.score !== it.score) {
          this.pool.set(it.id, it);
          changed = true;
        }
      }
      if (changed) this.opts.onPool?.(this.poolSnapshot());
      this.opts.onStatus?.(`fresh ${s.source.name}`);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        console.warn(`[narrator] ${s.source.name} failed:`, err);
        this.opts.onStatus?.(`${s.source.name} offline`);
      }
    } finally {
      s.inFlight = null;
    }
  }

  private poolSnapshot(): ContentItem[] {
    return [...this.pool.values()].sort((a, b) => {
      // newest + juiciest first
      return b.score * 10 + b.publishedAt / 1e12 - (a.score * 10 + a.publishedAt / 1e12);
    });
  }

  private maybeSpeak(): void {
    const now = performance.now();
    if (now < this.nextSayAt) return;

    const item = this.pickNext();
    if (!item) return;

    this.spokenIds.add(item.id);
    this.lastSpokenKindAt[item.kind] = Date.now();
    const accepted = this.opts.onItem(item) !== false;

    if (!accepted) {
      // The receiver rejected the item (e.g. already in the shared archive).
      // Keep it marked spoken for a short while so we don't immediately pick
      // it again, but try the *next* candidate sooner than a full cadence.
      this.nextSayAt = now + 1_500;
      return;
    }

    // Random cadence between bubbles, plus a base.
    const base = this.opts.cadenceMs ?? 14_000;
    this.nextSayAt = now + base + Math.random() * 8_000;
  }

  /**
   * Score-weighted, dedup-aware, kind-diversity pick.
   * Aims to feel "smart" without an LLM — rotate kinds, prefer high score,
   * gently decay items that have been around for a while.
   */
  private pickNext(): ContentItem | null {
    const candidates = [...this.pool.values()].filter((i) => !this.spokenIds.has(i.id));
    if (candidates.length === 0) {
      // Allow re-saying items if nothing new (but with a long cooldown).
      this.spokenIds.clear();
      const all = [...this.pool.values()];
      if (all.length === 0) return null;
      return all[Math.floor(Math.random() * all.length)];
    }

    const now = Date.now();
    let best: ContentItem | null = null;
    let bestScore = -Infinity;
    for (const item of candidates) {
      let s = item.score;

      // Recency bonus (items < 1h old get a small boost)
      const hoursOld = Math.max(0, (now - item.publishedAt) / 3_600_000);
      s += Math.max(0, 0.15 - hoursOld * 0.02);

      // Kind diversity penalty: if we just said something of this kind, dampen.
      const lastSameKind = this.lastSpokenKindAt[item.kind];
      if (lastSameKind && now - lastSameKind < 60_000) s -= 0.25;

      // Tiny tie-breaking jitter so order isn't rigid.
      s += Math.random() * 0.04;

      if (s > bestScore) {
        bestScore = s;
        best = item;
      }
    }
    return best;
  }
}
