// The dinosaur entity. He owns the entire viewport: he picks random points
// to wander to, walks toward them, then idles, looks around, blinks, or
// naps. An external coordinator can also assign him a *goal* — walk over to
// a specific point (a floating message), pick it up, then walk to another
// point (a category bin) and drop it. While he has a goal he ignores his
// own random wandering decisions.

import {
  buildFrames,
  type FrameId,
  type RenderedFrame,
  SPRITE_GRID_H,
  SPRITE_GRID_W,
} from "./sprite.js";

export type Mood =
  | "angry"
  | "curious"
  | "excited"
  | "happy"
  | "neutral"
  | "sad"
  | "sleepy"
  | "surprised";

export type Activity =
  | "walk"
  | "idle"
  | "look"
  | "blink"
  | "sleep"
  | "react"
  | "seek"      // walking toward a designated message to pick it up
  | "carry"     // walking with a message attached, headed for a bin
  | "deliver";  // paused at a bin, dropping the message in

export interface DinoOptions {
  /** Pixel scale (each sprite pixel is N CSS pixels). */
  scale: number;
  worldWidth: number;
  worldHeight: number;
  /** Optional override for the body color (defaults to sprite.INK). */
  color?: string;
}

/**
 * Anchor describing where things can be tethered to the dino.
 * `top` is the head; `bottom` is the feet.
 */
export interface BubbleAnchor {
  x: number;
  top: number;
  bottom: number;
}

/** Where a carried object should sit, in world CSS pixels. */
export interface CarryAnchor {
  x: number;
  y: number;
}

export class Dino {
  private x: number;
  private y: number;
  private targetX: number;
  private targetY: number;
  private facing: 1 | -1 = 1;
  private speed = 36; // CSS px / s
  private activity: Activity = "idle";
  private nextDecisionAt = 0;
  private blinkUntil = 0;
  private wantsBlinkAt = 0;
  private animTick = 0;
  private deliverUntil = 0;
  private frames: Record<FrameId, RenderedFrame>;

  /** Public mood — used to pick a face frame while reacting / delivering. */
  mood: Mood = "neutral";

  constructor(private opts: DinoOptions) {
    this.frames = buildFrames(opts.scale, opts.color);
    this.x = opts.worldWidth * 0.5;
    this.y = opts.worldHeight * 0.6;
    this.targetX = this.x;
    this.targetY = this.y;
    this.scheduleNextDecision(performance.now() + 1500);
    this.scheduleNextBlink(performance.now());
  }

  resize(worldWidth: number, worldHeight: number): void {
    this.opts.worldWidth = worldWidth;
    this.opts.worldHeight = worldHeight;
    this.x = clamp(this.x, this.minX, this.maxX);
    this.y = clamp(this.y, this.minY, this.maxY);
    this.targetX = clamp(this.targetX, this.minX, this.maxX);
    this.targetY = clamp(this.targetY, this.minY, this.maxY);
  }

  get widthPx(): number {
    return SPRITE_GRID_W * this.opts.scale;
  }
  get heightPx(): number {
    return SPRITE_GRID_H * this.opts.scale;
  }

  /** Tether point for things attached to the dino — head + feet. */
  get bubbleAnchor(): BubbleAnchor {
    // The head sits in the upper-right of the 20×16 sprite (cols ~13-19).
    // That's ~6 sprite-pixels right of center; mirror when facing left.
    const dx = this.opts.scale * 6;
    return {
      x: this.x + (this.facing === 1 ? dx : -dx),
      top: this.y, // top of head
      bottom: this.y + this.heightPx, // bottom of feet
    };
  }

  /** Where a carried message card should sit (just above the head). */
  get carryAnchor(): CarryAnchor {
    const dx = this.opts.scale * 6;
    return {
      x: this.x + (this.facing === 1 ? dx : -dx),
      y: this.y - 18, // hover above the head
    };
  }

  /** Read-only state — used by the coordinator to decide what to ask next. */
  get state(): Activity {
    return this.activity;
  }

  /** True when the dino is free to be assigned a new goal (seek/carry). */
  get isAvailable(): boolean {
    return (
      this.activity === "idle" ||
      this.activity === "walk" ||
      this.activity === "look"
    );
  }

  /** Has he reached his current target (within `eps` px)? */
  hasArrived(eps = 8): boolean {
    return Math.hypot(this.targetX - this.x, this.targetY - this.y) <= eps;
  }

