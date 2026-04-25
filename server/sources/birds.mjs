// eBird notable sightings — rare or unusual birds reported recently from a
// rotating set of birding hotspots around the world. Free API, requires a
// personal token in EBIRD_API_KEY (sign up at ebird.org/api/keygen). Each
// fetch picks two random hotspots and pulls their top notable observations,
// so the channel feels global and varied rather than stuck on one region.

import { condense } from "./util.mjs";

const NOTABLE_URL = (lat, lng, dist = 50) =>
  `https://api.ebird.org/v2/data/obs/geo/recent/notable?lat=${lat}&lng=${lng}&dist=${dist}&maxResults=10`;
const SPECIES_URL = (code) => `https://ebird.org/species/${encodeURIComponent(code)}`;

// Birding hotspots worldwide. Each entry is [name, lat, lng]. Curated for
// variety across continents and habitats — adds new ones at the bottom.
const HOTSPOTS = [
  ["London, UK",                   51.5074,   -0.1278],
  ["Cape May, NJ",                 38.9351,  -74.9060],
  ["Yamagata, Japan",              38.2554,  140.3396],
  ["Kakamega Forest, Kenya",        0.2837,   34.8825],
  ["Pantanal, Brazil",            -16.5000,  -56.5000],
  ["Kruger National Park, ZA",    -23.9884,   31.5547],
  ["Daintree, Australia",         -16.2520,  145.4200],
  ["Galápagos Islands",            -0.6553,  -90.5511],
  ["Yellowstone, USA",             44.4280, -110.5885],
  ["Reykjavík, Iceland",           64.1466,  -21.9426],
  ["Doñana, Spain",                37.0017,   -6.4358],
  ["Kerala backwaters, India",      9.5916,   76.5222],
  ["Andasibe, Madagascar",        -18.9333,   48.4167],
  ["Monteverde, Costa Rica",       10.3010,  -84.8195],
  ["Panama Canal Zone",             9.0817,  -79.6889],
  ["Cairns, Australia",           -16.9186,  145.7781],
  ["Vancouver Island, Canada",     49.6502, -125.4490],
  ["Kakadu, Australia",           -12.5269,  132.8284],
  ["Hokkaido, Japan",              43.2203,  142.8635],
  ["Patagonia, Argentina",        -41.8101,  -68.9063],
];

/** Pick `n` distinct hotspots at random. */
function sampleHotspots(n) {
  const pool = HOTSPOTS.slice();
  const out = [];
  while (out.length < n && pool.length > 0) {
    const i = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

export function createBirds(opts = {}) {
  const apiKey = opts.apiKey ?? process.env.EBIRD_API_KEY;

  return {
    name: "ebird-notable",
    refreshEveryMs: 45 * 60_000,
    /** @param {AbortSignal} signal */
    async fetchItems(signal) {
      if (!apiKey) return [];
      const picks = sampleHotspots(2);
      const all = await Promise.allSettled(
        picks.map(([name, lat, lng]) => fetchAt(apiKey, name, lat, lng, signal))
      );
      const out = [];
      for (const r of all) {
        if (r.status === "fulfilled") out.push(...r.value);
      }
      // Cap per refresh — sources are noisy if every hotspot returns 10+
      // items. The narrator ranks by recency anyway, so trimming here keeps
      // the pool moving.
      return out.slice(0, 6);
    },
  };
}

async function fetchAt(apiKey, hotspotName, lat, lng, signal) {
  /** @type {any[]} */
  let data;
  try {
    data = await fetchJsonWithKey(NOTABLE_URL(lat, lng), apiKey, signal);
  } catch (err) {
    if (err && err.name !== "AbortError") {
      console.warn(`[ebird] ${hotspotName} fetch failed:`, err?.message ?? err);
    }
    return [];
  }
  if (!Array.isArray(data) || data.length === 0) return [];
  // Sort newest first by obsDt, take top 3 distinct species.
  const seenSpecies = new Set();
  const picks = data
    .slice()
    .sort((a, b) => (b?.obsDt ?? "").localeCompare(a?.obsDt ?? ""))
    .filter((o) => {
      if (!o?.speciesCode) return false;
      if (seenSpecies.has(o.speciesCode)) return false;
      seenSpecies.add(o.speciesCode);
      return true;
    })
    .slice(0, 3);

  const out = [];
  for (const o of picks) {
    if (!o?.comName || !o?.locName || !o?.obsDt) continue;
    out.push({
      // Stable id: species + observation date so the same sighting reported
      // by multiple observers doesn't spawn duplicates.
      id: `bird:${o.speciesCode}:${o.obsDt}`,
      kind: "bird",
      text: condense(formatSighting(o, hotspotName), 200),
      href: o.speciesCode ? SPECIES_URL(o.speciesCode) : undefined,
      linkLabel: "ebird",
      publishedAt: parseObsDate(o.obsDt) ?? Date.now(),
      score: scoreFor(o),
    });
  }
  return out;
}

function formatSighting(o, hotspotName) {
  const count =
    typeof o.howMany === "number" && o.howMany > 1
      ? ` (${o.howMany} of them)`
      : "";
  // Privacy-respecting: locationPrivate observations get just the hotspot
  // region, not the precise locName.
  const where = o.locationPrivate
    ? `near ${hotspotName}`
    : `${o.locName}, near ${hotspotName}`;
  return `rare sighting: ${o.comName}${count} — ${where}`;
}

function parseObsDate(s) {
  // eBird format: "2026-04-25 16:30" — local time with no zone. Treat as UTC
  // for the purposes of recency ranking; we're not doing anything that needs
  // a real timezone.
  const d = new Date(String(s).replace(" ", "T") + "Z");
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

function scoreFor(o) {
  // obsValid + obsReviewed indicate the eBird community has confirmed the
  // sighting. Confirmed birds rank higher; otherwise stay around news/quake
  // baseline so the channel doesn't dominate.
  let s = 0.45;
  if (o.obsReviewed) s += 0.2;
  if (o.obsValid) s += 0.1;
  return Math.min(0.9, s);
}

// fetchJson in util.mjs sets accept/user-agent and handles abort + timeout,
// but doesn't accept arbitrary headers. eBird needs an X-eBirdApiToken header,
// so we wrap fetch directly here while preserving the same timeout behavior.
async function fetchJsonWithKey(url, apiKey, signal) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(new Error(`timeout`)), 10_000);
  timeout.unref?.();
  const abort = () => ctrl.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        accept: "application/json",
        "user-agent": "dinosaurus-archive/0.1",
        "X-eBirdApiToken": apiKey,
      },
    });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}
