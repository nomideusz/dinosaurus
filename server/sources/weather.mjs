// Open-Meteo current + tomorrow. With the narrator on the server we lose
// per-visitor IP geolocation; everyone shares the same city. Configurable
// via env vars so the dino doesn't have to talk only about London.

import { fetchJson } from "./util.mjs";

const LAT = Number(process.env.WEATHER_LAT ?? 51.5074);
const LON = Number(process.env.WEATHER_LON ?? -0.1278);
const CITY = process.env.WEATHER_CITY ?? "London";

export const Weather = {
  name: "weather",
  refreshEveryMs: 15 * 60_000,
  /** @param {AbortSignal} signal */
  async fetchItems(signal) {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(LAT));
    url.searchParams.set("longitude", String(LON));
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

    const data = await fetchJson(url.toString(), signal);
    const items = [];
    const now = Date.now();

    if (data.current) {
      const c = data.current;
      const desc = describeWeather(c.weather_code, c.is_day === 1);
      const temp = Math.round(c.temperature_2m);
      const feels =
        c.apparent_temperature !== undefined ? Math.round(c.apparent_temperature) : temp;
      let text = `${CITY}: ${desc}, ${temp}°C`;
      if (Math.abs(feels - temp) >= 2) text += ` (feels like ${feels}°)`;
      items.push({
        id: `wx:current:${Math.floor(now / 600_000)}`,
        kind: "weather",
        text,
        publishedAt: now,
        score: relevanceFor(c.weather_code, c.precipitation ?? 0),
      });
    }

    if (data.daily && data.daily.time?.length >= 2) {
      const i = 1;
      const minT = Math.round(data.daily.temperature_2m_min[i]);
      const maxT = Math.round(data.daily.temperature_2m_max[i]);
      const desc = describeWeather(data.daily.weather_code[i], true);
      const pop = data.daily.precipitation_probability_max?.[i] ?? 0;
      let text = `tomorrow in ${CITY}: ${desc}, ${minT}–${maxT}°C`;
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
  },
};

function describeWeather(code, isDay) {
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

function relevanceFor(code, precip) {
  if ([95, 96, 99].includes(code)) return 0.95;
  if ([65, 75, 82, 86].includes(code)) return 0.75;
  if (precip > 0) return 0.55;
  if ([45, 48].includes(code)) return 0.5;
  if ([0, 1].includes(code)) return 0.35;
  return 0.4;
}
