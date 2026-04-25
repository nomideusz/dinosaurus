// USGS earthquake feed — public GeoJSON.

import { fetchJson } from "./util.mjs";

const URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson";

export const Quakes = {
  name: "usgs-quakes",
  refreshEveryMs: 12 * 60_000,
  /** @param {AbortSignal} signal */
  async fetchItems(signal) {
    const data = await fetchJson(URL, signal);
    const out = [];
    for (const f of data.features ?? []) {
      const p = f.properties ?? {};
      const mag = p.mag;
      if (typeof mag !== "number") continue;
      const place = (p.place ?? "somewhere out there").trim();
      out.push({
        id: `quake:${f.id}`,
        kind: "quake",
        text: `M${mag.toFixed(1)} — ${place}`,
        href: p.url,
        linkLabel: "details",
        publishedAt: typeof p.time === "number" ? p.time : Date.now(),
        score: Math.min(0.95, Math.max(0.2, (mag - 3) / 4)),
      });
    }
    return out;
  },
};
