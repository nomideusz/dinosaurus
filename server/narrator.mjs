// Authoritative content narrator. Polls every registered source on its own
// schedule, keeps a deduped pool, ranks items, and emits one at a time so
// connected clients all see the same world events at roughly the same time.
// One server poll replaces what used to be N clients each polling.
//
// The picker mirrors the client narrator's logic: prefer high score and
// recency, dampen the kind of the previous item to keep variety, and add a
// tiny jitter so order doesn't feel rigid.

const DEFAULT_CADENCE_MS = 9_000;
const CADENCE_JITTER_MS = 8_000;
const SOURCE_TICK_MS = 60_000;

export class Narrator {
  /**
   * @param {{
   *   onItem: (item: { id: string; kind: string; text: string; href?: string; linkLabel?: string; publishedAt: number; score: number }) => void;
   *   isAlreadyKnown?: (id: string) => boolean;
   *   cadenceMs?: number;
   *   logger?: { info?: (msg: string) => void; warn?: (msg: string, err?: unknown) => void };
   * }} opts
   */
  constructor(opts) {
    this.opts = opts;
    /** @type {Array<{ source: any; lastFetchedAt: number; inFlight: AbortController | null }>} */
    this.sources = [];
    /** @type {Map<string, any>} */
    this.pool = new Map();
    /** @type {Set<string>} */
    this.spokenIds = new Set();
    /** @type {Record<string, number>} */
    this.lastSpokenKindAt = {};
    this.nextSayAt = 0;
    this.destroyed = false;
    this.tickHandle = null;
    this.loopHandle = null;
  }

  registerSource(source) {
    this.sources.push({ source, lastFetchedAt: 0, inFlight: null });
  }

  start() {
    this.tick();
    const loop = () => {
      if (this.destroyed) return;
      this.maybeSpeak();
      this.loopHandle = setTimeout(loop, 1500);
      this.loopHandle.unref?.();
    };
    loop();
  }

  destroy() {
    this.destroyed = true;
    for (const s of this.sources) s.inFlight?.abort();
    if (this.tickHandle) clearTimeout(this.tickHandle);
    if (this.loopHandle) clearTimeout(this.loopHandle);
  }

  tick() {
    if (this.destroyed) return;
    const now = Date.now();
    for (const s of this.sources) {
      if (s.inFlight) continue;
      if (now - s.lastFetchedAt < s.source.refreshEveryMs) continue;
      void this.refresh(s);
    }
    this.tickHandle = setTimeout(() => this.tick(), SOURCE_TICK_MS);
    this.tickHandle.unref?.();
  }

  async refresh(state) {
    const ctrl = new AbortController();
    state.inFlight = ctrl;
    try {
      const items = await state.source.fetchItems(ctrl.signal);
      state.lastFetchedAt = Date.now();
      for (const it of items) {
        if (!it?.id || !it.kind || !it.text) continue;
        const prev = this.pool.get(it.id);
        if (!prev || prev.score !== it.score) {
          this.pool.set(it.id, it);
        }
      }
      this.opts.logger?.info?.(`[narrator] refreshed ${state.source.name} (+${items.length})`);
    } catch (err) {
      if (err && err.name !== "AbortError") {
        this.opts.logger?.warn?.(`[narrator] ${state.source.name} failed`, err);
      }
    } finally {
      state.inFlight = null;
    }
  }

  maybeSpeak() {
    const now = Date.now();
    if (now < this.nextSayAt) return;
    const item = this.pickNext();
    if (!item) return;
    this.spokenIds.add(item.id);
    this.lastSpokenKindAt[item.kind] = now;
    this.opts.onItem(item);
    const base = this.opts.cadenceMs ?? DEFAULT_CADENCE_MS;
    this.nextSayAt = now + base + Math.random() * CADENCE_JITTER_MS;
  }

  pickNext() {
    const known = this.opts.isAlreadyKnown ?? (() => false);
    let candidates = [];
    for (const item of this.pool.values()) {
      if (this.spokenIds.has(item.id)) continue;
      if (known(item.id)) continue;
      candidates.push(item);
    }
    if (candidates.length === 0) {
      // Pool exhausted — let already-spoken items return after a long quiet
      // moment, but still skip anything currently in the archive.
      this.spokenIds.clear();
      const all = [...this.pool.values()].filter((i) => !known(i.id));
      if (all.length === 0) return null;
      return all[Math.floor(Math.random() * all.length)];
    }
    const now = Date.now();
    let best = null;
    let bestScore = -Infinity;
    for (const item of candidates) {
      let s = item.score;
      const hoursOld = Math.max(0, (now - item.publishedAt) / 3_600_000);
      s += Math.max(0, 0.15 - hoursOld * 0.02);
      const lastSameKind = this.lastSpokenKindAt[item.kind];
      if (lastSameKind && now - lastSameKind < 60_000) s -= 0.25;
      s += Math.random() * 0.04;
      if (s > bestScore) {
        bestScore = s;
        best = item;
      }
    }
    return best;
  }
}
