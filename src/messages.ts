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

import { RADIO_MANIFEST } from "virtual:radio-manifest";
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
  /** Maximum number of cards visible at once. Extra realtime items wait in a local queue. */
  maxConcurrent?: number;
  /** Bottom padding (px) reserved for the bins row. */
  binsAreaHeight?: number;
  /**
   * Called whenever spawn() actually creates a new floating card. Used by
   * main.ts to trigger the dino's "surprised" double-take. Not called for
   * dedup rejections, capacity rejections, or unknown kinds.
   */
  onSpawn?: (item: ContentItem) => void;
  /** Called when the user changes radio channel/pace. */
  onRadioChange?: (prefs: RadioPreferences) => void;
  /** Called sparingly when the local radio queue starts backing up. */
  onBacklogPressure?: (pendingCount: number) => void;
}

/**
 * Owns the DOM layer for floating messages and the row of bins beneath them.
 */
/**
 * Items delivered to a bin live in the shared archive for this long. The
 * server enforces the same window; we keep this constant client-side so we
 * can prune defensively if the network is unavailable.
 */
const ARCHIVE_TTL_MS = 24 * 60 * 60 * 1000;
/** How often the client polls the server for items others have sorted. */
const ARCHIVE_REFRESH_INTERVAL_MS = 60_000;
const CARD_SPAWN_GAP_MS = 2_500;

// Pattern reactions: the dino notices when the same word keeps coming up
// in incoming items and spins out a small "thought" of its own. Tuned to
// be quietly observant, not chatty.
const PATTERN_COOLDOWN_MS = 90_000;
const PATTERN_WINDOW_MS = 15 * 60_000;
const PATTERN_BUFFER_MAX = 32;
const PATTERN_MIN_ITEMS = 5;
const PATTERN_MIN_DOC_COUNT = 3;
const RADIO_STORAGE_KEY = "dinosaurus.radio.v1";
const RADIO_CHANNELS = ["news", "quake", "history", "fact", "thought", "space", "bird"] as const;
type RadioChannel = "all" | (typeof RADIO_CHANNELS)[number];

/**
 * Maps each radio channel to its folder under `public/audio/radio/`. The
 * radio plays a random track from that folder, falling back to the "all"
 * folder if the channel-specific one is empty.
 */
