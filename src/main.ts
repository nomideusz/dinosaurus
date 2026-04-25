// Entry point. Sets up the canvas + DPR scaling, builds the world and the
// dino, and runs the main animation loop.
//
// Content (HN, DEV.to, weather, quakes, history, facts, musings) is fetched
// and ranked on the server. The client just listens for "item" SSE events
// and spawns a floating card for each; the courier loop then walks the dino
// over to grab and deliver them.

import { Dino, type Mood } from "./dino.js";
import { MessageWorld, type FloatingMessage } from "./messages.js";
import type { ContentKind } from "./services/content.js";
import { World } from "./world.js";

function startApp(stage: HTMLElement, canvas: HTMLCanvasElement): void {
  const maybeCtx = canvas.getContext("2d");
  if (!maybeCtx) throw new Error("2D canvas context unavailable");
  const ctx: CanvasRenderingContext2D = maybeCtx;

  let dpr = Math.max(1, window.devicePixelRatio || 1);
  let cssW = stage.clientWidth;
  let cssH = stage.clientHeight;

  function applySize(): void {
    cssW = stage.clientWidth;
    cssH = stage.clientHeight;
    dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
  }

  applySize();

  const world = new World({ width: cssW, height: cssH });

  const dinoScale = Math.max(2, Math.min(4, Math.round(Math.min(cssW, cssH) / 240)));
  const dino = new Dino({ scale: dinoScale, worldWidth: cssW, worldHeight: cssH });

  // The bins we start with — one per kind that the server's narrator emits.
  const messages = new MessageWorld(
    stage,
    [
      { kind: "news", label: "news", icon: "▤" },
      { kind: "weather", label: "weather", icon: "☁" },
      { kind: "quake", label: "quakes", icon: "↯" },
      { kind: "history", label: "history", icon: "⧗" },
      { kind: "fact", label: "facts", icon: "❍" },
      { kind: "thought", label: "thoughts", icon: "✦" },
    ],
    cssW,
    cssH,
    {
      // Brief double-take whenever a fresh card lands. Goal-driven states
      // (seek/carry/deliver) ignore this, so we never disturb a delivery.
      onSpawn: () => dino.react("surprised", 500),
    }
  );

  const courier = new Courier(dino, messages);

  let resizeRaf = 0;
  window.addEventListener("resize", () => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      applySize();
      world.resize({ width: cssW, height: cssH });
      dino.resize(cssW, cssH);
      messages.resize(cssW, cssH);
      courier.cancel();
    });
  });

  // Main loop
  let last = performance.now();
  function frame(now: number): void {
    const dt = Math.min(64, now - last);
    last = now;

    ctx.clearRect(0, 0, cssW, cssH);
    world.update(dt);
    world.draw(ctx);

    dino.update(now, dt);
    dino.draw(ctx);

    courier.update(now);
    messages.update(now);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/**
 * Tiny coordinator that turns floating messages into a small task pipeline
 * for the dino: pick the closest available card → walk to it → grab → walk
 * to the matching bin → deliver → repeat. While he has nothing to do, the
 * dino's own random wandering takes over.
 */
class Courier {
  private targetId: string | null = null;
  private phase: "idle" | "seeking" | "carrying" | "delivering" = "idle";
  /** When we can next consider grabbing a card (debounce). */
  private nextLookAt = 0;

  constructor(private readonly dino: Dino, private readonly messages: MessageWorld) {}

  /** Forget any current task. Used on resize / disruptions. */
  cancel(): void {
    if (this.targetId) this.messages.release(this.targetId);
    this.targetId = null;
    this.phase = "idle";
    this.dino.cancelGoal();
  }

  update(now: number): void {
    switch (this.phase) {
      case "idle":
        this.maybeStartTask(now);
        break;

      case "seeking": {
        const msg = this.targetId ? this.messages.get(this.targetId) : null;
        if (!msg) {
          this.abort(now);
          return;
        }
        // Re-aim at the (slowly bobbing/floating) card. Aim for the dino's
        // head to land just below the card so the pick-up reads as a lift.
        this.dino.goSeek(msg.x, msg.y + 8);
        if (this.dino.hasArrived(24)) {
          this.messages.claim(msg.id); // no-op if already claimed by us
          const anchor = this.dino.carryAnchor;
          this.messages.setCarried(msg.id, anchor.x, anchor.y);
          const bin = this.messages.binFor(msg.kind);
          if (!bin) {
            this.abort(now);
            return;
          }
          // Walk so the dino's feet land just above the bin's top edge.
          const carryY = Math.max(40, bin.topY - this.dino.heightPx - 2);
          this.dino.goCarry(bin.centerX, carryY);
          this.phase = "carrying";
        }
        break;
      }

      case "carrying": {
        const msg = this.targetId ? this.messages.get(this.targetId) : null;
        if (!msg) {
          this.abort(now);
          return;
        }
        const anchor = this.dino.carryAnchor;
        this.messages.setCarried(msg.id, anchor.x, anchor.y);
        if (this.dino.hasArrived(14)) {
          this.messages.deliver(msg.id);
          this.dino.startDeliver(420, deliveryMoodFor(msg.kind));
          this.phase = "delivering";
        }
        break;
      }

      case "delivering": {
        // Wait until the dino's deliver pose ends, then we're free again.
        if (this.dino.state !== "deliver") {
          this.targetId = null;
          this.phase = "idle";
          this.nextLookAt = now + 600;
        }
        break;
      }
    }
  }

  private maybeStartTask(now: number): void {
    if (now < this.nextLookAt) return;
    if (!this.dino.isAvailable) return;

    const candidates = this.messages.floating();
    if (candidates.length === 0) return;

    // Pick the nearest floating card that has a matching bin.
    let best: FloatingMessage | null = null;
    let bestDist = Infinity;
    const dx0 = this.dino.bubbleAnchor.x;
    const dy0 = this.dino.bubbleAnchor.top;
    for (const m of candidates) {
      if (!this.messages.binFor(m.kind)) continue;
      const d = Math.hypot(m.x - dx0, m.y - dy0);
      if (d < bestDist) {
        best = m;
        bestDist = d;
      }
    }
    if (!best) return;

    if (!this.messages.claim(best.id)) return;
    this.targetId = best.id;
    this.phase = "seeking";
    this.dino.goSeek(best.x, best.y + 30);
  }

  private abort(now: number): void {
    if (this.targetId) this.messages.release(this.targetId);
    this.targetId = null;
    this.phase = "idle";
    this.dino.cancelGoal(now);
    // The card slipped away (TTL'd out, was delivered by another visitor's
    // dino, etc.) — flash an angry face so the lost trip reads as frustration.
    this.dino.react("angry", 700);
    this.nextLookAt = now + 800;
  }
}

/** The face the dino wears while dropping a card of this kind. */
function deliveryMoodFor(kind: ContentKind): Mood {
  switch (kind) {
    case "news":
      return "excited"; // a hop — fresh news pleases him
    case "weather":
      return "happy";
    case "fact":
      return "surprised"; // TIL!
    case "thought":
      return "happy";
    case "quake":
      return "angry"; // the earth shaking is alarming
    case "history":
      return "curious";
  }
}

// ── bootstrap ────────────────────────────────────────────────────────────
// Kept at the bottom of the file so `class Courier` and helpers are fully
// initialised before `startApp` runs (classes have a temporal dead zone).

const stage = document.querySelector<HTMLElement>(".stage");
const canvas = document.getElementById("dino-canvas") as HTMLCanvasElement | null;

if (!stage || !canvas) {
  throw new Error("Could not find required elements in the DOM");
}

if (new URLSearchParams(window.location.search).get("dev") === "sprites") {
  void import("./devSpriteProposals.js").then(({ renderSpriteProposals }) => {
    renderSpriteProposals(stage, canvas);
  });
} else {
  startApp(stage, canvas);
}
