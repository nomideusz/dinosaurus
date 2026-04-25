// USGS earthquake feed. Public GeoJSON, CORS-friendly, no auth.
// Pulls magnitude-4.5+ events from the past day so the dino has fresh
// "the earth moved here" updates without flooding the feed.

import type { ContentItem, ContentSource } from "./content.js";
import { fetchJson } from "./util.js";

const URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson";

interface USGSResponse {
  features: USGSFeature[];
}

interface USGSFeature {
  id: string;
  properties: {
    mag?: number;
    place?: string;
    time?: number;
    url?: string;
    title?: string;
  };
}

export class QuakesSource implements ContentSource {
  readonly name = "usgs-quakes";
  readonly refreshEveryMs = 12 * 60_000;

  async fetchItems(signal: AbortSignal): Promise<ContentItem[]> {
    const data = await fetchJson<USGSResponse>(URL, signal);
    const out: ContentItem[] = [];
    for (const f of data.features ?? []) {
      const p = f.properties ?? {};
      const mag = p.mag;
      if (typeof mag !== "number") continue;
      const place = (p.place ?? "somewhere out there").trim();
      const text = `M${mag.toFixed(1)} — ${place}`;
      out.push({
        id: `quake:${f.id}`,
        kind: "quake",
        text,
        href: p.url,
        linkLabel: "details",
        publishedAt: typeof p.time === "number" ? p.time : Date.now(),
        // Bigger magnitudes feel more newsworthy; cap so M9 doesn't pin
        // the score at exactly 1.
        score: Math.min(0.95, Math.max(0.2, (mag - 3) / 4)),
      });
    }
    return out;
  }
}
