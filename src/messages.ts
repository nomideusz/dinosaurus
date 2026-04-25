// The "message world" — the new way the dino interacts with content.
//
// Instead of speech bubbles glued to the dino, each piece of content arrives
// as a floating card that slides in from the left, right, or top. Cards bob
// gently in place until the dino walks over to pick one up. Once carried,
// the card sticks to the dino's head; he then walks down to the matching
// category bin at the bottom of the page and drops it in.
//
// This module is purely a scene & DOM manager. It exposes a small API so a
// coordinator (in main.ts) can ask "what's available?", "claim this one",
// "I'm carrying it here now", and "deliver it to bin K".

import type { ContentItem, ContentKind } from "./services/content.js";

export type MessageState =
  | "entering"   // sliding in from an edge toward its float home
  | "floating"   // bobbing in place, available to claim
  | "claimed"    // a worker (the dino) has reserved it; still in the air
  | "carried"    // attached to the carrier (positioned externally)
  | "delivering" // animating into a bin
  | "gone";      // visually finished, awaiting GC

export interface BinDef {
  kind: ContentKind;
  label: string;
  /** A short symbolic glyph used as the bin's icon (single line, monospace). */
  icon: string;
}

export interface DeliveredItem {
  readonly id: string;
  readonly kind: ContentKind;
  readonly text: string;
  readonly href?: string;
  readonly linkLabel?: string;
  /** When the dino dropped it in (epoch ms). */
  readonly deliveredAt: number;
}

export interface CategoryBin extends BinDef {
  el: HTMLDivElement;
  countEl: HTMLSpanElement;
  /** Centre x of the bin, in CSS px. */
  centerX: number;
  /** y of the *top* of the bin element (where cards drop into), in CSS px. */
  topY: number;
  /** y of the bottom of the bin (page edge), in CSS px. */
  bottomY: number;
  count: number;
  /** Items the dino has delivered here, newest first. */
  delivered: DeliveredItem[];
}

export interface FloatingMessage {
  readonly id: string;
  readonly kind: ContentKind;
  readonly text: string;
  readonly href?: string;
  readonly linkLabel?: string;
  /** Current centre position, in CSS px. */
  x: number;
  y: number;
  /** Where the card wants to be when "floating". */
  homeX: number;
  homeY: number;
  state: MessageState;
  /** Random phase so different cards bob at different rhythms. */
  bobPhase: number;
  /** Spawn timestamp (perf.now ms) — used for ease-in & age. */
  spawnedAt: number;
  /** When the deliver animation finishes. */
  deliverDoneAt: number;
  /** Cached element reference. */
  readonly el: HTMLDivElement;
}

export interface MessageWorldOptions {
  /** Maximum number of cards visible at once. New ones beyond this are dropped. */
  maxConcurrent?: number;
  /** Bottom padding (px) reserved for the bins row. */
  binsAreaHeight?: number;
  /**
   * Called whenever spawn() actually creates a new floating card. Used by
   * main.ts to trigger the dino's "surprised" double-take. Not called for
   * dedup rejections, capacity rejections, or unknown kinds.
   */
  onSpawn?: (item: ContentItem) => void;
}

/**
 * Owns the DOM layer for floating messages and the row of bins beneath them.
 */
/**
 * Items delivered to a bin live in the shared archive for this long. The
 * server enforces the same window; we keep this constant client-side so we
 * can prune defensively if the network is unavailable.
 */
const ARCHIVE_TTL_MS = 2 * 60 * 60 * 1000;
/** How often the client polls the server for items others have sorted. */
const ARCHIVE_REFRESH_INTERVAL_MS = 60_000;
const ARCHIVE_API_URL =
  (import.meta.env.VITE_ARCHIVE_URL ?? "https://dinosaurus-archive-production.up.railway.app").replace(/\/$/, "");

export class MessageWorld {
  private readonly stage: HTMLElement;
  private readonly cardLayer: HTMLDivElement;
  private readonly binLayer: HTMLDivElement;
  private readonly bins: CategoryBin[] = [];
  private readonly messages = new Map<string, FloatingMessage>();
  private worldW: number;
  private worldH: number;
  private readonly maxConcurrent: number;
  private readonly binsAreaHeight: number;
  private archiveOverlay: ArchiveOverlay | null = null;
  private nextRefreshAt = 0;
  private readonly onSpawn?: (item: ContentItem) => void;

