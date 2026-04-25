// Per-visitor weather. Independent of the shared archive — each visitor
// fetches their own location-derived conditions, sees a small ambient card
// that fades in and back out on its own, and the World reads `conditions()`
// each frame to tint the sky with clouds and precipitation.

export type Cloudiness = 0 | 1 | 2; // none / scattered / overcast
export type Precipitation = "none" | "rain" | "snow";

export interface WeatherConditions {
  cloudiness: Cloudiness;
  precipitation: Precipitation;
  /** 0..1 — used to scale particle density / overlay strength. */
  intensity: number;
  thunder: boolean;
  fog: boolean;
  isDay: boolean;
}

interface OpenMeteoCurrent {
  temperature_2m: number;
  apparent_temperature?: number;
  weather_code: number;
  is_day?: number;
  precipitation?: number;
}

interface Geo {
  lat: number;
  lon: number;
  city: string;
}

const REFRESH_MS = 15 * 60_000;
const FIRST_SHOW_DELAY_MS = 4_000;
const REPEAT_SHOW_INTERVAL_MS = 6 * 60_000;
const CARD_DURATION_MS = 9_000;
const FALLBACK_GEO: Geo = { lat: 51.5074, lon: -0.1278, city: "London" };

export class WeatherClient {
  private state: WeatherConditions | null = null;
  private cachedGeo: Geo | null = null;
  private readonly card: WeatherCard;

  constructor(parent: HTMLElement) {
    this.card = new WeatherCard(parent);
    void this.refresh();
    window.setInterval(() => void this.refresh(), REFRESH_MS);
    // Re-show occasionally even when the data hasn't changed, so a long-
    // running session keeps the visual cue around.
    window.setInterval(() => this.card.show(CARD_DURATION_MS), REPEAT_SHOW_INTERVAL_MS);
  }

  /** Read by the World each frame to drive cloud / rain rendering. */
  conditions(): WeatherConditions | null {
    return this.state;
  }

  private async refresh(): Promise<void> {
    try {
      const geo = await this.geo();
      const url = new URL("https://api.open-meteo.com/v1/forecast");
      url.searchParams.set("latitude", String(geo.lat));
      url.searchParams.set("longitude", String(geo.lon));
      url.searchParams.set(
        "current",
        "temperature_2m,apparent_temperature,weather_code,is_day,precipitation"
      );
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) return;
      const data = (await res.json()) as { current?: OpenMeteoCurrent };
      const c = data.current;
      if (!c) return;

      this.state = deriveConditions(c);
      this.card.update(formatLine(geo.city, c), this.state);
      window.setTimeout(() => this.card.show(CARD_DURATION_MS), FIRST_SHOW_DELAY_MS);
    } catch {
      // Network / CORS error — leave previous state intact, no card update.
    }
  }

  private async geo(): Promise<Geo> {
    if (this.cachedGeo) return this.cachedGeo;
    try {
      const res = await fetch("https://ipapi.co/json/");
      if (res.ok) {
        const j = (await res.json()) as { latitude?: number; longitude?: number; city?: string };
        if (typeof j.latitude === "number" && typeof j.longitude === "number") {
          this.cachedGeo = {
            lat: j.latitude,
            lon: j.longitude,
            city: typeof j.city === "string" && j.city.length > 0 ? j.city : "your area",
          };
          return this.cachedGeo;
        }
      }
    } catch {
      /* fall through to default below */
    }
    this.cachedGeo = FALLBACK_GEO;
    return this.cachedGeo;
  }
}

