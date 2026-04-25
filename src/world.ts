// The world. A time-of-day sky that interpolates between color keyframes
// based on the user's local clock, with a sun arcing across by day, a moon
// by night, and twinkling stars that fade in at dusk and out at dawn.
//
// The dot grid stays as a quiet graph-paper texture in the foreground.
// Everything is kept within a darkish palette so the light-colored dino
// remains visible against the sky at every hour of the day.

import { THEME } from "./theme.js";
import type { WeatherConditions } from "./weather.js";

export interface WorldState {
  width: number;
  height: number;
}

export interface WorldOptions {
  /** Polled each frame for current weather. Returning null = clear sky. */
  weather?: () => WeatherConditions | null;
}

type RGB = [number, number, number];

interface SkyKeyframe {
  /** Hour of day, 0..24. KEYFRAMES must be sorted ascending. */
  hour: number;
  /** Top-of-screen color. */
  top: RGB;
  /** Bottom-of-screen color. */
  bottom: RGB;
}

// Sky color stops across a 24-hour day. The narrator interpolates between
// adjacent keyframes so transitions are smooth, not steppy.
const SKY: SkyKeyframe[] = [
  { hour:  0,   top: rgb("#0a0a14"), bottom: rgb("#14141a") }, // deep night
  { hour:  5,   top: rgb("#1c1822"), bottom: rgb("#251f2a") }, // pre-dawn
  { hour:  6.5, top: rgb("#3a2025"), bottom: rgb("#5a2820") }, // dawn (warm)
  { hour:  9,   top: rgb("#2a3a4a"), bottom: rgb("#3a4858") }, // morning (cool blue)
  { hour: 13,   top: rgb("#3a4452"), bottom: rgb("#4a5868") }, // midday
  { hour: 16,   top: rgb("#4a3a35"), bottom: rgb("#5a3530") }, // afternoon (warm)
  { hour: 18,   top: rgb("#3a2030"), bottom: rgb("#5a1f1a") }, // dusk
  { hour: 20,   top: rgb("#1c1428"), bottom: rgb("#251828") }, // evening (indigo)
  { hour: 22,   top: rgb("#0e0e16"), bottom: rgb("#14141c") }, // night
];

// Sun visible in this window (decimal hours). Outside it, the moon is up.
const SUN_RISE = 5.8;
const SUN_SET = 18.2;

const GRID_PX = 24;

interface Star {
  x: number;
  y: number;
  brightness: number;
  twinklePhase: number;
}

interface Cloud {
  /** Anchor x in [0, 1] of world width — wraps at edges. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Drift speed, fraction of world width per second. */
  drift: number;
  /** Per-cloud silhouette seed so each puff looks slightly different. */
  seed: number;
}

interface Drop {
  x: number;
  y: number;
  vy: number;
  /** Sideways drift amplitude in pixels (snow only). */
  sway: number;
  swayPhase: number;
}

export class World {
  private stars: Star[] = [];
  private clouds: Cloud[] = [];
  private drops: Drop[] = [];
  private dropsKind: "rain" | "snow" | "none" = "none";
  private readonly weatherFn: () => WeatherConditions | null;

  constructor(private state: WorldState, opts: WorldOptions = {}) {
    this.weatherFn = opts.weather ?? (() => null);
    this.regenStars();
    this.regenClouds();
  }

  resize(state: WorldState): void {
    this.state = state;
    this.regenStars();
    this.regenClouds();
    this.drops = [];
    this.dropsKind = "none";
  }

  get width(): number {
    return this.state.width;
  }
  get height(): number {
    return this.state.height;
  }

  // The world is fully driven by the wall clock — nothing to advance per frame
  // for the sky itself, but we do step weather particles.
  update(dtMs: number): void {
    const wx = this.weatherFn();
    this.tickClouds(wx, dtMs);
    this.tickDrops(wx, dtMs);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const { width, height } = this.state;
    const date = new Date();
    const h = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
    const wx = this.weatherFn();

    // Sky gradient
    const [topRGB, bottomRGB] = this.skyAt(h);
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, rgbToCss(topRGB));
    grad.addColorStop(1, rgbToCss(bottomRGB));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    // Stars (only at night-ish hours; heavy clouds also dim them).
    const cloudAlpha = wx ? cloudAlphaFor(wx) : 0;
    const sa = starAlpha(h) * (1 - cloudAlpha * 0.7);
    if (sa > 0.01) this.drawStars(ctx, sa);

