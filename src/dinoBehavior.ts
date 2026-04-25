// Ambient dino behaviors. The Dino class itself only knows about momentary
// reactions (`react(mood, durationMs)`); these little tricks watch the world
// around the dino — clock, weather, how long it's been since something
// happened — and trigger periodic mood expressions so the page feels alive
// even when no cards are spawning. None of these touch the dino's internal
// state machine; they only call the public `react()` and read `isAvailable`,
// so they're safe to run alongside the courier loop.

import type { Dino, Mood } from "./dino.js";
import type { WeatherConditions } from "./weather.js";

interface AmbientOptions {
  /** ms with no card spawn before the dino reads as "bored" / sleepy. */
  idleThresholdMs?: number;
  /** Minimum ms between two ambient triggers, so the dino isn't twitching. */
  cooldownMs?: number;
  /** Per-tick chance of firing once cooldown has elapsed. Keeps things calm. */
  perTickChance?: number;
}

const DEFAULTS: Required<AmbientOptions> = {
  idleThresholdMs: 3 * 60_000,
  cooldownMs: 9_000,
  perTickChance: 0.18,
};

export class DinoAmbient {
  private lastSpawnAt = performance.now();
  private lastTriggerAt = 0;
  private readonly opts: Required<AmbientOptions>;

  constructor(
    private readonly dino: Dino,
    private readonly weatherFn: () => WeatherConditions | null,
    opts: AmbientOptions = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Reset the idle timer. Wire to MessageWorld.onSpawn. */
  noteSpawn(): void {
    this.lastSpawnAt = performance.now();
  }

  /**
   * Per-frame poll. Cheap — most calls bail before doing anything. Picks at
   * most one ambient mood to play, in a rough priority order so the loudest
   * cue (a thunderstorm) wins over the quietest (a calm sunny day).
   */
  update(now: number): void {
    if (!this.dino.isAvailable) return;
    if (now - this.lastTriggerAt < this.opts.cooldownMs) return;
    if (Math.random() > this.opts.perTickChance) return;

    const wx = this.weatherFn();
    const hour = new Date().getHours();
    const idleMs = now - this.lastSpawnAt;

    const pick = chooseAmbientMood({ wx, hour, idleMs, idleThresholdMs: this.opts.idleThresholdMs });
    if (!pick) return;

    this.dino.react(pick.mood, pick.duration);
    this.lastTriggerAt = now;
  }
}

interface ChoiceContext {
  wx: WeatherConditions | null;
  hour: number;
  idleMs: number;
  idleThresholdMs: number;
}

interface MoodChoice {
  mood: Mood;
  duration: number;
}

/**
 * Priority-ordered ambient mood selection. First match wins. Weather cues are
 * loudest, then long-idle "lying down", then time-of-day baseline, then the
 * gentle clear-day happiness as a fallback so a sunny afternoon still gets
 * the occasional smile.
 */
function chooseAmbientMood(ctx: ChoiceContext): MoodChoice | null {
  const { wx, hour, idleMs, idleThresholdMs } = ctx;

  // Storm: brief alarm. The lightning visuals already do the loud part —
  // the dino just looks worried.
  if (wx?.thunder) return { mood: "angry", duration: 1400 };

  // Snow / freezing rain: shivers / sad face. Dino is not a fan.
  if (wx?.precipitation === "snow") return { mood: "sad", duration: 2000 };

  // Heavy rain: drowsy.
  if (wx?.precipitation === "rain" && wx.intensity >= 0.6)
    return { mood: "sleepy", duration: 2400 };

  // Long idle: lies down sleepy. Heaviest behavioural tell that the page
  // has been quiet — invites the user to do something.
  if (idleMs > idleThresholdMs) return { mood: "sleepy", duration: 4000 };

  // Bedtime hours (local): sleepy yawn.
  if (hour >= 22 || hour < 5) return { mood: "sleepy", duration: 2800 };

  // Early morning: bouncy.
  if (hour >= 6 && hour < 9) return { mood: "excited", duration: 1500 };

  // Clear sunny day during waking hours: small smile, fired rarely thanks to
  // the perTickChance + cooldown. Skipped under heavy clouds or fog.
  if (
    wx &&
    wx.isDay &&
    wx.cloudiness === 0 &&
    wx.precipitation === "none" &&
    !wx.fog
  ) {
    return { mood: "happy", duration: 1800 };
  }

  return null;
}