function deriveConditions(c: OpenMeteoCurrent): WeatherConditions {
  const code = c.weather_code;
  const isDay = c.is_day !== 0;
  const precipMm = c.precipitation ?? 0;

  let cloudiness: Cloudiness = 0;
  if ([1, 2].includes(code)) cloudiness = 1;
  else if (code === 3 || (code >= 45 && code <= 99)) cloudiness = 2;

  let precipitation: Precipitation = "none";
  if (
    [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(code)
  ) {
    precipitation = "rain";
  } else if ([71, 73, 75, 77, 85, 86].includes(code)) {
    precipitation = "snow";
  }

  // Map roughly: light → 0.35, moderate → 0.65, heavy → 0.95
  let intensity = 0.4;
  if ([55, 65, 67, 75, 82, 86, 99].includes(code)) intensity = 0.95;
  else if ([53, 63, 73, 81, 96].includes(code)) intensity = 0.65;
  else if (precipMm >= 1) intensity = Math.min(0.9, 0.35 + precipMm * 0.05);

  return {
    cloudiness,
    precipitation,
    intensity,
    thunder: [95, 96, 99].includes(code),
    fog: [45, 48].includes(code),
    isDay,
  };
}

function formatLine(city: string, c: OpenMeteoCurrent): string {
  const desc = describeWeather(c.weather_code, c.is_day !== 0);
  const t = Math.round(c.temperature_2m);
  const feels =
    c.apparent_temperature !== undefined ? Math.round(c.apparent_temperature) : t;
  let line = `${city}: ${desc}, ${t}°C`;
  if (Math.abs(feels - t) >= 2) line += ` (feels ${feels}°)`;
  return line;
}

function describeWeather(code: number, isDay: boolean): string {
  switch (code) {
    case 0:
      return isDay ? "clear skies" : "clear night";
    case 1:
    case 2:
      return "mostly sunny";
    case 3:
      return "overcast";
    case 45:
    case 48:
      return "foggy";
    case 51:
    case 53:
    case 55:
      return "drizzling";
    case 56:
    case 57:
      return "freezing drizzle";
    case 61:
    case 63:
    case 65:
      return "raining";
    case 66:
    case 67:
      return "freezing rain";
    case 71:
    case 73:
    case 75:
      return "snowing";
    case 77:
      return "snow grains";
    case 80:
    case 81:
    case 82:
      return "rain showers";
    case 85:
    case 86:
      return "snow showers";
    case 95:
      return "thunderstorm";
    case 96:
    case 99:
      return "thunderstorm with hail";
    default:
      return "weathering";
  }
}

class WeatherCard {
  private readonly el: HTMLDivElement;
  private hideTimer: number | null = null;

  constructor(parent: HTMLElement) {
    injectStylesOnce();
    this.el = document.createElement("div");
    this.el.className = "wx-card";
    this.el.setAttribute("role", "status");
    this.el.setAttribute("aria-live", "polite");
    this.el.innerHTML = `
      <span class="wx-card__icon" aria-hidden="true">☁</span>
      <span class="wx-card__line"></span>
    `;
    parent.appendChild(this.el);
  }

  update(line: string, conditions: WeatherConditions): void {
    const lineEl = this.el.querySelector<HTMLSpanElement>(".wx-card__line");
    const iconEl = this.el.querySelector<HTMLSpanElement>(".wx-card__icon");
    if (lineEl) lineEl.textContent = line;
    if (iconEl) iconEl.textContent = iconFor(conditions);
  }

  show(durationMs: number): void {
    this.el.classList.add("wx-card--visible");
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      this.el.classList.remove("wx-card--visible");
      this.hideTimer = null;
    }, durationMs);
  }
}

function iconFor(c: WeatherConditions): string {
  if (c.thunder) return "⚡";
  if (c.precipitation === "snow") return "❄";
  if (c.precipitation === "rain") return "☂";
  if (c.fog) return "≋";
  if (c.cloudiness === 2) return "☁";
  if (c.cloudiness === 1) return "⛅";
  return c.isDay ? "☀" : "☾";
}

let stylesInjected = false;
function injectStylesOnce(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .wx-card {
      position: absolute;
      top: 14px;
      right: 14px;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      background: var(--paper, #1f1e26);
      color: var(--ink, #e8e4d8);
      border: 1px solid var(--ink-soft, #8a8678);
      border-radius: 2px;
      font: 500 11.5px/1.3 ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
      letter-spacing: 0.04em;
      box-shadow: 0 4px 0 rgba(0, 0, 0, 0.22);
      pointer-events: none;
      opacity: 0;
      transform: translateY(-6px);
      transition: opacity 360ms ease, transform 360ms cubic-bezier(.2,.7,.2,1.4);
      z-index: 5;
      max-width: min(64vw, 320px);
    }
    .wx-card--visible {
      opacity: 1;
      transform: translateY(0);
    }
    .wx-card__icon {
      font-size: 14px;
      line-height: 1;
      opacity: 0.85;
    }
    @media (prefers-reduced-motion: reduce) {
      .wx-card { transition: opacity 200ms ease; transform: none; }
    }
  `;
  document.head.appendChild(style);
}