    // Sun (by day) or moon (by night) arcing across the sky.
    this.drawCelestial(ctx, h, 1 - cloudAlpha * 0.55);

    // Cloud overlay sits between the celestial body and the foreground.
    if (this.clouds.length > 0 && cloudAlpha > 0) {
      this.drawClouds(ctx, cloudAlpha, wx);
    }

    // Fog haze — flat translucent overlay that mutes the whole frame.
    if (wx?.fog) {
      ctx.fillStyle = "rgba(180, 184, 196, 0.18)";
      ctx.fillRect(0, 0, width, height);
    }

    // Rain / snow particles in front of the clouds.
    if (this.drops.length > 0) this.drawDrops(ctx);

    // Quiet graph-paper dot grid on top
    ctx.fillStyle = THEME.grid;
    for (let y = GRID_PX; y < height; y += GRID_PX) {
      for (let x = GRID_PX; x < width; x += GRID_PX) {
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  /** Returns interpolated [top, bottom] sky colors for a given decimal hour. */
  private skyAt(h: number): [RGB, RGB] {
    for (let i = 0; i < SKY.length; i++) {
      const next = SKY[i];
      if (next.hour > h) {
        const prev =
          i === 0
            ? { ...SKY[SKY.length - 1], hour: SKY[SKY.length - 1].hour - 24 }
            : SKY[i - 1];
        const t = (h - prev.hour) / (next.hour - prev.hour);
        return [lerpRGB(prev.top, next.top, t), lerpRGB(prev.bottom, next.bottom, t)];
      }
    }
    // h is past the last keyframe — wrap around to the first
    const prev = SKY[SKY.length - 1];
    const next = { ...SKY[0], hour: SKY[0].hour + 24 };
    const t = (h - prev.hour) / (next.hour - prev.hour);
    return [lerpRGB(prev.top, next.top, t), lerpRGB(prev.bottom, next.bottom, t)];
  }

  private drawStars(ctx: CanvasRenderingContext2D, alpha: number): void {
    const t = performance.now() / 1000;
    for (const s of this.stars) {
      const twinkle = 0.65 + 0.35 * Math.sin(t * 1.4 + s.twinklePhase);
      const a = s.brightness * twinkle * alpha;
      ctx.fillStyle = `rgba(232, 228, 216, ${a.toFixed(3)})`;
      const ix = s.x | 0;
      const iy = s.y | 0;
      ctx.fillRect(ix, iy, 1, 1);
      // The brighter ones get a 2-pixel "flare" so the field looks varied.
      if (s.brightness > 0.75) ctx.fillRect(ix + 1, iy, 1, 1);
    }
  }

  private drawCelestial(ctx: CanvasRenderingContext2D, h: number, dim = 1): void {
    const isSun = h >= SUN_RISE && h <= SUN_SET;

    let t: number;
    if (isSun) {
      t = (h - SUN_RISE) / (SUN_SET - SUN_RISE);
    } else {
      // Moon arcs from sunset (h = SUN_SET) through midnight to sunrise next day.
      let moonH = h - SUN_SET;
      if (moonH < 0) moonH += 24;
      const moonSpan = 24 - SUN_SET + SUN_RISE; // hours moon is up
      t = moonH / moonSpan;
    }

    const x = this.state.width * (0.08 + t * 0.84);
    const baseY = this.state.height * 0.22;
    const arcHeight = this.state.height * 0.13;
    const y = baseY - Math.sin(t * Math.PI) * arcHeight;

    ctx.save();
    ctx.globalAlpha = Math.max(0.2, dim);

    if (isSun) {
      // Glow (radial gradient, warm)
      const r = 14;
      const grad = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 3.5);
      grad.addColorStop(0, "rgba(240, 210, 130, 0.32)");
      grad.addColorStop(1, "rgba(240, 210, 130, 0)");
      ctx.fillStyle = grad;
      ctx.fillRect(x - r * 3.5, y - r * 3.5, r * 7, r * 7);
      // Disc
      ctx.fillStyle = "#f0d08a";
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Moon: cool, with a hint of crater on the right side
      const r = 12;
      const grad = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 3);
      grad.addColorStop(0, "rgba(220, 222, 235, 0.18)");
      grad.addColorStop(1, "rgba(220, 222, 235, 0)");
      ctx.fillStyle = grad;
      ctx.fillRect(x - r * 3, y - r * 3, r * 6, r * 6);
      // Disc
      ctx.fillStyle = "#e2e3eb";
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      // Subtle craters
      ctx.fillStyle = "rgba(150, 152, 168, 0.45)";
      ctx.beginPath();
      ctx.arc(x + r * 0.32, y - r * 0.18, r * 0.22, 0, Math.PI * 2);
      ctx.arc(x - r * 0.28, y + r * 0.30, r * 0.16, 0, Math.PI * 2);
      ctx.arc(x + r * 0.10, y + r * 0.45, r * 0.12, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  private tickClouds(wx: WeatherConditions | null, dtMs: number): void {
    if (!wx || wx.cloudiness === 0) return;
    const dt = dtMs / 1000;
    for (const cloud of this.clouds) {
      cloud.x += cloud.drift * dt;
      // Wrap horizontally — fraction-of-width coordinates make this trivial.
      if (cloud.x > 1.15) cloud.x -= 1.3;
      else if (cloud.x < -0.15) cloud.x += 1.3;
    }
  }

  private tickDrops(wx: WeatherConditions | null, dtMs: number): void {
    const wantKind: "rain" | "snow" | "none" = wx?.precipitation ?? "none";
    if (wantKind !== this.dropsKind) {
      this.dropsKind = wantKind;
      this.regenDrops(wx);
    }
    if (this.drops.length === 0 || wantKind === "none") return;
    const dt = dtMs / 1000;
    const { width, height } = this.state;
    for (const d of this.drops) {
      d.y += d.vy * dt;
      if (wantKind === "snow") {
        d.swayPhase += dt * 1.4;
        // Snow has visible horizontal sway via swayPhase; rain stays vertical.
      }
      if (d.y > height + 8) {
        d.y = -8;
        d.x = Math.random() * width;
      }
    }
  }

  private drawClouds(
    ctx: CanvasRenderingContext2D,
    alpha: number,
    wx: WeatherConditions | null
  ): void {
    const tint = wx && (wx.thunder || wx.cloudiness === 2)
      ? "rgba(58, 58, 70, "
      : "rgba(220, 222, 232, ";
    const baseAlpha = alpha * (wx?.thunder ? 0.85 : 0.55);
    for (const cloud of this.clouds) {
      const cx = cloud.x * this.state.width;
      const cy = cloud.y;
      const w = cloud.width;
      const h = cloud.height;
      // A cloud is 4–5 overlapping ellipses; the seed deterministically
      // varies the puff pattern so each one looks distinct.
      const lobes = 4 + (cloud.seed & 1);
      ctx.fillStyle = tint + baseAlpha.toFixed(3) + ")";
      for (let i = 0; i < lobes; i++) {
        const offX = ((cloud.seed * (i + 1) * 31) % 100) / 100 - 0.5;
        const offY = ((cloud.seed * (i + 2) * 17) % 60) / 100 - 0.3;
        const rx = (w / 2) * (0.55 + ((cloud.seed * (i + 3) * 7) % 40) / 100);
        const ry = (h / 2) * (0.65 + ((cloud.seed * (i + 4) * 5) % 30) / 100);
        ctx.beginPath();
        ctx.ellipse(cx + offX * w * 0.6, cy + offY * h * 0.8, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawDrops(ctx: CanvasRenderingContext2D): void {
    if (this.dropsKind === "rain") {
      ctx.strokeStyle = "rgba(170, 190, 220, 0.55)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const d of this.drops) {
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x - 1.5, d.y + 8);
      }
      ctx.stroke();
    } else if (this.dropsKind === "snow") {
      ctx.fillStyle = "rgba(232, 234, 244, 0.85)";
      for (const d of this.drops) {
        const sx = d.x + Math.sin(d.swayPhase) * d.sway;
        ctx.fillRect(sx | 0, d.y | 0, 1, 1);
        // Bigger flakes get a 2px cluster.
        if (d.sway > 1.2) {
          ctx.fillRect((sx | 0) + 1, d.y | 0, 1, 1);
          ctx.fillRect(sx | 0, (d.y | 0) + 1, 1, 1);
        }
      }
    }
  }

  private regenClouds(): void {
    const count = Math.max(4, Math.round(this.state.width / 220));
    let seed = 7331;
    const rand = (): number => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    this.clouds = [];
    const skyBand = this.state.height * 0.42;
    for (let i = 0; i < count; i++) {
      const w = 90 + rand() * 130;
      this.clouds.push({
        x: rand() * 1.3 - 0.15,
        y: 30 + rand() * skyBand,
        width: w,
        height: w * (0.34 + rand() * 0.16),
        drift: (rand() < 0.5 ? -1 : 1) * (0.005 + rand() * 0.012),
        seed: 1 + Math.floor(rand() * 9999),
      });
    }
  }

  private regenDrops(wx: WeatherConditions | null): void {
    if (!wx || wx.precipitation === "none") {
      this.drops = [];
      return;
    }
    const isRain = wx.precipitation === "rain";
    const baseCount = Math.round((this.state.width * this.state.height) / (isRain ? 12_000 : 18_000));
    const count = Math.round(baseCount * (0.4 + wx.intensity));
    this.drops = [];
    for (let i = 0; i < count; i++) {
      this.drops.push({
        x: Math.random() * this.state.width,
        y: Math.random() * this.state.height,
        vy: isRain ? 280 + Math.random() * 220 : 30 + Math.random() * 50,
        sway: isRain ? 0 : 0.6 + Math.random() * 1.6,
        swayPhase: Math.random() * Math.PI * 2,
      });
    }
  }

  /**
   * Deterministic seeded layout so stars don't shimmer between frames and
   * keep the same map until the window resizes.
   */
  private regenStars(): void {
    const count = Math.round((this.state.width * this.state.height) / 9000);
    let seed = 12345;
    const rand = (): number => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    this.stars = [];
    for (let i = 0; i < count; i++) {
      this.stars.push({
        x: rand() * this.state.width,
        // Keep stars in the upper ~70% so they read as "sky"
        y: rand() * (this.state.height * 0.7),
        brightness: 0.35 + rand() * 0.65,
        twinklePhase: rand() * Math.PI * 2,
      });
    }
  }
}

/**
 * Cloud overlay strength for the current conditions. 0 means no draw,
 * 1 means full opacity. Heavier cloudiness, thunder, and active rain all
 * push this higher; intensity adds a small extra weight.
 */
function cloudAlphaFor(wx: WeatherConditions): number {
  let a = 0;
  if (wx.cloudiness === 1) a = 0.35;
  else if (wx.cloudiness === 2) a = 0.65;
  if (wx.thunder) a = Math.max(a, 0.85);
  if (wx.precipitation === "rain") a = Math.max(a, 0.55);
  if (wx.precipitation === "snow") a = Math.max(a, 0.5);
  return Math.min(1, a + wx.intensity * 0.1);
}

/**
 * Star visibility curve. 1.0 from late evening through deep night, fading
 * symmetrically at dusk/dawn so the transition matches the sky gradient.
 */
function starAlpha(h: number): number {
  if (h >= 20 || h <= 4) return 1;
  if (h > 18 && h < 20) return (h - 18) / 2; // dusk fade-in
  if (h > 4 && h < 6) return 1 - (h - 4) / 2; // dawn fade-out
  return 0;
}

// ── Color helpers ────────────────────────────────────────────────────────

function rgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbToCss(c: RGB): string {
  return `rgb(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0})`;
}

function lerpRGB(a: RGB, b: RGB, t: number): RGB {
  const k = Math.max(0, Math.min(1, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}