  constructor(
    parent: HTMLElement,
    binDefs: BinDef[],
    worldW: number,
    worldH: number,
    opts: MessageWorldOptions = {}
  ) {
    this.stage = parent;
    this.onSpawn = opts.onSpawn;
    this.worldW = worldW;
    this.worldH = worldH;
    this.maxConcurrent = opts.maxConcurrent ?? 6;
    this.binsAreaHeight = opts.binsAreaHeight ?? 88;

    injectStylesOnce();

    this.cardLayer = document.createElement("div");
    this.cardLayer.className = "msg-layer";
    parent.appendChild(this.cardLayer);

    this.binLayer = document.createElement("div");
    this.binLayer.className = "bin-row";
    parent.appendChild(this.binLayer);

    for (const def of binDefs) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = `bin bin--${def.kind}`;
      el.setAttribute(
        "aria-label",
        `Open ${def.label} archive — items the dino has sorted into this bin`
      );
      el.innerHTML = `
        <div class="bin__top">
          <span class="bin__icon" aria-hidden="true">${escapeHtml(def.icon)}</span>
          <span class="bin__label">${escapeHtml(def.label)}</span>
          <span class="bin__count">0</span>
        </div>
        <div class="bin__slot"><div class="bin__slot-inner"></div></div>
      `;
      const countEl = el.querySelector<HTMLSpanElement>(".bin__count")!;
      this.binLayer.appendChild(el);
      const bin: CategoryBin = {
        ...def,
        el: el as unknown as HTMLDivElement,
        countEl,
        centerX: 0,
        topY: 0,
        bottomY: 0,
        count: 0,
        delivered: [],
      };
      el.addEventListener("click", () => this.openArchive(bin));
      this.bins.push(bin);
    }

