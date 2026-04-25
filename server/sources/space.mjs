// Space channel — three small NASA-flavoured feeds bundled together so the
// dino occasionally looks up.
//
//   • APOD  (Astronomy Picture of the Day) — once per day, with a link to the
//     image and a one-line caption.
//   • NEO   (Near-Earth Objects) — asteroids passing close today, sized in
//     friendly units ("about the size of a school bus").
//   • ISS   (International Space Station) — current ground position, named
//     by region. No personalisation: items are shared across visitors.
//
// APOD + NEO use NASA's free API. The DEMO_KEY default works (30 req/h IP)
// but it's polite to set NASA_API_KEY in production. ISS uses
// wheretheiss.at, which is keyless and reliable.

import { condense, fetchJson } from "./util.mjs";

const NASA_KEY = process.env.NASA_API_KEY ?? "DEMO_KEY";
const APOD_URL = `https://api.nasa.gov/planetary/apod?api_key=${NASA_KEY}`;
const NEO_URL = (date) =>
  `https://api.nasa.gov/neo/rest/v1/feed?start_date=${date}&end_date=${date}&api_key=${NASA_KEY}`;
const ISS_URL = "https://api.wheretheiss.at/v1/satellites/25544";

export const Space = {
  name: "space",
  // The three sub-feeds have very different cadences. We pick whichever has
  // a fresh item to publish on each fetchItems() call by polling all three
  // and merging — the narrator dedupes by id.
  refreshEveryMs: 30 * 60_000,
  /** @param {AbortSignal} signal */
  async fetchItems(signal) {
    const [apod, neo, iss] = await Promise.allSettled([
      fetchApod(signal),
      fetchNeo(signal),
      fetchIss(signal),
    ]);
    const out = [];
    if (apod.status === "fulfilled" && apod.value) out.push(apod.value);
    if (neo.status === "fulfilled") out.push(...neo.value);
    if (iss.status === "fulfilled" && iss.value) out.push(iss.value);
    return out;
  },
};

// APOD + NEO are daily feeds — cache by UTC date so the narrator's frequent
// refreshes don't burn NASA's free quota. ISS is left uncached so its position
// stays current across polls.
let apodCache = { date: "", item: /** @type {object|null} */ (null) };
let neoCache = { date: "", items: /** @type {object[]} */ ([]) };

async function fetchApod(signal) {
  const today = new Date().toISOString().slice(0, 10);
  if (apodCache.date === today && apodCache.item) return apodCache.item;
  const data = await fetchJson(APOD_URL, signal);
  if (!data?.title || !data?.date) return null;
  // Stable id per APOD so we don't repeat the same picture all day.
  const item = {
    id: `apod:${data.date}`,
    kind: "space",
    text: condense(`${data.title} — ${data.explanation ?? "today's astronomy picture"}`, 180),
    href: `https://apod.nasa.gov/apod/ap${apodDateSlug(data.date)}.html`,
    linkLabel: "apod",
    publishedAt: Date.parse(data.date) || Date.now(),
    score: 0.7,
  };
  apodCache = { date: today, item };
  return item;
}

async function fetchNeo(signal) {
  const today = new Date().toISOString().slice(0, 10);
  if (neoCache.date === today) return neoCache.items;
  const data = await fetchJson(NEO_URL(today), signal);
  const list = data?.near_earth_objects?.[today] ?? [];
  // Pick the closest 3 of the day so we don't flood the channel.
  const ranked = list
    .map((n) => ({ n, miss: missKm(n) }))
    .filter((r) => r.miss !== null)
    .sort((a, b) => a.miss - b.miss)
    .slice(0, 3);
  const out = [];
  for (const { n, miss } of ranked) {
    const diam = avgDiameterMeters(n);
    if (diam === null) continue;
    const speed = approachVelocityKmh(n);
    const sizeRef = sizeReference(diam);
    // "name" in the API is a parenthesised designation like "(2024 XK1)".
    const designation = String(n.name ?? "").replace(/^[()\s]+|[()\s]+$/g, "");
    const text = `asteroid ${designation} — about the size of ${sizeRef}, passes Earth today` +
      (speed ? ` at ${formatNumber(speed)} km/h` : "") +
      ` (miss: ${formatNumber(miss)} km)`;
    out.push({
      id: `neo:${today}:${n.id}`,
      kind: "space",
      text: condense(text, 200),
      href: typeof n.nasa_jpl_url === "string" ? n.nasa_jpl_url : undefined,
      linkLabel: "jpl",
      publishedAt: Date.now(),
      // Hazardous ones rank higher — the dino notices.
      score: n.is_potentially_hazardous_asteroid ? 0.8 : 0.5,
    });
  }
  neoCache = { date: today, items: out };
  return out;
}

