// Weather via Open-Meteo. No API key, generous free tier, CORS-friendly.
// We try to geolocate via the IP-based ipapi.co lookup (also keyless).
// If that fails, fall back to a sensible default (London) so the dino still
// has something interesting to say.

import type { ContentItem, ContentSource } from "./content.js";

interface Geo {
  lat: number;
  lon: number;
  city?: string;
}

interface OpenMeteoResponse {
  current?: {
    time: string;
    temperature_2m: number;
    apparent_temperature?: number;
    weather_code: number;
    wind_speed_10m?: number;
    is_day?: number;
    precipitation?: number;
  };
  daily?: {
    time: string[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    weather_code: number[];
    precipitation_probability_max?: number[];
  };
}

export class WeatherSource implements ContentSource {
  readonly name = "weather";
  readonly refreshEveryMs = 15 * 60_000; // 15 min
  private cachedGeo: Geo | null = null;

  async fetchItems(signal: AbortSignal): Promise<ContentItem[]> {
    const geo = await this.geo(signal);
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(geo.lat));
    url.searchParams.set("longitude", String(geo.lon));
    url.searchParams.set(
      "current",
      "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day,precipitation"
    );
    url.searchParams.set(
      "daily",
      "temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max"
    );
    url.searchParams.set("forecast_days", "2");
    url.searchParams.set("timezone", "auto");

    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`open-meteo -> ${res.status}`);
    const data = (await res.json()) as OpenMeteoResponse;

    const items: ContentItem[] = [];
    const place = geo.city ?? "your area";
    const now = Date.now();

    if (data.current) {
      const c = data.current;
      const desc = describeWeather(c.weather_code, c.is_day === 1);
      const temp = Math.round(c.temperature_2m);
      const feels = c.apparent_temperature !== undefined ? Math.round(c.apparent_temperature) : temp;
      let text = `${place}: ${desc}, ${temp}°C`;
      if (Math.abs(feels - temp) >= 2) text += ` (feels like ${feels}°)`;
      items.push({
        id: `wx:current:${Math.floor(now / 600_000)}`,
        kind: "weather",
        text,
        publishedAt: now,
        score: relevanceFor(c.weather_code, c.precipitation ?? 0),
      });
    }

    if (data.daily && data.daily.time.length >= 2) {
      const i = 1; // tomorrow
      const minT = Math.round(data.daily.temperature_2m_min[i]);
      const maxT = Math.round(data.daily.temperature_2m_max[i]);
      const desc = describeWeather(data.daily.weather_code[i], true);
      const pop = data.daily.precipitation_probability_max?.[i] ?? 0;
      let text = `tomorrow in ${place}: ${desc}, ${minT}–${maxT}°C`;
      if (pop >= 50) text += `, ${pop}% chance of precipitation`;
      items.push({
        id: `wx:tomorrow:${data.daily.time[i]}`,
        kind: "weather",
        text,
        publishedAt: now,
        score: 0.4 + (pop >= 60 ? 0.2 : 0),
      });
    }

    return items;
  }

  private async geo(signal: AbortSignal): Promise<Geo> {
    if (this.cachedGeo) return this.cachedGeo;
    try {
      const res = await fetch("https://ipapi.co/json/", { signal });
      if (res.ok) {
        const j = (await res.json()) as { latitude?: number; longitude?: number; city?: string };
        if (typeof j.latitude === "number" && typeof j.longitude === "number") {
          this.cachedGeo = { lat: j.latitude, lon: j.longitude, city: j.city };
          return this.cachedGeo;
        }
      }
    } catch {
      /* swallow — we'll fall back below */
    }
    this.cachedGeo = { lat: 51.5074, lon: -0.1278, city: "London" };
    return this.cachedGeo;
  }
}

// WMO weather codes — https://open-meteo.com/en/docs
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

function relevanceFor(code: number, precip: number): number {
  // Storms and snow are more share-worthy than calm sunshine.
  if ([95, 96, 99].includes(code)) return 0.95;
  if ([65, 75, 82, 86].includes(code)) return 0.75;
  if (precip > 0) return 0.55;
  if ([45, 48].includes(code)) return 0.5;
  if ([0, 1].includes(code)) return 0.35;
  return 0.4;
}