    this.connectEventStream();
    // SSE delivers an initial snapshot — pullArchive() is a fallback for the
    // first paint in case EventSource is blocked / the network is flaky.
    void this.pullArchive();
    this.relayoutBins();
  }

  /** Open the archive panel for a given bin. Public so callers can deep-link. */
  openArchive(bin: CategoryBin): void {
    if (!this.archiveOverlay) {
      this.archiveOverlay = new ArchiveOverlay(this.stage);
    }
    this.archiveOverlay.show(bin);
    // Pull fresh data so the user sees what others have sorted in the meantime.
    void this.pullArchive();
  }

  resize(w: number, h: number): void {
    this.worldW = w;
    this.worldH = h;
    this.relayoutBins();
    // Re-clamp existing cards into the new viewport.
    for (const m of this.messages.values()) {
      m.homeX = clamp(m.homeX, 80, w - 80);
      m.homeY = clamp(m.homeY, 60, h - this.binsAreaHeight - 80);
    }
  }

  /** All bins, in display order. */
  allBins(): readonly CategoryBin[] {
    return this.bins;
  }

  /** Find the bin matching a content kind (or undefined if none). */
  binFor(kind: ContentKind): CategoryBin | undefined {
    return this.bins.find((b) => b.kind === kind);
  }

  /** Cards currently floating freely (available for the dino to grab). */
  floating(): FloatingMessage[] {
    const out: FloatingMessage[] = [];
    for (const m of this.messages.values()) {
      if (m.state === "floating") out.push(m);
    }
    return out;
  }

  get(id: string): FloatingMessage | undefined {
    return this.messages.get(id);
  }

  /** True if any bin's archive already contains an item with this id. */
  isInArchive(id: string): boolean {
    for (const bin of this.bins) {
      for (const d of bin.delivered) if (d.id === id) return true;
    }
    return false;
  }

  /**
   * Spawn a new message card from the given content item. The card slides in
   * from a random edge (left/right/top) and settles at a randomised home in
   * the upper portion of the viewport.
   *
   * Returns null when the item is already known — either currently on screen,
   * or already sorted into a bin by some other visitor's dino. This stops the
   * dino from "delivering" cards that would just be duplicates server-side.
   */
  spawn(item: ContentItem): FloatingMessage | null {
    if (this.messages.has(item.id)) return this.messages.get(item.id) ?? null;
    if (this.isInArchive(item.id)) return null;
    if (this.messages.size >= this.maxConcurrent) return null;
    if (!this.binFor(item.kind)) return null;

    const el = document.createElement("div");
    el.className = `msg msg--${item.kind}`;
    el.innerHTML = `
      <div class="msg__head">
        <span class="msg__kind">${escapeHtml(kindLabel(item.kind))}</span>
      </div>
      <div class="msg__body">${escapeHtml(item.text)}</div>
    `;
    if (item.href) {
      const link = document.createElement("a");
      link.className = "msg__link";
      link.href = item.href;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = item.linkLabel ?? "open ↗";
      el.appendChild(link);
    }
    this.cardLayer.appendChild(el);

    // Pick a home in the upper region — above the bins, with margins on the
    // sides so cards don't crowd the edges.
    const marginX = 100;
    const homeX = marginX + Math.random() * (this.worldW - marginX * 2);
    const homeBandTop = 70;
    const homeBandBottom = Math.max(homeBandTop + 60, this.worldH * 0.45);
    const homeY = homeBandTop + Math.random() * (homeBandBottom - homeBandTop);

    // Pick an edge to enter from.
    const edge = pickEdge();
    let startX = homeX;
    let startY = homeY;
    const offscreen = 220;
    switch (edge) {
      case "left":
        startX = -offscreen;
        startY = homeY + (Math.random() - 0.5) * 60;
        break;
      case "right":
        startX = this.worldW + offscreen;
        startY = homeY + (Math.random() - 0.5) * 60;
        break;
      case "top":
        startX = homeX + (Math.random() - 0.5) * 80;
        startY = -offscreen;
        break;
    }

    const msg: FloatingMessage = {
      id: item.id,
      kind: item.kind,
      text: item.text,
      href: item.href,
      linkLabel: item.linkLabel,
      x: startX,
      y: startY,
      homeX,
      homeY,
      state: "entering",
      bobPhase: Math.random() * Math.PI * 2,
      spawnedAt: performance.now(),
      deliverDoneAt: 0,
      el,
    };
    this.messages.set(item.id, msg);

    requestAnimationFrame(() => el.classList.add("msg--visible"));
    this.applyTransform(msg);

    this.onSpawn?.(item);
    return msg;
  }

  /**
   * Reserve a card for a specific carrier. Returns true if the claim succeeded
   * (card was floating). Other workers won't see this card via `floating()`.
   */
  claim(id: string): boolean {
    const m = this.messages.get(id);
    if (!m || m.state !== "floating") return false;
    m.state = "claimed";
    m.el.classList.add("msg--claimed");
    return true;
  }

  /** Tell the world this card is now glued to its carrier at (x, y). */
  setCarried(id: string, x: number, y: number): void {
    const m = this.messages.get(id);
    if (!m) return;
    if (m.state !== "carried") {
      m.state = "carried";
      m.el.classList.add("msg--carried");
    }
    m.x = x;
    m.y = y;
    this.applyTransform(m);
  }

  /** Release a claim/carry without delivering — card returns to floating. */
  release(id: string): void {
    const m = this.messages.get(id);
    if (!m) return;
    if (m.state === "claimed" || m.state === "carried") {
      m.state = "floating";
      m.el.classList.remove("msg--claimed", "msg--carried");
    }
  }

  /**
   * Deliver a card into the matching bin. The card animates down/in, the
   * bin's count increments, and the message is removed when its animation
   * completes. Returns true if a delivery animation was started.
   */
  deliver(id: string): boolean {
    const m = this.messages.get(id);
    if (!m) return false;
    const bin = this.binFor(m.kind);
    if (!bin) return false;

    m.state = "delivering";
    m.el.classList.remove("msg--claimed", "msg--carried");
    m.el.classList.add("msg--delivering");
    // Animate the card to the bin slot's centre.
    const targetX = bin.centerX;
    const targetY = bin.topY + 14; // a bit inside the bin opening
    m.x = targetX;
    m.y = targetY;
    m.deliverDoneAt = performance.now() + 360;
    this.applyTransform(m);

    // Optimistic local update: replace any existing entry for this id, then
    // prune expired. The authoritative state is the server's; pushDelivery()
    // syncs from its response.
    const newItem: DeliveredItem = {
      id: m.id,
      kind: m.kind,
      text: m.text,
      href: m.href,
      linkLabel: m.linkLabel,
      deliveredAt: Date.now(),
    };
    bin.delivered = bin.delivered.filter((d) => d.id !== m.id);
    bin.delivered.unshift(newItem);
    pruneExpired(bin);
    bin.count = bin.delivered.length;
    bin.countEl.textContent = String(bin.count);
    if (this.archiveOverlay) this.archiveOverlay.refreshIfShowing(bin);
    void this.pushDelivery(newItem);
    bumpBin(bin);
    return true;
  }

  /** Per-frame tick: easing, bobbing, garbage collection of finished cards. */
  update(now: number): void {
    for (const m of this.messages.values()) {
      switch (m.state) {
        case "entering": {
          // Critically-damped-ish ease toward home.
          const k = 0.10;
          m.x += (m.homeX - m.x) * k;
          m.y += (m.homeY - m.y) * k;
          if (Math.abs(m.x - m.homeX) < 0.5 && Math.abs(m.y - m.homeY) < 0.5) {
            m.x = m.homeX;
            m.y = m.homeY;
            m.state = "floating";
          }
          this.applyTransform(m);
          break;
        }
        case "floating": {
          const t = (now - m.spawnedAt) / 1000;
          const bobX = Math.sin(t * 0.7 + m.bobPhase) * 6;
          const bobY = Math.cos(t * 0.9 + m.bobPhase * 1.3) * 4;
          m.x = m.homeX + bobX;
          m.y = m.homeY + bobY;
          this.applyTransform(m);
          break;
        }
        case "claimed": {
          // Hold position; the dino is on his way.
          this.applyTransform(m);
          break;
        }
        case "carried": {
          // Position is set externally via setCarried(); just re-apply.
          this.applyTransform(m);
          break;
        }
        case "delivering": {
          this.applyTransform(m);
          if (now >= m.deliverDoneAt) {
            m.state = "gone";
            m.el.remove();
          }
          break;
        }
        case "gone":
          break;
      }
    }
    // GC
    for (const [id, m] of this.messages) {
      if (m.state === "gone") this.messages.delete(id);
    }
    // Periodically pull from the shared archive so this client sees items
    // other visitors' dinos have sorted, and so expired items disappear.
    if (now >= this.nextRefreshAt) {
      this.nextRefreshAt = now + ARCHIVE_REFRESH_INTERVAL_MS;
      void this.pullArchive();
    }
  }

  private applyTransform(m: FloatingMessage): void {
    m.el.style.transform = `translate3d(${Math.round(m.x)}px, ${Math.round(
      m.y
    )}px, 0) translate(-50%, -50%)`;
  }

  private async pullArchive(): Promise<void> {
    if (!ARCHIVE_API_URL) return;
    try {
      const resp = await fetch(`${ARCHIVE_API_URL}/archive`, { cache: "no-store" });
      if (!resp.ok) return;
      const data = await resp.json();
      this.applySnapshot(data?.bins);
    } catch {
      // Network/CORS error — keep current local state.
    }
  }

  /**
   * Subscribe to server-sent events so this client sees other visitors'
   * deliveries instantly instead of waiting for the next 60s poll. The
   * server sends typed deltas (`snapshot` / `add` / `expire`) so the
   * per-event payload stays small even when the archive has hundreds of
   * items. The browser auto-reconnects on transient drops; on persistent
   * failure the periodic pullArchive() in update() keeps us current.
   */
  private connectEventStream(): void {
    if (!ARCHIVE_API_URL || typeof EventSource === "undefined") return;
    try {
      const es = new EventSource(`${ARCHIVE_API_URL}/events`);
      es.onmessage = (ev) => this.dispatchServerEvent(ev.data);
    } catch {
      // EventSource construction blocked (e.g. CSP) — fall back to polling.
    }
  }

  private dispatchServerEvent(raw: string): void {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (!data || typeof data !== "object") return;
    const obj = data as { type?: string; bins?: unknown; item?: unknown; ids?: unknown };
    switch (obj.type) {
      case "snapshot":
        this.applySnapshot(obj.bins);
        return;
      case "add": {
        const item = sanitizeDeliveredItem(obj.item);
        if (item) this.applyAddedItem(item);
        return;
      }
      case "expire":
        if (Array.isArray(obj.ids)) {
          this.applyExpiredIds(obj.ids.filter((x): x is string => typeof x === "string"));
        }
        return;
      case "item": {
        const item = sanitizeContentItem(obj.item);
        if (item) this.spawn(item);
        return;
      }
      default:
        // Pre-typed-event fallback (older server) — treat as raw snapshot.
        if (obj.bins) this.applySnapshot(obj.bins);
    }
  }

  private async pushDelivery(item: DeliveredItem): Promise<void> {
    if (!ARCHIVE_API_URL) return;
    try {
      const resp = await fetch(`${ARCHIVE_API_URL}/archive`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: item.id,
          kind: item.kind,
          text: item.text,
          href: item.href,
          linkLabel: item.linkLabel,
        }),
      });
      if (!resp.ok) return;
      const data = (await resp.json()) as { ok?: boolean; item?: unknown; bins?: unknown };
      if (data?.bins) {
        // Older server flavour — apply the full snapshot.
        this.applySnapshot(data.bins);
      } else if (data?.item) {
        const cleaned = sanitizeDeliveredItem(data.item);
        if (cleaned) this.applyAddedItem(cleaned);
      }
    } catch {
      // Optimistic update already applied; ignore network failures.
    }
  }

  /**
   * Apply a single delivery delta. Bumps the bin if the item is genuinely
   * new (not a re-delivery of an id already present), and culls any
   * floating duplicate so our dino doesn't waste a trip on it.
   */
  private applyAddedItem(item: DeliveredItem): void {
    const bin = this.binFor(item.kind);
    if (!bin) return;
    const wasPresent = bin.delivered.some((d) => d.id === item.id);
    bin.delivered = bin.delivered.filter((d) => d.id !== item.id);
    bin.delivered.unshift(item);
    pruneExpired(bin);
    bin.count = bin.delivered.length;
    bin.countEl.textContent = String(bin.count);
    if (!wasPresent) bumpBin(bin);
    if (this.archiveOverlay) this.archiveOverlay.refreshIfShowing(bin);
    // Cull a duplicate floating card if we have one — same rationale as in
    // applySnapshot but targeted at this single id.
    const dup = this.messages.get(item.id);
    if (dup && (dup.state === "entering" || dup.state === "floating")) {
      dup.state = "gone";
      dup.el.remove();
    }
  }

  private applyExpiredIds(ids: string[]): void {
    if (ids.length === 0) return;
    const set = new Set(ids);
    for (const bin of this.bins) {
      const before = bin.delivered.length;
      bin.delivered = bin.delivered.filter((d) => !set.has(d.id));
      if (bin.delivered.length !== before) {
        bin.count = bin.delivered.length;
        bin.countEl.textContent = String(bin.count);
        if (this.archiveOverlay) this.archiveOverlay.refreshIfShowing(bin);
      }
    }
  }

  private applySnapshot(byKind: unknown): void {
    const cleaned = extractArchive(byKind);
    if (!cleaned) return;
    for (const bin of this.bins) {
      const list = cleaned[bin.kind] ?? [];
      const before = bin.count;
      // Trust the server's ordering (newest first), but still prune in case
      // the client clock disagrees enough to keep something past the TTL.
      bin.delivered = list.slice();
      pruneExpired(bin);
      bin.count = bin.delivered.length;
      bin.countEl.textContent = String(bin.count);
      if (bin.count > before) bumpBin(bin);
      if (this.archiveOverlay) this.archiveOverlay.refreshIfShowing(bin);
    }
    // If a refresh reveals that something currently floating is already in
    // the shared archive (delivered by another visitor's dino), quietly cull
    // it so we don't ask our dino to do the same work for no count change.
    // We only touch idle states — claimed/carried/delivering items keep
    // playing out their animation to avoid visual jank.
    for (const m of [...this.messages.values()]) {
      if (m.state !== "entering" && m.state !== "floating") continue;
      if (this.isInArchive(m.id)) {
        m.state = "gone";
        m.el.remove();
      }
    }
  }

  private relayoutBins(): void {
    const n = this.bins.length;
    if (n === 0) return;
    // The bins live in their own bottom row (positioned via CSS). We just
    // need to compute the world-space centres so the dino knows where to
    // walk. We measure once on next frame to get accurate positions.
    requestAnimationFrame(() => {
      for (const bin of this.bins) {
        const rect = bin.el.getBoundingClientRect();
        const parentRect = (this.binLayer.parentElement ?? document.body).getBoundingClientRect();
        bin.centerX = rect.left - parentRect.left + rect.width / 2;
        bin.topY = rect.top - parentRect.top;
        bin.bottomY = rect.bottom - parentRect.top;
      }
    });
  }
}