async function fetchIss(signal) {
  const data = await fetchJson(ISS_URL, signal);
  if (typeof data?.latitude !== "number" || typeof data?.longitude !== "number") return null;
  const lat = data.latitude;
  const lon = data.longitude;
  const region = regionFor(lat, lon);
  const altKm = Math.round(data.altitude ?? 408);
  const velKmh = Math.round(data.velocity ?? 27600);
  // Bucket id to a 30-minute window so we don't republish constantly.
  const slot = Math.floor(Date.now() / (30 * 60_000));
  return {
    id: `iss:${slot}`,
    kind: "space",
    text: `ISS over ${region} — ${altKm} km up, moving at ${formatNumber(velKmh)} km/h`,
    href: "https://spotthestation.nasa.gov/",
    linkLabel: "spot it",
    publishedAt: Date.now(),
    score: 0.55,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────

function apodDateSlug(date) {
  // "2026-04-25" → "260425" matching apod.nasa.gov/apod/apYYMMDD.html
  const [y, m, d] = date.split("-");
  return `${y.slice(2)}${m}${d}`;
}

function missKm(neo) {
  const v = neo?.close_approach_data?.[0]?.miss_distance?.kilometers;
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function approachVelocityKmh(neo) {
  const v = neo?.close_approach_data?.[0]?.relative_velocity?.kilometers_per_hour;
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? Math.round(n) : null;
}

function avgDiameterMeters(neo) {
  const min = neo?.estimated_diameter?.meters?.estimated_diameter_min;
  const max = neo?.estimated_diameter?.meters?.estimated_diameter_max;
  if (typeof min !== "number" || typeof max !== "number") return null;
  return (min + max) / 2;
}

function sizeReference(meters) {
  if (meters < 5) return "a fridge";
  if (meters < 12) return "a car";
  if (meters < 25) return "a school bus";
  if (meters < 50) return "a house";
  if (meters < 110) return "a football field";
  if (meters < 200) return "a city block";
  if (meters < 400) return "an aircraft carrier";
  if (meters < 800) return "a small skyscraper";
  return "a mountain";
}

function formatNumber(n) {
  return Math.round(n).toLocaleString("en-US");
}

/**
 * Coarse continent / ocean lookup from lat/lon. Doesn't try to be cartographically
 * exact — the goal is a recognisable name to make the position concrete
 * ("Antarctica" reads better than "78°S 12°E").
 */
function regionFor(lat, lon) {
  if (lat > 66.5) return "the Arctic";
  if (lat < -60) return "Antarctica";

  // Continents — broad bounding boxes, ordered so the most likely matches win.
  if (lon >= -170 && lon <= -55 && lat >= 7 && lat <= 75) return "North America";
  if (lon >= -82 && lon <= -34 && lat >= -55 && lat <= 12) return "South America";
  if (lon >= -10 && lon <= 60 && lat >= 35 && lat <= 70) return "Europe";
  if (lon >= -18 && lon <= 52 && lat >= -35 && lat <= 35) return "Africa";
  if (lon >= 60 && lon <= 150 && lat >= 5 && lat <= 55) return "Asia";
  if (lon >= 110 && lon <= 155 && lat >= -45 && lat <= -10) return "Australia";

  // Otherwise we're over an ocean. Lon ranges are rough but readable.
  if (lon >= -70 && lon <= 20) return "the Atlantic";
  if (lon > 20 && lon <= 110) return "the Indian Ocean";
  return "the Pacific";
}