  /**
   * Ask the dino to pause and emote. Goal-driven activities (seek/carry/
   * deliver) take priority — we don't interrupt him mid-task. Otherwise he
   * stops where he is, shows the matching face for `durationMs`, then the
   * normal decision loop resumes.
   */
  react(mood: Mood = "curious", durationMs = 2200): void {
    if (
      this.activity === "seek" ||
      this.activity === "carry" ||
      this.activity === "deliver"
    ) {
      return;
    }
    this.mood = mood;
    this.activity = "react";
    this.targetX = this.x;
    this.targetY = this.y;
    this.nextDecisionAt = performance.now() + durationMs;
  }

  /** Tell the dino he just finished saying something — relax. */
  finishedSpeaking(): void {
    if (this.activity === "react") {
      this.activity = "idle";
      this.scheduleNextDecision(performance.now() + 1200 + Math.random() * 1800);
    }
  }

  /**
   * User-directed walk. Unlike seek/carry this is not a delivery goal, so the
   * courier may interrupt it when a floating card needs attention.
   */
  goTo(x: number, y: number): void {
    if (!this.isAvailable) return;
    this.activity = "walk";
    this.targetX = clamp(x, this.minX, this.maxX);
    this.targetY = clamp(y, this.minY, this.maxY);
    this.speed = 52;
    this.mood = "curious";
    this.faceToward(this.targetX);
    this.nextDecisionAt = Number.POSITIVE_INFINITY;
  }

  /**
   * Walk toward (x, y) with intent to grab a message. Wandering is
   * suspended until the goal is cleared (deliver / cancel).
   */
  goSeek(x: number, y: number): void {
    this.activity = "seek";
    this.targetX = clamp(x, this.minX, this.maxX);
    this.targetY = clamp(y, this.minY, this.maxY);
    this.speed = 70;
    this.faceToward(this.targetX);
    this.nextDecisionAt = Number.POSITIVE_INFINITY;
  }

  /**
   * Walk toward (x, y) while carrying a message. The caller positions the
   * carried object via `carryAnchor` each frame.
   */
  goCarry(x: number, y: number): void {
    this.activity = "carry";
    this.targetX = clamp(x, this.minX, this.maxX);
    this.targetY = clamp(y, this.minY, this.maxY);
    this.speed = 56;
    this.faceToward(this.targetX);
    this.nextDecisionAt = Number.POSITIVE_INFINITY;
  }

  /**
   * Pause briefly to drop a message into a bin. The optional `mood` colours
   * the face during the deliver pose — e.g. "excited" picks the cheer frame
   * for big news, "surprised" works well for quakes, "curious" for facts.
   */
  startDeliver(durationMs = 420, mood: Mood = "happy"): void {
    this.activity = "deliver";
    this.targetX = this.x;
    this.targetY = this.y;
    this.deliverUntil = performance.now() + durationMs;
    this.mood = mood;
    this.nextDecisionAt = this.deliverUntil + 200;
  }

  /** Cancel any active goal and return to wandering. */
  cancelGoal(now = performance.now()): void {
    if (
      this.activity === "seek" ||
      this.activity === "carry" ||
      this.activity === "deliver"
    ) {
      this.activity = "idle";
      this.scheduleNextDecision(now + 600 + Math.random() * 800);
    }
  }

  update(now: number, dtMs: number): void {
    // Blink layer — independent of motion.
    if (
      now >= this.wantsBlinkAt &&
      this.activity !== "sleep" &&
      this.activity !== "react" &&
      this.activity !== "deliver"
    ) {
      this.blinkUntil = now + 130;
      this.scheduleNextBlink(now);
    }

    // Movement is shared between wander, seek, and carry.
    if (
      this.activity === "walk" ||
      this.activity === "seek" ||
      this.activity === "carry"
    ) {
      const dx = this.targetX - this.x;
      const dy = this.targetY - this.y;
      const dist = Math.hypot(dx, dy);
      const step = this.speed * (dtMs / 1000);

      if (dist <= 1.5 || step >= dist) {
        this.x = this.targetX;
        this.y = this.targetY;
        if (this.activity === "walk") {
          // Wander arrived — go idle and pick the next thing.
          this.activity = "idle";
          this.scheduleNextDecision(now + 700 + Math.random() * 2200);
        }
        // For seek/carry, stay put with the same activity until the
        // coordinator gives us the next instruction.
      } else {
        this.x += (dx / dist) * step;
        this.y += (dy / dist) * step;
        if (Math.abs(dx) > 0.5) this.facing = dx >= 0 ? 1 : -1;
      }
    }

    // Deliver state auto-completes; coordinator will see arrival via state.
    if (this.activity === "deliver" && now >= this.deliverUntil) {
      this.activity = "idle";
      this.scheduleNextDecision(now + 500 + Math.random() * 600);
    }

    if (now >= this.nextDecisionAt) {
      this.pickNextActivity(now);
    }

    this.animTick += dtMs;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const frame = this.currentFrame();
    const img = this.facing === 1 ? frame.right : frame.left;
    // Subtle 1px bob while walking
    const moving =
      this.activity === "walk" ||
      this.activity === "seek" ||
      this.activity === "carry";
    const bob = moving ? Math.round(Math.sin(this.animTick / 110)) : 0;
    ctx.drawImage(
      img,
      Math.round(this.x - this.widthPx / 2),
      Math.round(this.y + bob)
    );
  }