/**
 * A pop-up panel listing every item the dino has delivered into a single bin.
 * Created on first use and reused for every subsequent open.
 */
class ArchiveOverlay {
  private readonly backdrop: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly titleEl: HTMLSpanElement;
  private readonly countEl: HTMLSpanElement;
  private readonly listEl: HTMLDivElement;
  private readonly emptyEl: HTMLDivElement;
  private currentBin: CategoryBin | null = null;
  private readonly onKey: (e: KeyboardEvent) => void;

  constructor(parent: HTMLElement) {
    this.backdrop = document.createElement("div");
    this.backdrop.className = "archive-backdrop";
    this.backdrop.setAttribute("hidden", "");

    this.panel = document.createElement("div");
    this.panel.className = "archive-panel";
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-modal", "true");
    this.panel.setAttribute("aria-label", "Archive");
    this.panel.innerHTML = `
      <div class="archive__head">
        <span class="archive__title"></span>
        <span class="archive__count"></span>
        <button type="button" class="archive__close" aria-label="Close archive">×</button>
      </div>
      <div class="archive__list" role="list"></div>
      <div class="archive__empty">// nothing here yet — dino hasn't sorted anything into this bin.</div>
    `;
    this.titleEl = this.panel.querySelector<HTMLSpanElement>(".archive__title")!;
    this.countEl = this.panel.querySelector<HTMLSpanElement>(".archive__count")!;
    this.listEl = this.panel.querySelector<HTMLDivElement>(".archive__list")!;
    this.emptyEl = this.panel.querySelector<HTMLDivElement>(".archive__empty")!;

    this.backdrop.appendChild(this.panel);
    parent.appendChild(this.backdrop);

    this.backdrop.addEventListener("click", (e) => {
      if (e.target === this.backdrop) this.hide();
    });
    this.panel
      .querySelector<HTMLButtonElement>(".archive__close")!
      .addEventListener("click", () => this.hide());

    this.onKey = (e) => {
      if (e.key === "Escape" && this.currentBin) this.hide();
    };
  }