const RADIO_FOLDER: Record<RadioChannel, string> = {
  all: "all",
  news: "news",
  quake: "quakes",
  history: "history",
  fact: "facts",
  thought: "thoughts",
  space: "space",
  bird: "birds",
};
type RadioPace = "chill" | "normal" | "busy";
interface RadioPreferences {
  channel: RadioChannel;
  pace: RadioPace;
}
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
  private nextSpawnAt = 0;
  private readonly onSpawn?: (item: ContentItem) => void;
  private readonly onRadioChange?: (prefs: RadioPreferences) => void;
  private readonly onBacklogPressure?: (pendingCount: number) => void;
  private archiveWarningShown = false;
  private realtime: WebSocket | null = null;
  private realtimeConnected = false;
  private clientId: string | null = null;
  private readonly pendingItems = new Map<string, ContentItem>();
  private radioPrefs = loadRadioPreferences();
  private radioStatusEl: HTMLSpanElement | null = null;
  private readonly radioAudio = new RadioAudio();
  private lastBacklogWarningAt = 0;
  /** Rolling window of incoming items used to detect recurring keywords. */
  private readonly recentForPattern: Array<{ kind: ContentKind; text: string; at: number }> = [];
  private lastPatternAt = 0;
  private lastPatternWord = "";
  /** IDs of locally-synthesised pattern cards — skipped from pattern recording
   *  to avoid the dino observing its own observations. */
  private readonly syntheticPatternIds = new Set<string>();

  constructor(
    parent: HTMLElement,
    binDefs: BinDef[],
    worldW: number,
    worldH: number,
    opts: MessageWorldOptions = {}
  ) {
    this.stage = parent;
    this.onSpawn = opts.onSpawn;
    this.onRadioChange = opts.onRadioChange;
    this.onBacklogPressure = opts.onBacklogPressure;
    this.worldW = worldW;
    this.worldH = worldH;
    this.maxConcurrent = opts.maxConcurrent ?? 3;
    this.binsAreaHeight = opts.binsAreaHeight ?? 88;

    injectStylesOnce();

    this.cardLayer = document.createElement("div");
    this.cardLayer.className = "msg-layer";
    parent.appendChild(this.cardLayer);

    this.binLayer = document.createElement("div");
    this.binLayer.className = "bin-row";
    parent.appendChild(this.binLayer);

    this.createRadioControls();

    for (const def of binDefs) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = `bin bin--${def.kind}`;
      el.dataset.empty = "true";
      el.setAttribute(
        "aria-label",
        `Open ${def.label} archive — items the dino has sorted into this bin`
      );
      el.innerHTML = `
        <div class="bin__pulse" aria-hidden="true"></div>
        <div class="bin__top">
          <span class="bin__icon" aria-hidden="true">${escapeHtml(def.icon)}</span>
          <span class="bin__count">00</span>
        </div>
        <div class="bin__label">${escapeHtml(def.label)}</div>
        <div class="bin__lid"><div class="bin__slot" aria-hidden="true"></div></div>
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

    this.connectRealtime();
    // The realtime connection delivers an initial snapshot. pullArchive() is a
    // first-paint fallback for the archive counts while the socket connects.
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
    const isSynthetic = this.syntheticPatternIds.has(item.id);
    if (isSynthetic) this.syntheticPatternIds.delete(item.id);
    if (this.messages.has(item.id)) return this.messages.get(item.id) ?? null;
    if (this.isInArchive(item.id)) return null;
    if (this.messages.size >= this.maxConcurrent) return null;
    if (!this.binFor(item.kind)) return null;

    const el = document.createElement("div");
    el.className = `msg msg--${item.kind}`;
    const stampLabel = stampLabelFor(item.kind);
    el.innerHTML = `
      <div class="msg__tag">
        <span class="msg__tag-icon" aria-hidden="true">${escapeHtml(kindIcon(item.kind))}</span>
        <span class="msg__tag-label">${escapeHtml(kindLabel(item.kind))}</span>
      </div>
      <div class="msg__body">${escapeHtml(item.text)}</div>
      <div class="msg__stamp">
        <span class="msg__stamp-source">${escapeHtml(stampLabel)}</span>
        <span class="msg__stamp-mark" aria-hidden="true">${item.href ? "↗" : "·"}</span>
      </div>
    `;
    if (item.href) {
      const link = document.createElement("a");
      link.className = "msg__link";
      link.href = item.href;
      link.target = "_blank";
      link.rel = "noopener";
      link.setAttribute("aria-label", item.linkLabel ?? "open in new tab");
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
    this.radioAudio.item(item.kind);

    // Pattern detection runs on real items only — synthetic pattern cards
    // shouldn't observe themselves into a feedback loop.
    if (!isSynthetic) {
      this.recordForPattern(item);
      this.maybeSpawnPattern(item.kind);
    }
    return msg;
  }

  private recordForPattern(item: ContentItem): void {
    this.recentForPattern.push({
      kind: item.kind,
      text: item.text,
      at: performance.now(),
    });
    if (this.recentForPattern.length > PATTERN_BUFFER_MAX) {
      this.recentForPattern.shift();
    }
  }

  private maybeSpawnPattern(kind: ContentKind): void {
    const now = performance.now();
    if (now - this.lastPatternAt < PATTERN_COOLDOWN_MS) return;

    const cutoff = now - PATTERN_WINDOW_MS;
    const recent = this.recentForPattern.filter(
      (r) => r.kind === kind && r.at >= cutoff
    );
    if (recent.length < PATTERN_MIN_ITEMS) return;

    const top = findTopKeyword(recent);
    if (!top || top.docCount < PATTERN_MIN_DOC_COUNT) return;
    if (top.word === this.lastPatternWord) return;

    // Don't fire a pattern card if the thoughts bin already shows one — would
    // crowd the same observation against itself.
    if (!this.binFor("thought")) return;

    this.lastPatternAt = now;
    this.lastPatternWord = top.word;

    const id = `${SYNTHETIC_PATTERN_PREFIX}${Date.now().toString(36)}:${top.word}`;
    this.syntheticPatternIds.add(id);
    const text = patternPhrase(top.word, top.docCount, kind);
    const spawned = this.spawn({
      id,
      kind: "thought",
      text,
      publishedAt: Date.now(),
      score: 0.55,
    });
    // If the spawn was rejected (already in archive, max concurrent, etc.),
    // discard the synthetic id so the set doesn't leak.
    if (!spawned) this.syntheticPatternIds.delete(id);
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
    this.sendRealtime({ type: "claim", id });
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
      this.sendRealtime({ type: "release", id });
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
    updateBinCountUI(bin);
    if (this.archiveOverlay) this.archiveOverlay.refreshIfShowing(bin);
    // Pattern cards are local-only — the server never saw them, so don't
    // try to sync them. They live in the visitor's archive only.
    if (!isSyntheticPatternId(newItem.id)) {
      if (this.realtimeConnected) this.sendRealtime({ type: "deliver", id: newItem.id });
      else void this.pushDelivery(newItem);
    }
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
    this.drainPending(now);
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
      if (!resp.ok) {
        this.warnArchiveSync(`GET /archive returned ${resp.status}`);
        return;
      }
      const data = await resp.json();
      this.applySnapshot(data?.bins);
    } catch (err) {
      this.warnArchiveSync("GET /archive failed", err);
      // Network/CORS error — keep current local state.
    }
  }

  private connectRealtime(): void {
    if (!ARCHIVE_API_URL || typeof WebSocket === "undefined") {
      this.connectEventStream();
      return;
    }
    try {
      const ws = new WebSocket(`${wsBaseUrl(ARCHIVE_API_URL)}/realtime`);
      this.realtime = ws;
      ws.addEventListener("open", () => {
        this.realtimeConnected = true;
        this.sendRealtime({ type: "hello", preferences: this.realtimePreferences() });
      });
      ws.addEventListener("message", (ev) => {
        if (typeof ev.data === "string") this.dispatchServerEvent(ev.data);
      });
      ws.addEventListener("close", () => {
        this.realtimeConnected = false;
        this.clientId = null;
        window.setTimeout(() => this.connectRealtime(), 3_000 + Math.random() * 2_000);
      });
      ws.addEventListener("error", () =>
        this.warnArchiveSync("WebSocket /realtime failed; archive polling remains as fallback")
      );
    } catch (err) {
      this.warnArchiveSync("WebSocket /realtime could not start", err);
      this.connectEventStream();
    }
  }

  private sendRealtime(data: unknown): void {
    if (!this.realtimeConnected || !this.realtime || this.realtime.readyState !== WebSocket.OPEN) {
      return;
    }
    this.realtime.send(JSON.stringify(data));
  }

  private realtimePreferences(): { channels: ContentKind[]; pace: RadioPace } {
    return {
      channels:
        this.radioPrefs.channel === "all"
          ? [...RADIO_CHANNELS]
          : [this.radioPrefs.channel],
      pace: this.radioPrefs.pace,
    };
  }

  private createRadioControls(): void {
    const controls = document.createElement("div");
    controls.className = "radio-controls";
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", "dino radio");
    controls.dataset.playing = "false";

    const channels: Array<{ value: RadioChannel; label: string }> = [
      { value: "all", label: "all" },
      { value: "news", label: "news" },
      { value: "quake", label: "quakes" },
      { value: "history", label: "history" },
      { value: "fact", label: "facts" },
      { value: "thought", label: "thoughts" },
      { value: "space", label: "space" },
      { value: "bird", label: "birds" },
    ];
    const ticks = Array.from({ length: 21 }, (_, i) => {
      const major = i % 5 === 0;
      return `<div class="radio-tick" style="left:${(i / 20) * 100}%;height:${major ? 8 : 4}px"></div>`;
    }).join("");
    const channelButtons = channels
      .map(
        (c) =>
          `<button type="button" class="radio-channel" data-channel="${escapeHtml(c.value)}">${escapeHtml(c.label)}</button>`
      )
      .join("");

    controls.innerHTML = `
      <div class="radio-brand">
        <span class="radio-name">dinosaurus</span>
        <button type="button" class="radio-power" aria-pressed="false" aria-label="toggle music" title="music">
          <svg class="radio-power-pause" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="2" y="1.5" width="2" height="7" fill="currentColor"></rect>
            <rect x="6" y="1.5" width="2" height="7" fill="currentColor"></rect>
          </svg>
          <svg class="radio-power-play" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2.5 1.5 L8.5 5 L2.5 8.5 Z" fill="currentColor"></path>
          </svg>
        </button>
      </div>
      <div class="radio-top">
        <span class="radio-freq">
          <span class="radio-freq-num">88.0</span><span class="radio-mhz">MHz</span>
        </span>
        <span class="radio-live" aria-live="polite">off</span>
      </div>
      <div class="radio-dial"
           role="slider"
           tabindex="0"
           aria-label="channel"
           aria-valuemin="0"
           aria-valuemax="${channels.length - 1}"
           aria-valuenow="0">
        ${ticks}
        <div class="radio-needle" aria-hidden="true"></div>
      </div>
      <div class="radio-channels" role="tablist" aria-label="channel">
        ${channelButtons}
      </div>
    `;

    const power = controls.querySelector<HTMLButtonElement>(".radio-power")!;
    const liveEl = controls.querySelector<HTMLSpanElement>(".radio-live")!;
    const dial = controls.querySelector<HTMLDivElement>(".radio-dial")!;
    const needle = controls.querySelector<HTMLDivElement>(".radio-needle")!;
    const freqNum = controls.querySelector<HTMLSpanElement>(".radio-freq-num")!;
    const channelEls = Array.from(
      controls.querySelectorAll<HTMLButtonElement>(".radio-channel")
    );
    this.radioStatusEl = liveEl;

    const lastIdx = Math.max(1, channels.length - 1);
    const applyChannel = (value: RadioChannel) => {
      const idx = Math.max(0, channels.findIndex((c) => c.value === value));
      const pos = idx / lastIdx;
      needle.style.left = `calc(${(pos * 100).toFixed(2)}% - 1.5px)`;
      // Frequency reads like a real dial: ~88 MHz at "all", 0.4 MHz per channel.
      freqNum.textContent = (88.0 + idx * 0.4).toFixed(1);
      for (const btn of channelEls) {
        btn.dataset.active = btn.dataset.channel === value ? "true" : "false";
        btn.setAttribute("aria-selected", btn.dataset.active);
      }
      dial.setAttribute("aria-valuenow", String(idx));
      dial.setAttribute("aria-valuetext", channels[idx].label);
    };
    applyChannel(this.radioPrefs.channel);

    for (const btn of channelEls) {
      btn.addEventListener("click", () => {
        const value = sanitizeRadioChannel(btn.dataset.channel ?? "all");
        applyChannel(value);
        this.setRadioPreferences({ channel: value, pace: "normal" });
      });
    }

    power.addEventListener("click", async () => {
      const enabled = await this.radioAudio.toggleMusic(this.radioPrefs.channel);
      power.setAttribute("aria-pressed", String(enabled));
      controls.dataset.playing = String(enabled);
      this.setRadioStatus(enabled ? "live" : "off");
    });

    // Draggable dial — pointer x maps to the nearest channel snap point. The
    // visual needle / freq / active button update live during drag so the
    // user sees what they'd land on, but we only commit (and re-tune the
    // server feed) on release to avoid churn.
    const channelAt = (clientX: number): { idx: number; value: RadioChannel } => {
      const rect = dial.getBoundingClientRect();
      const t = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
      const idx = Math.max(0, Math.min(lastIdx, Math.round(t * lastIdx)));
      return { idx, value: channels[idx].value };
    };
    let dragging = false;
    let pendingValue: RadioChannel | null = null;
    const onDialDown = (ev: PointerEvent) => {
      if (ev.button !== 0 && ev.pointerType === "mouse") return;
      ev.preventDefault();
      dragging = true;
      controls.dataset.dragging = "true";
      try {
        dial.setPointerCapture(ev.pointerId);
      } catch {
        /* older browsers without pointer capture — drag still works via move/up. */
      }
      const { value } = channelAt(ev.clientX);
      pendingValue = value;
      applyChannel(value);
    };
    const onDialMove = (ev: PointerEvent) => {
      if (!dragging) return;
      const { value } = channelAt(ev.clientX);
      if (value !== pendingValue) {
        pendingValue = value;
        applyChannel(value);
      }
    };
    const endDrag = (ev: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      controls.dataset.dragging = "false";
      try {
        dial.releasePointerCapture(ev.pointerId);
      } catch {
        /* same as above. */
      }
      if (pendingValue && pendingValue !== this.radioPrefs.channel) {
        this.setRadioPreferences({ channel: pendingValue, pace: "normal" });
      }
      pendingValue = null;
    };
    dial.addEventListener("pointerdown", onDialDown);
    dial.addEventListener("pointermove", onDialMove);
    dial.addEventListener("pointerup", endDrag);
    dial.addEventListener("pointercancel", endDrag);

    // Keyboard: arrows step one channel, home/end jump to ends. Mirrors the
    // ARIA slider role so screen readers can drive the same control.
    dial.addEventListener("keydown", (ev) => {
      const curIdx = Math.max(
        0,
        channels.findIndex((c) => c.value === this.radioPrefs.channel)
      );
      let nextIdx = curIdx;
      switch (ev.key) {
        case "ArrowLeft":
        case "ArrowDown":
          nextIdx = Math.max(0, curIdx - 1);
          break;
        case "ArrowRight":
        case "ArrowUp":
          nextIdx = Math.min(lastIdx, curIdx + 1);
          break;
        case "Home":
          nextIdx = 0;
          break;
        case "End":
          nextIdx = lastIdx;
          break;
        default:
          return;
      }
      ev.preventDefault();
      if (nextIdx === curIdx) return;
      const value = channels[nextIdx].value;
      applyChannel(value);
      this.setRadioPreferences({ channel: value, pace: "normal" });
    });

    this.stage.appendChild(controls);
  }

  private setRadioPreferences(next: RadioPreferences): void {
    this.radioPrefs = next;
    saveRadioPreferences(next);
    for (const [id, item] of this.pendingItems) {
      if (!this.matchesRadio(item)) this.pendingItems.delete(id);
    }
    for (const msg of [...this.messages.values()]) {
      if (!this.matchesRadio(msg)) {
        if (msg.state === "claimed" || msg.state === "carried") {
          this.sendRealtime({ type: "release", id: msg.id });
        }
        this.cullActiveItem(msg.id);
      }
    }
    this.nextSpawnAt = performance.now() + spawnGapForPace(next.pace, this.pendingItems.size);
    this.radioAudio.tune(next.channel);
    this.onRadioChange?.(next);
    this.sendRealtime({ type: "set_preferences", preferences: this.realtimePreferences() });
  }

  private setRadioStatus(text: string): void {
    if (this.radioStatusEl) this.radioStatusEl.textContent = text;
  }

  /**
   * Legacy SSE fallback. Realtime WebSocket is the authoritative path; this
   * keeps older deployments and browsers from going completely quiet.
   */
  private connectEventStream(): void {
    if (!ARCHIVE_API_URL || typeof EventSource === "undefined") return;
    try {
      const es = new EventSource(`${ARCHIVE_API_URL}/events`);
      es.onmessage = (ev) => this.dispatchServerEvent(ev.data);
      es.onerror = () => this.warnArchiveSync("EventSource /events failed; using polling fallback");
    } catch (err) {
      this.warnArchiveSync("EventSource /events could not start", err);
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
    const obj = data as {
      type?: string;
      clientId?: unknown;
      bins?: unknown;
      active?: unknown;
      preferences?: unknown;
      item?: unknown;
      id?: unknown;
      ids?: unknown;
      reason?: unknown;
    };
    switch (obj.type) {
      case "hello":
        if (typeof obj.clientId === "string") this.clientId = obj.clientId;
        return;
      case "preferences_updated":
        this.applyActiveItems(obj.active);
        return;
      case "snapshot":
        this.applySnapshot(obj.bins);
        this.applyActiveItems(obj.active);
        return;
      case "add": {
        const item = sanitizeDeliveredItem(obj.item);
        if (item) this.applyAddedItem(item);
        return;
      }
      case "item_spawned":
      case "item":
        this.enqueueItem(obj.item);
        return;
      case "item_claimed":
        if (typeof obj.id === "string" && obj.clientId !== this.clientId) this.cullActiveItem(obj.id);
        return;
      case "item_released":
        this.enqueueItem(obj.item);
        return;
      case "item_delivered": {
        const item = sanitizeDeliveredItem(obj.item);
        if (item) this.applyAddedItem(item);
        return;
      }
      case "claim_rejected":
      case "deliver_rejected":
        if (typeof obj.id === "string") this.cullActiveItem(obj.id);
        return;
      case "expire":
      case "items_expired":
        if (Array.isArray(obj.ids)) {
          this.applyExpiredIds(obj.ids.filter((x): x is string => typeof x === "string"));
        }
        return;
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
      if (!resp.ok) {
        this.warnArchiveSync(`POST /archive returned ${resp.status}`);
        return;
      }
      const data = (await resp.json()) as { ok?: boolean; item?: unknown; bins?: unknown };
      if (data?.bins) {
        // Older server flavour — apply the full snapshot.
        this.applySnapshot(data.bins);
      } else if (data?.item) {
        const cleaned = sanitizeDeliveredItem(data.item);
        if (cleaned) this.applyAddedItem(cleaned);
      }
    } catch (err) {
      this.warnArchiveSync("POST /archive failed", err);
      // Optimistic update already applied; ignore network failures.
    }
  }

  private warnArchiveSync(message: string, err?: unknown): void {
    if (this.archiveWarningShown) return;
    this.archiveWarningShown = true;
    console.warn(
      `[dinosaurus] shared archive unavailable (${message}). Check VITE_ARCHIVE_URL and ALLOWED_ORIGINS.`,
      err ?? ""
    );
  }

  private enqueueItem(raw: unknown): void {
    const item = sanitizeContentItem(raw);
    if (!item) return;
    if (!this.binFor(item.kind)) return;
    if (!this.matchesRadio(item)) return;
    if (this.messages.has(item.id) || this.pendingItems.has(item.id) || this.isInArchive(item.id)) {
      return;
    }
    this.pendingItems.set(item.id, item);
  }

  private applyActiveItems(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    for (const item of raw) this.enqueueItem(item);
  }

  private drainPending(now: number): void {
    this.notifyBacklogPressure(now);
    if (now < this.nextSpawnAt) return;
    if (this.messages.size >= this.maxConcurrent) return;
    for (const [id, item] of this.pendingItems) {
      if (this.isInArchive(id) || !this.binFor(item.kind)) {
        this.pendingItems.delete(id);
        continue;
      }
      const spawned = this.spawn(item);
      if (spawned) {
        this.pendingItems.delete(id);
        this.nextSpawnAt = now + spawnGapForPace(this.radioPrefs.pace, this.pendingItems.size);
      }
      return;
    }
  }

  private notifyBacklogPressure(now: number): void {
    if (this.pendingItems.size < 6) return;
    if (now - this.lastBacklogWarningAt <= 8_000) return;
    this.lastBacklogWarningAt = now;
    this.radioAudio.warn();
    this.onBacklogPressure?.(this.pendingItems.size);
  }

  private matchesRadio(item: { kind: ContentKind }): boolean {
    return this.radioPrefs.channel === "all" || item.kind === this.radioPrefs.channel;
  }

  private cullActiveItem(id: string): void {
    this.pendingItems.delete(id);
    const msg = this.messages.get(id);
    if (!msg || msg.state === "delivering" || msg.state === "gone") return;
    msg.state = "gone";
    msg.el.remove();
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
    updateBinCountUI(bin);
    if (!wasPresent) bumpBin(bin);
    if (this.archiveOverlay) this.archiveOverlay.refreshIfShowing(bin);
    // Server delivery is authoritative. If another client sorted this card
    // while our dino was still approaching/carrying it, cancel our local copy.
    this.cullActiveItem(item.id);
  }

  private applyExpiredIds(ids: string[]): void {
    if (ids.length === 0) return;
    const set = new Set(ids);
    for (const id of set) this.cullActiveItem(id);
    for (const bin of this.bins) {
      const before = bin.delivered.length;
      bin.delivered = bin.delivered.filter((d) => !set.has(d.id));
      if (bin.delivered.length !== before) {
        bin.count = bin.delivered.length;
        updateBinCountUI(bin);
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
      // Locally-synthesised pattern cards are preserved — the server doesn't
      // know about them and would otherwise wipe them on every snapshot.
      const localOnly = bin.delivered.filter((d) => isSyntheticPatternId(d.id));
      bin.delivered = [...localOnly, ...list];
      pruneExpired(bin);
      bin.count = bin.delivered.length;
      updateBinCountUI(bin);
      if (bin.count > before) bumpBin(bin);
      if (this.archiveOverlay) this.archiveOverlay.refreshIfShowing(bin);
    }
    // If a refresh reveals that something currently active is already in the
    // shared archive, server/archive state wins and the local task is canceled.
    for (const m of [...this.messages.values()]) {
      if (this.isInArchive(m.id)) this.cullActiveItem(m.id);
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
  private readonly iconEl: HTMLSpanElement;
  private readonly titleEl: HTMLSpanElement;
  private readonly countEl: HTMLSpanElement;
  private readonly searchEl: HTMLInputElement;
  private readonly listEl: HTMLDivElement;
  private readonly emptyEl: HTMLDivElement;
  private currentBin: CategoryBin | null = null;
  private searchQuery = "";
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
        <span class="archive__icon" aria-hidden="true"></span>
        <span class="archive__title"></span>
        <span class="archive__count"></span>
        <input
          type="search"
          class="archive__search"
          placeholder="filter…"
          aria-label="Filter items"
          autocomplete="off"
          spellcheck="false"
        />
        <button type="button" class="archive__close" aria-label="Close archive">×</button>
      </div>
      <div class="archive__list" role="list"></div>
      <div class="archive__empty"></div>
    `;
    this.iconEl = this.panel.querySelector<HTMLSpanElement>(".archive__icon")!;
    this.titleEl = this.panel.querySelector<HTMLSpanElement>(".archive__title")!;
    this.countEl = this.panel.querySelector<HTMLSpanElement>(".archive__count")!;
    this.searchEl = this.panel.querySelector<HTMLInputElement>(".archive__search")!;
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

    this.searchEl.addEventListener("input", () => {
      this.searchQuery = this.searchEl.value.trim().toLowerCase();
      if (this.currentBin) this.render(this.currentBin);
    });

    this.onKey = (e) => {
      if (e.key === "Escape" && this.currentBin) {
        // First Escape just clears a non-empty filter; a second one closes.
        if (this.searchQuery) {
          this.searchEl.value = "";
          this.searchQuery = "";
          this.render(this.currentBin);
          return;
        }
        this.hide();
      }
    };
  }

  show(bin: CategoryBin): void {
    // Switching to a different bin starts with a fresh filter.
    if (this.currentBin !== bin) {
      this.searchQuery = "";
      this.searchEl.value = "";
      this.listEl.scrollTop = 0;
    }
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
    this.iconEl.textContent = kindIcon(bin.kind);
    this.titleEl.textContent = bin.label;
    this.panel.dataset.kind = bin.kind;

    // Newest first regardless of how items got into the array (server snapshots
    // and local pushes can interleave). Cheap on a few hundred items.
    const sorted = bin.delivered.slice().sort((a, b) => b.deliveredAt - a.deliveredAt);
    const visible = this.searchQuery
      ? sorted.filter((it) => it.text.toLowerCase().includes(this.searchQuery))
      : sorted;

    this.countEl.textContent = this.searchQuery
      ? `${visible.length} of ${sorted.length}`
      : `${sorted.length} item${sorted.length === 1 ? "" : "s"}`;

    if (visible.length === 0) {
      this.listEl.innerHTML = "";
      this.emptyEl.textContent = this.searchQuery
        ? `// no matches for "${this.searchQuery}"`
        : "// nothing here yet — dino hasn't sorted anything into this bin.";
      this.emptyEl.style.display = "";
      return;
    }
    this.emptyEl.style.display = "none";

    // Group by time bucket so 24h of items doesn't read as a wall of text.
    const groups = groupByBucket(visible);
    this.listEl.innerHTML = groups
      .map((g) => {
        const itemsHtml = g.items
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
                <div class="archive__body">${escapeHtml(highlightMatches(item.text, this.searchQuery))}</div>
                ${link}
              </article>
            `;
          })
          .join("");
        return `
          <div class="archive__group-head">
            <span class="archive__group-label">${escapeHtml(g.label)}</span>
            <span class="archive__group-count">${g.items.length}</span>
          </div>
          ${itemsHtml}
        `;
      })
      .join("");
  }
}

/**
 * Group items into "Last hour", "Earlier today", "Yesterday", "Older" buckets.
 * Buckets are returned newest-first, with empty ones omitted.
 */
function groupByBucket(items: DeliveredItem[]): Array<{ label: string; items: DeliveredItem[] }> {
  const order = ["Last hour", "Earlier today", "Yesterday", "Older"];
  const map = new Map<string, DeliveredItem[]>();
  for (const item of items) {
    const label = bucketLabel(item.deliveredAt);
    let arr = map.get(label);
    if (!arr) {
      arr = [];
      map.set(label, arr);
    }
    arr.push(item);
  }
  return order.filter((k) => map.has(k)).map((k) => ({ label: k, items: map.get(k)! }));
}

function bucketLabel(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 3_600_000) return "Last hour";
  const now = new Date();
  const then = new Date(ms);
  if (sameLocalDay(now, then)) return "Earlier today";
  const yest = new Date(now);
  yest.setDate(yest.getDate() - 1);
  if (sameLocalDay(yest, then)) return "Yesterday";
  return "Older";
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Wrap any `<mark>`-able substrings around the active search query. */
function highlightMatches(text: string, query: string): string {
  const escaped = escapeHtml(text);
  if (!query) return escaped;
  // Re-escape the query and turn it into a case-insensitive regex.
  const safe = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return escaped.replace(new RegExp(safe, "gi"), (m) => `<mark class="archive__hit">${m}</mark>`);
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

/** Two-digit zero-padded count for tidy bin tickers ("00", "07", "42"). */
function formatBinCount(n: number): string {
  return n < 100 ? String(n).padStart(2, "0") : String(n);
}

/** Refresh the bin's visible count + empty-state styling. */
function updateBinCountUI(bin: CategoryBin): void {
  bin.countEl.textContent = formatBinCount(bin.count);
  bin.el.dataset.empty = bin.count === 0 ? "true" : "false";
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
    case "space":
      return "space";
    case "bird":
      return "bird";
  }
}

function kindIcon(kind: ContentKind): string {
  switch (kind) {
    case "news":
      return "▤";
    case "weather":
      return "⛅";
    case "fact":
      return "❍";
    case "thought":
      return "✦";
    case "quake":
      return "↯";
    case "history":
      return "⧗";
    case "space":
      return "☄";
    case "bird":
      return "Λ";
  }
}

/** Source-style suffix for the card's footer stamp. */
function stampLabelFor(kind: ContentKind): string {
  switch (kind) {
    case "news":
      return "hn";
    case "quake":
      return "usgs";
    case "history":
      return "on this day";
    case "fact":
      return "field note";
    case "thought":
      return "scratch";
    case "space":
      return "nasa";
    case "bird":
      return "ebird";
    case "weather":
      return "open-meteo";
  }
}

// ── Pattern detection helpers ────────────────────────────────────────────

/** Synthetic pattern-card ids carry this prefix so the rest of the system
 *  can recognise them and skip server sync / preserve across snapshots. */
const SYNTHETIC_PATTERN_PREFIX = "__pattern__:";
function isSyntheticPatternId(id: string): boolean {
  return id.startsWith(SYNTHETIC_PATTERN_PREFIX);
}

const STOP_WORDS = new Set([
  // articles + conjunctions
  "the", "and", "but", "nor", "yet", "for",
  // prepositions
  "of", "to", "in", "on", "at", "by", "from", "with", "about", "into", "onto",
  "upon", "over", "under", "after", "before", "since", "during", "between",
  "through", "via", "per", "off", "out",
  // common verbs / aux
  "is", "are", "was", "were", "be", "been", "being",
  "has", "have", "had",
  "do", "does", "did",
  "will", "would", "should", "could", "may", "might", "must", "can",
  "say", "says", "said", "told", "make", "made", "get", "got", "gets",
  "see", "saw", "seen", "look", "took", "take", "give", "gave", "use", "used",
  // pronouns
  "you", "your", "yours", "our", "ours",
  "his", "her", "hers", "its", "they", "them", "their", "theirs",
  // demonstratives + interrogatives
  "this", "that", "these", "those",
  "what", "when", "where", "why", "how", "who", "whom", "which", "whose",
  // common modifiers / fillers
  "not", "yes", "all", "any", "some", "many", "much", "more", "most",
  "less", "least", "few", "very", "too", "just", "also", "only", "even",
  "still", "than", "then", "now", "here", "there", "ever", "never", "always",
  "often", "again", "back", "such",
  "though", "although", "because", "however", "instead", "while", "until",
  "well", "way", "ways", "thing", "things",
  "year", "years", "today", "yesterday", "tomorrow", "day", "days",
  "time", "times", "new", "old",
  // numbers spelled
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
]);

/** Tokenize text into deduped, normalised content words (excludes stop words
 *  and pure-numeric tokens). */
function patternTokens(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOP_WORDS.has(raw)) continue;
    if (/^\d+$/.test(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/** Find the word that appears in the most distinct items in the buffer. */
function findTopKeyword(
  items: Array<{ text: string }>
): { word: string; docCount: number } | null {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const tok of patternTokens(item.text)) {
      counts.set(tok, (counts.get(tok) ?? 0) + 1);
    }
  }
  let best = "";
  let bestCount = 0;
  for (const [w, c] of counts) {
    // Tiebreaker: prefer the longer word — usually carries more meaning.
    if (c > bestCount || (c === bestCount && w.length > best.length)) {
      best = w;
      bestCount = c;
    }
  }
  return best ? { word: best, docCount: bestCount } : null;
}

/** Pick a slightly varied phrasing so the dino's "noticing" doesn't feel
 *  canned when it fires more than once a session. */
function patternPhrase(word: string, count: number, kind: ContentKind): string {
  const W = word.charAt(0).toUpperCase() + word.slice(1);
  const k = kindLabel(kind);
  const phrases = [
    `${W} keeps coming up — ${count} ${k} items mention it`,
    `everyone's talking about ${W} (${count}× in ${k})`,
    `${W} is having a moment`,
    `pattern: ${W} ×${count}`,
    `is it just me, or is ${W} everywhere today?`,
    `the ${k} keeps saying ${W}`,
    `noticing: ${W} in ${count} ${k} items`,
  ];
  return phrases[Math.floor(Math.random() * phrases.length)];
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

function wsBaseUrl(httpBase: string): string {
  const url = new URL(httpBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(/\/$/, "");
}

function loadRadioPreferences(): RadioPreferences {
  try {
    const raw = window.localStorage.getItem(RADIO_STORAGE_KEY);
    if (!raw) return { channel: "all", pace: "normal" };
    const parsed = JSON.parse(raw) as Partial<RadioPreferences>;
    return {
      channel: sanitizeRadioChannel(parsed.channel),
      pace: sanitizeRadioPace(parsed.pace),
    };
  } catch {
    return { channel: "all", pace: "normal" };
  }
}

function saveRadioPreferences(prefs: RadioPreferences): void {
  try {
    window.localStorage.setItem(RADIO_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Preferences are nice-to-have; private browsing/storage failures are fine.
  }
}

function sanitizeRadioChannel(value: unknown): RadioChannel {
  return value === "all" || RADIO_CHANNELS.includes(value as (typeof RADIO_CHANNELS)[number])
    ? (value as RadioChannel)
    : "all";
}

function sanitizeRadioPace(value: unknown): RadioPace {
  return value === "chill" || value === "busy" || value === "normal" ? value : "normal";
}

function spawnGapForPace(pace: RadioPace, backlog = 0): number {
  const pressureMultiplier = backlog >= 6 ? 1.8 : backlog >= 3 ? 1.25 : 1;
  switch (pace) {
    case "chill":
      return CARD_SPAWN_GAP_MS * 2 * pressureMultiplier;
    case "busy":
      return Math.round(CARD_SPAWN_GAP_MS * 0.5 * pressureMultiplier);
    case "normal":
      return CARD_SPAWN_GAP_MS * pressureMultiplier;
  }
}

class RadioAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private hum: OscillatorNode | null = null;
  private musicGain: GainNode | null = null;
  private track: HTMLAudioElement | null = null;
  /** Stable id of the current track — Subsonic song id when sourced from
   *  the archive server, or the URL itself for local-fallback picks.
   *  Sent as the `avoid` parameter so the server doesn't re-pick it. */
  private currentTrackId: string | null = null;
  /** `ended` handler we attach so chained playback survives src changes. */
  private trackEndedHandler: (() => void) | null = null;
  private staticTimer: number | null = null;
  private musicTimer: number | null = null;
  private musicStep = 0;
  private musicChannel: RadioChannel = "all";
  private enabled = false;
  private musicEnabled = false;

  async toggle(channel: RadioChannel): Promise<boolean> {
    if (this.enabled) {
      this.stop();
      return false;
    }
    await this.start(channel);
    return this.enabled;
  }

  async toggleMusic(channel: RadioChannel): Promise<boolean> {
    if (this.musicEnabled) {
      this.stopMusic();
      return false;
    }
    const trackStarted = await this.startTrack(channel);
    if (trackStarted) return true;
    await this.ensureStarted(channel);
    this.startMusic(channel);
    return this.musicEnabled;
  }

  tune(channel: RadioChannel): void {
    this.musicChannel = channel;
    if (this.musicEnabled && this.track) void this.switchTrack(channel);
    if (!this.ctx) return;
    if (this.enabled && this.hum) {
      this.hum.frequency.setTargetAtTime(channelFrequency(channel), this.ctx.currentTime, 0.04);
      this.staticBurst(0.16, 0.018);
    }
  }

  item(kind: ContentKind): void {
    if (!this.enabled || !this.ctx || !this.master) return;
    const now = this.ctx.currentTime;
    this.beep(kindFrequency(kind), now, 0.055);
    this.beep(kindFrequency(kind) * 1.5, now + 0.08, 0.05);
  }

  warn(): void {
    if (!this.enabled) return;
    this.staticBurst(0.28, 0.035);
  }

  private async start(channel: RadioChannel): Promise<void> {
    await this.ensureStarted(channel);
    if (!this.ctx || !this.master) return;
    if (this.hum) {
      this.enabled = true;
      return;
    }
    const hum = this.ctx.createOscillator();
    hum.type = "triangle";
    hum.frequency.value = channelFrequency(channel);
    hum.connect(this.master);
    hum.start();

    this.hum = hum;
    this.enabled = true;
    this.staticTimer = window.setInterval(() => this.staticBurst(0.08, 0.008), 3_500);
    this.tune(channel);
  }

  private async ensureStarted(channel: RadioChannel): Promise<void> {
    this.musicChannel = channel;
    if (this.ctx && this.master) {
      await this.ctx.resume();
      return;
    }
    const AudioCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return;
    const ctx = new AudioCtor();
    await ctx.resume();
    const master = ctx.createGain();
    master.gain.value = 0.025;
    master.connect(ctx.destination);

    this.ctx = ctx;
    this.master = master;
  }

  private stop(): void {
    if (this.staticTimer !== null) window.clearInterval(this.staticTimer);
    this.staticTimer = null;
    this.hum?.stop();
    this.hum = null;
    this.enabled = false;
    if (!this.musicEnabled) this.closeIfSilent();
  }

  private startMusic(channel: RadioChannel): void {
    if (!this.ctx || this.musicEnabled) return;
    this.musicChannel = channel;
    const gain = this.ctx.createGain();
    gain.gain.value = 0.08;
    gain.connect(this.ctx.destination);
    this.musicGain = gain;
    this.musicEnabled = true;
    this.musicStep = 0;
    this.musicTimer = window.setInterval(() => this.playMusicStep(), 280);
    this.playMusicStep();
  }

  private stopMusic(): void {
    if (this.musicTimer !== null) window.clearInterval(this.musicTimer);
    this.musicTimer = null;
    if (this.track) {
      this.track.pause();
      if (this.trackEndedHandler) {
        this.track.removeEventListener("ended", this.trackEndedHandler);
      }
      this.track = null;
    }
    this.trackEndedHandler = null;
    this.currentTrackId = null;
    this.musicGain?.disconnect();
    this.musicGain = null;
    this.musicEnabled = false;
    this.closeIfSilent();
  }

  private async startTrack(channel: RadioChannel): Promise<boolean> {
    const pick = await fetchTrack(channel, null);
    if (!pick) return false;
    const audio = new Audio(pick.url);
    // No `loop` — we chain a fresh random track on `ended` instead, so the
    // listener gets variety inside a channel.
    audio.volume = 0.42;
    audio.preload = "auto";
    const onEnded = () => this.playNextRandom();
    audio.addEventListener("ended", onEnded);
    try {
      await audio.play();
      this.track = audio;
      this.currentTrackId = pick.id;
      this.trackEndedHandler = onEnded;
      this.musicEnabled = true;
      this.musicChannel = channel;
      return true;
    } catch {
      audio.removeEventListener("ended", onEnded);
      return false;
    }
  }

  /** Swap the playing track for a fresh random pick from the new channel. */
  private async switchTrack(channel: RadioChannel): Promise<void> {
    if (!this.track) return;
    const pick = await fetchTrack(channel, this.currentTrackId);
    if (!pick) return;
    const absolute = new URL(pick.url, window.location.href).href;
    if (this.track.src === absolute) return;
    this.track.src = pick.url;
    this.currentTrackId = pick.id;
    try {
      await this.track.play();
    } catch {
      this.stopMusic();
      await this.toggleMusic(channel);
    }
  }

  /** Called when the current track ends — pick another random one in the
   *  same channel (different track than the one that just ended when
   *  there's a choice) and start playing. */
  private async playNextRandom(): Promise<void> {
    if (!this.musicEnabled || !this.track) return;
    const pick = await fetchTrack(this.musicChannel, this.currentTrackId);
    if (!pick) {
      this.stopMusic();
      return;
    }
    this.track.src = pick.url;
    this.currentTrackId = pick.id;
    try {
      await this.track.play();
    } catch {
      this.stopMusic();
    }
  }

  private closeIfSilent(): void {
    if (this.enabled || this.musicEnabled) return;
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }

  private beep(freq: number, startAt: number, duration: number): void {
    if (!this.ctx || !this.master) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(0.045, startAt + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    osc.connect(gain).connect(this.master);
    osc.start(startAt);
    osc.stop(startAt + duration + 0.02);
  }

  private playMusicStep(): void {
    if (!this.ctx || !this.musicGain) return;
    const scale = channelScale(this.musicChannel);
    const freq = scale[this.musicStep % scale.length];
    const now = this.ctx.currentTime;
    this.musicNote(freq, now, 0.22);
    if (this.musicStep % 4 === 0) this.musicNote(freq / 2, now, 0.28, "triangle", 0.45);
    this.musicStep += 1;
  }

  private musicNote(
    freq: number,
    startAt: number,
    duration: number,
    type: OscillatorType = "sine",
    level = 1
  ): void {
    if (!this.ctx || !this.musicGain) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(0.18 * level, startAt + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    osc.connect(gain).connect(this.musicGain);
    osc.start(startAt);
    osc.stop(startAt + duration + 0.03);
  }

  private staticBurst(duration: number, gainValue: number): void {
    if (!this.ctx || !this.master) return;
    const length = Math.max(1, Math.floor(this.ctx.sampleRate * duration));
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    const source = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    gain.gain.value = gainValue;
    source.buffer = buffer;
    source.connect(gain).connect(this.master);
    source.start();
  }
}

function channelFrequency(channel: RadioChannel): number {
  switch (channel) {
    case "news":
      return 132;
    case "quake":
      return 98;
    case "history":
      return 116;
    case "fact":
      return 148;
    case "thought":
      return 174;
    case "space":
      return 88;
    case "bird":
      return 196;
    case "all":
      return 122;
  }
}

function kindFrequency(kind: ContentKind): number {
  return channelFrequency(kind === "weather" ? "all" : kind);
}

function channelScale(channel: RadioChannel): number[] {
  const root = channelFrequency(channel) * 2;
  switch (channel) {
    case "news":
      return [root, root * 1.25, root * 1.5, root * 2, root * 1.5, root * 1.25];
    case "quake":
      return [root, root * 1.2, root * 1.33, root * 1.6, root * 1.33, root * 1.2];
    case "history":
      return [root, root * 1.125, root * 1.5, root * 1.875, root * 1.5, root * 1.125];
    case "fact":
      return [root, root * 1.25, root * 1.5, root * 1.875, root * 1.5, root * 1.25];
    case "thought":
      return [root, root * 1.2, root * 1.5, root * 1.8, root * 1.5, root * 1.2];
    case "space":
      // Wider, slower-feeling intervals — more "drift" in the synth scale.
      return [root, root * 1.5, root * 2, root * 3, root * 2, root * 1.5];
    case "bird":
      // Bright, chirpy — narrow steps with a quick upward run.
      return [root, root * 1.125, root * 1.33, root * 1.5, root * 1.66, root * 2];
    case "all":
      return [root, root * 1.25, root * 1.5, root * 2, root * 1.5, root * 1.125];
  }
}

interface RadioPick {
  /** Stable identifier — Subsonic song id from the archive server, or the
   *  URL itself for local-fallback picks. Used to avoid replays. */
  id: string;
  /** Absolute or root-relative URL playable in an HTMLAudioElement. */
  url: string;
}

/**
 * Resolve a random track for the given channel. Tries the archive server's
 * Navidrome-backed `/radio/track` endpoint first; if that's unreachable
 * (offline dev, archive down, navidrome not configured) falls back to the
 * static manifest baked in at build time. When `avoid` is supplied and a
 * choice exists, the result is guaranteed to differ.
 */
async function fetchTrack(
  channel: RadioChannel,
  avoid: string | null
): Promise<RadioPick | undefined> {
  if (ARCHIVE_API_URL) {
    try {
      const params = new URLSearchParams({ channel });
      if (avoid) params.set("avoid", avoid);
      const resp = await fetch(`${ARCHIVE_API_URL}/radio/track?${params}`, {
        cache: "no-store",
      });
      if (resp.ok) {
        const body = (await resp.json()) as {
          id?: unknown;
          url?: unknown;
        };
        if (typeof body.id === "string" && typeof body.url === "string") {
          // Server returns a root-relative path like /radio/stream/<id>.
          // Resolve against the archive origin so the audio element loads
          // from the right host even when the page is on a different one.
          const absolute = new URL(body.url, ARCHIVE_API_URL).href;
          return { id: body.id, url: absolute };
        }
      }
    } catch {
      // Network / CORS / archive down — fall through to local manifest.
    }
  }
  return pickLocalTrack(channel, avoid);
}

/** Static manifest pick — used for offline dev and as a server fallback. */
function pickLocalTrack(channel: RadioChannel, avoid: string | null): RadioPick | undefined {
  const folder = RADIO_FOLDER[channel];
  let pool = RADIO_MANIFEST[folder] ?? [];
  if (pool.length === 0 && folder !== RADIO_FOLDER.all) {
    pool = RADIO_MANIFEST[RADIO_FOLDER.all] ?? [];
  }
  if (pool.length === 0) return undefined;
  if (pool.length === 1) return { id: pool[0], url: pool[0] };
  const candidates = avoid ? pool.filter((t) => t !== avoid) : pool;
  const list = candidates.length > 0 ? candidates : pool;
  const url = list[Math.floor(Math.random() * list.length)];
  return { id: url, url };
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
      width: clamp(200px, 22vw, 240px);
      padding: 14px 14px 10px;
      background: var(--paper, #1f1e26);
      color: var(--ink, #e8e4d8);
      border: 1px solid rgba(232, 228, 216, 0.16);
      border-radius: 0;
      box-shadow: 0 6px 0 rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(0, 0, 0, 0.4);
      font: 400 12px/1.45 "Ioskeley Mono", ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
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
                  opacity 360ms ease,
                  filter 360ms ease;
      opacity: 0;
      filter: blur(0.4px);
    }

    /* Sticker tag overlapping the top-left edge — the card's source label. */
    .msg__tag {
      position: absolute;
      top: -10px;
      left: 12px;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 8px;
      background: var(--ink, #e8e4d8);
      color: var(--paper, #1f1e26);
      font-size: 10px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      font-weight: 600;
      line-height: 1.2;
    }
    .msg__tag-icon {
      font-size: 11px;
      letter-spacing: 0;
      transform: translateY(0.5px);
    }

    .msg__body {
      white-space: pre-wrap;
      word-break: break-word;
      padding-top: 4px;
    }

    .msg__stamp {
      margin-top: 8px;
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      color: var(--ink-soft, #8a8678);
      font-size: 10.5px;
      letter-spacing: 0.04em;
    }
    .msg__stamp-mark {
      opacity: 0.6;
    }

    /* Whole card becomes the link when an href exists — the .msg__link
       overlay sits on top, transparent, so click anywhere on the card opens. */
    .msg__link {
      position: absolute;
      inset: 0;
      text-indent: -9999px;
      overflow: hidden;
      color: transparent;
      background: transparent;
      text-decoration: none;
      border: 0;
    }
    .msg__link:focus-visible {
      outline: 2px solid var(--accent, var(--ink, #e8e4d8));
      outline-offset: 2px;
    }
    .msg:has(.msg__link:hover) .msg__stamp-mark { opacity: 1; color: var(--ink, #e8e4d8); }

    /* Per-kind accent colour. Applied to the sticker tag and stamp arrow. */
    .msg--news    { --accent: #ff9a73; }
    .msg--weather { --accent: #7ec8ff; }
    .msg--fact    { --accent: #8dd9a8; }
    .msg--thought { --accent: #c8a8ff; }
    .msg--quake   { --accent: #f3c969; }
    .msg--history { --accent: #d4a574; }
    .msg--space   { --accent: #9eb5ff; }
    .msg--bird    { --accent: #e0a8c0; }
    .msg .msg__tag { background: var(--accent, var(--ink, #e8e4d8)); }

    .radio-controls {
      position: absolute;
      left: 22px;
      top: 18px;
      width: 280px;
      max-width: calc(100vw - 44px);
      padding: 10px 14px;
      background: rgba(20, 20, 26, 0.86);
      color: var(--ink, #e8e4d8);
      border: 1px solid var(--ink-soft, #8a8678);
      border-radius: 0;
      font: 400 11px/1.3 "Ioskeley Mono", ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      z-index: 5;
    }

    .radio-brand {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
      padding-bottom: 8px;
      border-bottom: 1px solid rgba(232, 228, 216, 0.18);
      font-size: 13px;
      letter-spacing: 0.04em;
    }
    .radio-power {
      width: 18px;
      height: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: 1px solid var(--ink-soft, #8a8678);
      color: var(--ink-soft, #8a8678);
      padding: 0;
      cursor: pointer;
      transition: color 0.15s ease, border-color 0.15s ease;
    }
    .radio-power:hover { color: #d97758; border-color: #d97758; }
    .radio-controls[data-playing="true"] .radio-power { color: var(--ink, #e8e4d8); }
    .radio-power-pause { display: none; }
    .radio-power-play  { display: block; }
    .radio-controls[data-playing="true"] .radio-power-pause { display: block; }
    .radio-controls[data-playing="true"] .radio-power-play  { display: none; }

    .radio-top {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 8px;
    }
    .radio-freq {
      font-size: 17px;
      font-variant-numeric: tabular-nums;
    }
    .radio-mhz {
      font-size: 10px;
      color: var(--ink-soft, #8a8678);
      margin-left: 4px;
    }
    .radio-live {
      font-size: 9.5px;
      color: var(--ink-soft, #8a8678);
      letter-spacing: 0.18em;
      text-transform: uppercase;
    }
    .radio-live::before {
      content: "● ";
      color: var(--ink-soft, #8a8678);
    }
    .radio-controls[data-playing="true"] .radio-live::before {
      color: #d97758;
      animation: radioBlink 1.6s ease-in-out infinite;
    }
    @keyframes radioBlink {
      0%, 100% { opacity: 1; }
      50%      { opacity: 0.45; }
    }

    .radio-dial {
      position: relative;
      height: 8px;
      background: rgba(232, 228, 216, 0.10);
      cursor: grab;
      /* Hit area is taller than the visible bar so the dial is easy to grab. */
      padding: 6px 0;
      margin: -6px 0;
      background-clip: content-box;
      touch-action: none;
      transition: opacity 0.25s ease;
    }
    .radio-controls[data-playing="false"] .radio-dial { opacity: 0.45; }
    .radio-controls[data-dragging="true"]  .radio-dial { cursor: grabbing; }
    .radio-dial:focus-visible {
      outline: 1px dashed var(--ink-soft, #8a8678);
      outline-offset: 4px;
    }
    .radio-tick {
      position: absolute;
      top: 6px;
      width: 1px;
      background: var(--ink-soft, #8a8678);
      pointer-events: none;
    }
    .radio-needle {
      position: absolute;
      top: 3px;
      width: 3px;
      height: 14px;
      background: var(--ink, #e8e4d8);
      pointer-events: none;
      transition: left 0.25s cubic-bezier(.5, 0, .2, 1.6);
    }
    /* While dragging, lose the snap-easing so the needle tracks the cursor. */
    .radio-controls[data-dragging="true"] .radio-needle { transition: none; }

    .radio-channels {
      display: flex;
      justify-content: space-between;
      flex-wrap: wrap;
      row-gap: 2px;
      column-gap: 2px;
      margin-top: 6px;
      font-size: 9px;
      color: var(--ink-soft, #8a8678);
      letter-spacing: 0;
    }
    .radio-channel {
      flex: 0 1 auto;
      min-width: 0;
      background: transparent;
      border: 0;
      padding: 0;
      margin: 0;
      cursor: pointer;
      color: var(--ink-soft, #8a8678);
      font: inherit;
      letter-spacing: inherit;
      white-space: nowrap;
      transition: color 0.15s ease;
    }
    .radio-channel[data-active="true"] { color: var(--ink, #e8e4d8); }
    .radio-channel:hover               { color: var(--ink, #e8e4d8); }
    .radio-channel:focus-visible {
      outline: 1px dashed var(--ink-soft, #8a8678);
      outline-offset: 2px;
    }

    .bin-row {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 24px;
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 10px;
      padding: 0 22px;
      pointer-events: none;
      z-index: 3;
    }

    .bin {
      pointer-events: auto;
      flex: 0 0 132px;
      padding: 10px 12px 28px;
      position: relative;
      background: var(--paper, #1f1e26);
      border: 1px solid rgba(232, 228, 216, 0.18);
      border-radius: 0;
      color: var(--ink, #e8e4d8);
      font: 400 10.5px/1.2 "Ioskeley Mono", ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
      text-align: left;
      cursor: pointer;
      transform-origin: 50% 100%;
      transition: border-color 160ms ease, transform 220ms cubic-bezier(.2,.7,.2,1.4);
    }
    .bin:hover { border-color: var(--ink-soft, #8a8678); transform: translateY(-1px); }
    .bin:focus-visible {
      outline: 1px solid var(--ink, #e8e4d8);
      outline-offset: 2px;
    }
    .bin[data-empty="true"] { opacity: 0.6; }
    .bin--bump { animation: binBump 360ms cubic-bezier(.2,.7,.2,1.4); }
    @keyframes binBump {
      0%   { transform: translateY(0) scale(1); }
      35%  { transform: translateY(-4px) scale(1.03); }
      100% { transform: translateY(0) scale(1); }
    }

    .bin__pulse {
      position: absolute;
      inset: -1px;
      border: 1px solid transparent;
      pointer-events: none;
      opacity: 0;
    }
    .bin--bump .bin__pulse {
      animation: binPulse 1.4s ease-out;
    }
    @keyframes binPulse {
      0%   { opacity: 0.9; transform: scale(1); border-color: var(--accent, #d97758); }
      100% { opacity: 0; transform: scale(1.12); border-color: var(--accent, #d97758); }
    }

    .bin__top {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
    }
    .bin__icon {
      font-size: 13px;
      letter-spacing: 0;
      text-transform: none;
      color: var(--ink, #e8e4d8);
    }
    .bin__count {
      font-size: 10px;
      color: var(--ink-soft, #8a8678);
      letter-spacing: 0;
      font-variant-numeric: tabular-nums;
    }
    .bin__label {
      font-size: 9px;
      color: var(--ink-soft, #8a8678);
      letter-spacing: 0.10em;
      text-transform: uppercase;
      margin-top: 4px;
    }
    .bin__lid {
      position: absolute;
      left: 8px;
      right: 8px;
      bottom: 8px;
      height: 16px;
      background: var(--bg, #14141a);
      border-top: 1px solid var(--ink-soft, #8a8678);
      overflow: hidden;
    }
    .bin__slot {
      position: absolute;
      left: 50%;
      top: 4px;
      transform: translateX(-50%);
      width: 36px;
      height: 2px;
      background: var(--bg, #14141a);
      box-shadow: inset 0 1px 0 rgba(0, 0, 0, 0.5);
    }

    .bin--news    { --accent: #ff9a73; }
    .bin--weather { --accent: #7ec8ff; }
    .bin--fact    { --accent: #8dd9a8; }
    .bin--thought { --accent: #c8a8ff; }
    .bin--quake   { --accent: #f3c969; }
    .bin--history { --accent: #d4a574; }
    .bin--space   { --accent: #9eb5ff; }
    .bin--bird    { --accent: #e0a8c0; }
    .bin:hover { border-color: var(--accent, var(--ink-soft, #8a8678)); }
    .bin:hover .bin__icon { color: var(--accent, var(--ink, #e8e4d8)); }

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
      width: min(620px, 100%);
      max-height: min(80vh, 720px);
      display: flex;
      flex-direction: column;
      background: var(--paper, #1f1e26);
      color: var(--ink, #e8e4d8);
      border: 1.5px solid var(--ink, #e8e4d8);
      border-radius: 3px;
      box-shadow: 0 14px 0 rgba(0, 0, 0, 0.35);
      transform: translateY(8px);
      transition: transform 200ms cubic-bezier(.2,.7,.2,1.4);
      font: 500 13px/1.5 "Ioskeley Mono", ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
    }
    .archive-backdrop--open .archive-panel { transform: translateY(0); }

    /* Per-kind accent — drives the top border, the head icon colour, and
       hover highlights. Match the card styling. */
    .archive-panel[data-kind="news"]    { --accent: #ff9a73; border-top: 4px solid var(--accent); }
    .archive-panel[data-kind="weather"] { --accent: #7ec8ff; border-top: 4px solid var(--accent); }
    .archive-panel[data-kind="fact"]    { --accent: #8dd9a8; border-top: 4px solid var(--accent); }
    .archive-panel[data-kind="thought"] { --accent: #c8a8ff; border-top: 4px solid var(--accent); }
    .archive-panel[data-kind="quake"]   { --accent: #f3c969; border-top: 4px solid var(--accent); }
    .archive-panel[data-kind="history"] { --accent: #d4a574; border-top: 4px solid var(--accent); }
    .archive-panel[data-kind="space"]   { --accent: #9eb5ff; border-top: 4px solid var(--accent); }
    .archive-panel[data-kind="bird"]    { --accent: #e0a8c0; border-top: 4px solid var(--accent); }

    .archive__head {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--ink-soft, #8a8678);
      flex-wrap: wrap;
    }
    .archive__icon {
      font-size: 14px;
      line-height: 1;
      color: var(--accent, var(--ink, #e8e4d8));
    }
    .archive__title {
      flex: 0 0 auto;
      font-weight: 700;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      font-size: 12px;
      color: var(--accent, var(--ink, #e8e4d8));
    }
    .archive__count {
      flex: 0 0 auto;
      color: var(--ink-soft, #8a8678);
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .archive__search {
      flex: 1 1 140px;
      min-width: 100px;
      background: var(--bg, #14141a);
      color: var(--ink, #e8e4d8);
      border: 1px solid var(--ink-soft, #8a8678);
      border-radius: 1px;
      padding: 5px 8px;
      font: inherit;
      font-size: 12px;
      letter-spacing: 0.04em;
      text-transform: none;
      outline: none;
    }
    .archive__search::placeholder {
      color: var(--ink-soft, #8a8678);
      opacity: 0.7;
    }
    .archive__search:focus {
      border-color: var(--accent, var(--ink, #e8e4d8));
    }
    /* Strip the native search clear cross (Webkit) — we have our own affordance. */
    .archive__search::-webkit-search-cancel-button { -webkit-appearance: none; appearance: none; }
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
      gap: 8px;
    }
    .archive__list::-webkit-scrollbar { width: 8px; }
    .archive__list::-webkit-scrollbar-thumb {
      background: var(--ink-soft, #8a8678);
      border-radius: 1px;
    }

    .archive__group-head {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin: 12px 0 2px;
      padding-bottom: 4px;
      border-bottom: 1px dashed rgba(138, 134, 120, 0.35);
      color: var(--ink-soft, #8a8678);
      font-size: 10px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
    }
    .archive__group-head:first-child { margin-top: 0; }
    .archive__group-label { font-weight: 700; }
    .archive__group-count {
      margin-left: auto;
      color: var(--ink-soft, #8a8678);
      opacity: 0.8;
    }

    .archive__item {
      padding: 10px 12px;
      border: 1px solid var(--ink-soft, #8a8678);
      border-radius: 2px;
      transition: border-color 160ms ease;
    }
    .archive__item:hover { border-color: var(--accent, var(--ink, #e8e4d8)); }
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
    .archive__hit {
      background: var(--accent, var(--ink, #e8e4d8));
      color: var(--paper, #1f1e26);
      padding: 0 2px;
      border-radius: 1px;
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