  private currentFrame(): RenderedFrame {
    const now = performance.now();
    if (this.activity === "sleep") return this.frames.sleep;
    if (now < this.blinkUntil) return this.frames.blink;
    if (this.activity === "react") return this.moodFrame();
    if (this.activity === "deliver") return this.moodFrame();
    if (this.activity === "look") return this.frames.look_up;
    if (
      this.activity === "walk" ||
      this.activity === "seek" ||
      this.activity === "carry"
    ) {
      return Math.floor(this.animTick / 180) % 2 === 0
        ? this.frames.walk_a
        : this.frames.walk_b;
    }
    return this.frames.idle;
  }

  private moodFrame(): RenderedFrame {
    switch (this.mood) {
      case "angry":
        return this.frames.angry;
      case "happy":
        return this.frames.happy;
      case "excited":
        return this.frames.cheer;
      case "sad":
        return this.frames.sad;
      case "curious":
        return this.frames.look_up;
      case "surprised":
        return this.frames.surprise;
      case "sleepy":
        return this.frames.sleep;
      case "neutral":
        return this.frames.idle;
    }
  }

  private pickNextActivity(now: number): void {
    // Goal-driven activities never re-roll randomly; only the coordinator
    // (or cancelGoal) leaves them.
    if (
      this.activity === "seek" ||
      this.activity === "carry" ||
      this.activity === "deliver"
    ) {
      return;
    }

    const r = Math.random();
    if (this.activity === "sleep" && r < 0.55) {
      // Wake from a nap with a small stretch — show the "look up" pose
      // briefly so the transition reads as yawning/stretching.
      this.activity = "react";
      this.mood = "curious";
      this.scheduleNextDecision(now + 700 + Math.random() * 600);
      return;
    }
    // Small spontaneous emote — keeps him from feeling robotic during long
    // stretches with no cards to chase.
    if (r < 0.07) {
      const emotes: Mood[] = ["happy", "sad", "surprised", "curious"];
      this.react(emotes[Math.floor(Math.random() * emotes.length)], 1100 + Math.random() * 700);
      return;
    }
    if (r < 0.6) {
      this.activity = "walk";
      this.pickWanderTarget();
      this.speed = 26 + Math.random() * 28;
      this.scheduleNextDecision(now + 12_000);
    } else if (r < 0.82) {
      this.activity = "idle";
      this.scheduleNextDecision(now + 1200 + Math.random() * 2400);
    } else if (r < 0.94) {
      this.activity = "look";
      this.scheduleNextDecision(now + 900 + Math.random() * 1100);
    } else {
      this.activity = "sleep";
      this.scheduleNextDecision(now + 4000 + Math.random() * 5000);
    }
  }

  private pickWanderTarget(): void {
    const pickAxis = (cur: number, lo: number, hi: number): number => {
      const range = hi - lo;
      const span = range * (0.15 + Math.random() * 0.55);
      const dir = Math.random() < 0.5 ? -1 : 1;
      let next = cur + dir * span;
      if (next < lo) next = lo + Math.random() * (range * 0.4);
      if (next > hi) next = hi - Math.random() * (range * 0.4);
      return next;
    };
    this.targetX = pickAxis(this.x, this.minX, this.maxX);
    this.targetY = pickAxis(this.y, this.minY, this.maxY);
  }

  private faceToward(x: number): void {
    if (Math.abs(x - this.x) > 0.5) {
      this.facing = x >= this.x ? 1 : -1;
    }
  }

  private get minX(): number {
    return this.widthPx / 2 + 8;
  }
  private get maxX(): number {
    return this.opts.worldWidth - this.widthPx / 2 - 8;
  }
  private get minY(): number {
    return 8;
  }
  private get maxY(): number {
    return this.opts.worldHeight - this.heightPx - 8;
  }

  private scheduleNextDecision(at: number): void {
    this.nextDecisionAt = at;
  }

  private scheduleNextBlink(now: number): void {
    this.wantsBlinkAt = now + 2200 + Math.random() * 3800;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