  show(bin: CategoryBin): void {
    this.currentBin = bin;
    this.render(bin);
    this.backdrop.removeAttribute("hidden");
    requestAnimationFrame(() => this.backdrop.classList.add("archive-backdrop--open"));
    document.addEventListener("keydown", this.onKey);
  }

  hide(): void {
    this.currentBin = null;
    this.backdrop.classList.remove("archive-backdrop--open");
    document.removeEventListener("keydown", this.onKey);
    // Match the CSS transition duration before hiding entirely.
    setTimeout(() => {
      if (!this.currentBin) this.backdrop.setAttribute("hidden", "");
    }, 200);
  }

  refreshIfShowing(bin: CategoryBin): void {
    if (this.currentBin === bin) this.render(bin);
  }

  private render(bin: CategoryBin): void {
    this.titleEl.textContent = bin.label;
    this.countEl.textContent = `${bin.delivered.length} item${
      bin.delivered.length === 1 ? "" : "s"
    }`;
    this.panel.dataset.kind = bin.kind;

    if (bin.delivered.length === 0) {
      this.listEl.innerHTML = "";
      this.emptyEl.style.display = "";
      return;
    }
    this.emptyEl.style.display = "none";
    this.listEl.innerHTML = bin.delivered
      .map((item) => {
        const time = formatRelative(item.deliveredAt);
        const link = item.href
          ? `<a class="archive__link" href="${escapeHtml(item.href)}" target="_blank" rel="noopener">${escapeHtml(item.linkLabel ?? "open ↗")}</a>`
          : "";
        return `
          <article class="archive__item" role="listitem">
            <div class="archive__meta">
              <span class="archive__time">${escapeHtml(time)}</span>
            </div>
            <div class="archive__body">${escapeHtml(item.text)}</div>
            ${link}
          </article>
        `;
      })
      .join("");
  }
}

function formatRelative(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const s = Math.floor(diff / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Drop entries past the TTL. Mutates `bin.delivered` in place. */
function pruneExpired(bin: CategoryBin): void {
  const cutoff = Date.now() - ARCHIVE_TTL_MS;
  bin.delivered = bin.delivered.filter((d) => d.deliveredAt >= cutoff);
}

/** Replay the bin's bump animation. */
function bumpBin(bin: CategoryBin): void {
  bin.el.classList.remove("bin--bump");
  // Force reflow so the keyframes restart from the top.
  void bin.el.offsetWidth;
  bin.el.classList.add("bin--bump");
}

/** Validate a single ContentItem-shaped value (from a server "item" event). */
function sanitizeContentItem(raw: unknown): ContentItem | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Partial<ContentItem>;
  if (
    typeof item.id !== "string" ||
    typeof item.kind !== "string" ||
    typeof item.text !== "string" ||
    typeof item.publishedAt !== "number" ||
    typeof item.score !== "number"
  ) {
    return null;
  }
  return {
    id: item.id,
    kind: item.kind as ContentKind,
    text: item.text,
    href: typeof item.href === "string" ? item.href : undefined,
    linkLabel: typeof item.linkLabel === "string" ? item.linkLabel : undefined,
    publishedAt: item.publishedAt,
    score: item.score,
  };
}

/** Validate a single DeliveredItem-shaped value; returns null on bad shape. */
function sanitizeDeliveredItem(raw: unknown): DeliveredItem | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Partial<DeliveredItem>;
  if (
    typeof item.id !== "string" ||
    typeof item.kind !== "string" ||
    typeof item.text !== "string" ||
    typeof item.deliveredAt !== "number"
  ) {
    return null;
  }
  return {
    id: item.id,
    kind: item.kind as ContentKind,
    text: item.text,
    href: typeof item.href === "string" ? item.href : undefined,
    linkLabel: typeof item.linkLabel === "string" ? item.linkLabel : undefined,
    deliveredAt: item.deliveredAt,
  };
}

/**
 * Validate a `{ kind: DeliveredItem[] }` map from the archive API, dropping
 * malformed entries silently. Returns null if the shape is wholly unusable.
 */
function extractArchive(byKind: unknown): Record<string, DeliveredItem[]> | null {
  if (!byKind || typeof byKind !== "object") return null;
  const out: Record<string, DeliveredItem[]> = {};
  for (const [kind, list] of Object.entries(byKind as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const cleaned: DeliveredItem[] = [];
    for (const raw of list) {
      const item = sanitizeDeliveredItem(raw);
      if (item) cleaned.push(item);
    }
    out[kind] = cleaned;
  }
  return out;
}

function pickEdge(): "left" | "right" | "top" {
  const r = Math.random();
  if (r < 0.4) return "left";
  if (r < 0.8) return "right";
  return "top";
}

function kindLabel(kind: ContentKind): string {
  switch (kind) {
    case "news":
      return "news";
    case "weather":
      return "weather";
    case "fact":
      return "fact";
    case "thought":
      return "thought";
    case "quake":
      return "quake";
    case "history":
      return "history";
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

let stylesInjected = false;
function injectStylesOnce(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .msg-layer {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 4;
      overflow: hidden;
    }

    .msg {
      position: absolute;
      left: 0;
      top: 0;
      width: clamp(180px, 22vw, 260px);
      padding: 8px 10px 9px;
      background: var(--paper, #1f1e26);
      color: var(--ink, #e8e4d8);
      border: 1.5px solid var(--ink, #e8e4d8);
      border-radius: 2px;
      box-shadow: 0 6px 0 rgba(0, 0, 0, 0.25);
      font: 500 12.5px/1.45 ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
      pointer-events: auto;
      opacity: 0;
      transition: opacity 240ms ease, transform 320ms cubic-bezier(.2,.7,.2,1.4),
                  box-shadow 200ms ease, filter 200ms ease;
      will-change: transform, opacity;
    }
    .msg--visible { opacity: 1; }

    .msg--claimed { filter: brightness(1.05); }
    .msg--carried { box-shadow: 0 3px 0 rgba(0, 0, 0, 0.35); }

    .msg--delivering {
      transition: transform 360ms cubic-bezier(.4,.05,.6,.4),
                  opacity 360ms ease;
      opacity: 0.0;
      filter: blur(0.4px);
    }

    .msg__head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 4px;
      color: var(--ink-soft, #8a8678);
      font-size: 10px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .msg__kind::before { content: "// "; opacity: 0.7; }

    .msg__body {
      white-space: pre-wrap;
      word-break: break-word;
    }

    .msg__link {
      display: inline-block;
      margin-top: 6px;
      color: var(--ink, #e8e4d8);
      text-decoration: none;
      border-bottom: 1px solid var(--ink, #e8e4d8);
      font-size: 11px;
    }
    .msg__link:hover {
      background: var(--ink, #e8e4d8);
      color: var(--paper, #1f1e26);
    }

    /* kind-specific accent colour on the left edge */
    .msg--news    { border-left-width: 4px; border-left-color: #ff9a73; }
    .msg--weather { border-left-width: 4px; border-left-color: #7ec8ff; }
    .msg--fact    { border-left-width: 4px; border-left-color: #8dd9a8; }
    .msg--thought { border-left-width: 4px; border-left-color: #c8a8ff; }
    .msg--quake   { border-left-width: 4px; border-left-color: #f3c969; }
    .msg--history { border-left-width: 4px; border-left-color: #d4a574; }

    .bin-row {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 12px;
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 10px 14px;
      padding: 0 16px;
      pointer-events: none;
      z-index: 3;
    }

    .bin {
      pointer-events: auto;
      min-width: 110px;
      max-width: 180px;
      padding: 6px 10px 8px;
      background: var(--paper, #1f1e26);
      border: 1.5px solid var(--ink, #e8e4d8);
      border-radius: 2px;
      color: var(--ink, #e8e4d8);
      font: 600 11px/1.2 ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      text-align: left;
      cursor: pointer;
      transform-origin: 50% 100%;
      transition: transform 220ms cubic-bezier(.2,.7,.2,1.4),
                  background-color 160ms ease, color 160ms ease;
    }
    .bin:hover { background: var(--ink, #e8e4d8); color: var(--paper, #1f1e26); }
    .bin:hover .bin__count { color: var(--paper, #1f1e26); }
    .bin:focus-visible {
      outline: 2px solid var(--ink, #e8e4d8);
      outline-offset: 2px;
    }
    .bin--bump { animation: binBump 360ms cubic-bezier(.2,.7,.2,1.4); }
    @keyframes binBump {
      0%   { transform: translateY(0) scale(1); }
      35%  { transform: translateY(-6px) scale(1.04); }
      100% { transform: translateY(0) scale(1); }
    }

    .bin__top {
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    .bin__icon {
      font-size: 14px;
      letter-spacing: 0;
      text-transform: none;
    }
    .bin__label { flex: 1; }
    .bin__count {
      font-size: 13px;
      color: var(--ink-soft, #8a8678);
      letter-spacing: 0;
    }
    .bin__slot {
      margin-top: 6px;
      height: 6px;
      background: var(--bg, #14141a);
      border: 1px solid var(--ink-soft, #8a8678);
      border-radius: 1px;
      overflow: hidden;
    }
    .bin__slot-inner {
      width: 100%;
      height: 100%;
    }

    .bin--news    { border-bottom: 4px solid #ff9a73; }
    .bin--weather { border-bottom: 4px solid #7ec8ff; }
    .bin--fact    { border-bottom: 4px solid #8dd9a8; }
    .bin--thought { border-bottom: 4px solid #c8a8ff; }
    .bin--quake   { border-bottom: 4px solid #f3c969; }
    .bin--history { border-bottom: 4px solid #d4a574; }

    .archive-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(10, 10, 14, 0.55);
      backdrop-filter: blur(2px);
      -webkit-backdrop-filter: blur(2px);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      z-index: 6;
      opacity: 0;
      transition: opacity 200ms ease;
    }
    .archive-backdrop[hidden] { display: none; }
    .archive-backdrop--open { opacity: 1; }

    .archive-panel {
      width: min(560px, 100%);
      max-height: min(72vh, 560px);
      display: flex;
      flex-direction: column;
      background: var(--paper, #1f1e26);
      color: var(--ink, #e8e4d8);
      border: 1.5px solid var(--ink, #e8e4d8);
      border-radius: 3px;
      box-shadow: 0 14px 0 rgba(0, 0, 0, 0.35);
      transform: translateY(8px);
      transition: transform 200ms cubic-bezier(.2,.7,.2,1.4);
      font: 500 13px/1.5 ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
    }
    .archive-backdrop--open .archive-panel { transform: translateY(0); }

    .archive-panel[data-kind="news"]    { border-top: 4px solid #ff9a73; }
    .archive-panel[data-kind="weather"] { border-top: 4px solid #7ec8ff; }
    .archive-panel[data-kind="fact"]    { border-top: 4px solid #8dd9a8; }
    .archive-panel[data-kind="thought"] { border-top: 4px solid #c8a8ff; }
    .archive-panel[data-kind="quake"]   { border-top: 4px solid #f3c969; }
    .archive-panel[data-kind="history"] { border-top: 4px solid #d4a574; }

    .archive__head {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--ink-soft, #8a8678);
    }
    .archive__title {
      flex: 0 0 auto;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      font-size: 12px;
    }
    .archive__title::before { content: "// "; opacity: 0.7; }
    .archive__count {
      flex: 1;
      color: var(--ink-soft, #8a8678);
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .archive__close {
      background: transparent;
      border: 1px solid var(--ink, #e8e4d8);
      color: var(--ink, #e8e4d8);
      width: 26px;
      height: 26px;
      border-radius: 2px;
      cursor: pointer;
      font-size: 16px;
      line-height: 1;
      transition: background-color 160ms ease, color 160ms ease;
    }
    .archive__close:hover {
      background: var(--ink, #e8e4d8);
      color: var(--paper, #1f1e26);
    }

    .archive__list {
      flex: 1 1 auto;
      overflow: auto;
      padding: 8px 14px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .archive__list::-webkit-scrollbar { width: 8px; }
    .archive__list::-webkit-scrollbar-thumb {
      background: var(--ink-soft, #8a8678);
      border-radius: 1px;
    }

    .archive__item {
      padding: 10px 12px;
      border: 1px solid var(--ink-soft, #8a8678);
      border-radius: 2px;
    }
    .archive__meta {
      display: flex;
      gap: 8px;
      margin-bottom: 4px;
      color: var(--ink-soft, #8a8678);
      font-size: 10px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .archive__body {
      white-space: pre-wrap;
      word-break: break-word;
    }
    .archive__link {
      display: inline-block;
      margin-top: 8px;
      color: var(--ink, #e8e4d8);
      text-decoration: none;
      border-bottom: 1px solid var(--ink, #e8e4d8);
      font-size: 11.5px;
    }
    .archive__link:hover {
      background: var(--ink, #e8e4d8);
      color: var(--paper, #1f1e26);
    }

    .archive__empty {
      padding: 24px 16px 28px;
      color: var(--ink-soft, #8a8678);
      font-size: 12px;
      text-align: center;
    }

    @media (prefers-reduced-motion: reduce) {
      .msg, .bin { transition: opacity 180ms ease; }
      .bin--bump { animation: none; }
      .archive-backdrop, .archive-panel { transition: opacity 120ms ease; }
    }
  `;
  document.head.appendChild(style);
}
