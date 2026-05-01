// Tiny in-memory archive for the dino's sorted items.
//
// Everyone who loads the page shares the same archive, so a visitor who shows
// up later sees what the dino has been sorting for the past day. Items older
// than ARCHIVE_TTL_MS are pruned on every read and write.
//
// No database — the data is intentionally ephemeral. A redeploy clears it,
// which is fine for a 24-hour rolling window.

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname } from "node:path";

import { Narrator } from "./narrator.mjs";
import { createBirds } from "./sources/birds.mjs";
import { DevTo } from "./sources/devto.mjs";
import { Facts } from "./sources/facts.mjs";
import { HackerNews } from "./sources/hn.mjs";
import { createMusings } from "./sources/musings.mjs";
import { Quakes } from "./sources/quakes.mjs";
import { createSfxPrompter } from "./sources/sfx.mjs";
import { Space } from "./sources/space.mjs";
import { decodeEntities } from "./sources/util.mjs";

const PORT = Number(process.env.PORT ?? 8080);
const ARCHIVE_TTL_MS = 24 * 60 * 60 * 1000;
/** Hard cap per kind so a misbehaving client can't blow up memory. */
const MAX_PER_KIND = 1000;
/**
 * Optional disk path for snapshotting the bins between restarts. When set
 * (e.g. /data/bins.json on a Railway volume), the server loads from it on
 * boot and writes back periodically + on shutdown so a redeploy doesn't
 * wipe the 24-hour archive. Unset = original in-memory-only behavior.
 */
const ARCHIVE_PERSIST_PATH = process.env.ARCHIVE_PERSIST_PATH ?? null;
const ARCHIVE_PERSIST_INTERVAL_MS = 60_000;
const ACTIVE_ITEM_TTL_MS = 5 * 60_000;
const CLAIM_LEASE_MS = 45_000;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
let activeSequence = 0;
const ALLOWED_KINDS = new Set([
  "news",
  "weather",
  "fact",
  "quake",
  "space",
  "bird",
]);
const DEFAULT_CHANNELS = ["news", "fact", "quake", "space", "bird"];
const PACES = new Set(["chill", "normal", "busy"]);

/**
 * Origins allowed to call /archive and /events. Configurable via env var so
 * a future custom domain (or staging frontend) can be added without a
 * redeploy of the source. Localhost ports cover Vite's dev (5173/5174) and
 * preview (4173) servers and the static-server.mjs default (4173).
 */
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS ??
    [
      "https://dino.zaur.app",
      "http://localhost:5173",
      "http://localhost:5174",
      "http://localhost:4173",
    ].join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

/** @type {Map<string, Array<{ id: string, kind: string, text: string, href?: string, linkLabel?: string, deliveredAt: number }>>} */
const bins = new Map();

/** @type {Map<string, { id: string, kind: string, text: string, href?: string, linkLabel?: string, publishedAt: number, score: number, spawnedAt: number, claimedBy?: string, claimUntil?: number }>} */
const activeItems = new Map();

/**
 * Rolling window of recent items the narrator has emitted. Read by the
 * Musings source so Claude can ground the dino's thoughts in what's
 * actually been in the air.
 */
const RECENT_ITEMS_MAX = 16;
/** @type {Array<{ kind: string, text: string }>} */
const recentSpokenItems = [];
function pushRecentItem(item) {
  recentSpokenItems.push({ kind: item.kind, text: item.text });
  if (recentSpokenItems.length > RECENT_ITEMS_MAX) recentSpokenItems.shift();
}

/** @type {Set<{ res: import("node:http").ServerResponse, hb: NodeJS.Timeout }>} */
const sseClients = new Set();

/** @type {Set<{ id: string, socket: import("node:net").Socket, buffer: Buffer, preferences: { channels: string[], pace: string } }>} */
const wsClients = new Set();

function totalCount() {
  let n = 0;
  for (const list of bins.values()) n += list.length;
  return n;
}

function prune() {
  const cutoff = Date.now() - ARCHIVE_TTL_MS;
  for (const [kind, list] of bins) {
    const fresh = list.filter((it) => it.deliveredAt >= cutoff);
    if (fresh.length === 0) bins.delete(kind);
    else if (fresh.length !== list.length) bins.set(kind, fresh);
  }
}

// ── Disk snapshot persistence ────────────────────────────────────────────
//
// Bins live in memory. To survive a redeploy we periodically serialise them
// to a JSON file (typically on a Railway volume) and reload on the next
// boot. Atomic via tmp-file + rename so a crash mid-write can't corrupt the
// snapshot. A dirty flag avoids needless writes when nothing has changed.

let archiveDirty = false;
function markArchiveDirty() {
  archiveDirty = true;
}

function loadArchiveFromDisk() {
  if (!ARCHIVE_PERSIST_PATH) return;
  let raw;
  try {
    raw = readFileSync(ARCHIVE_PERSIST_PATH, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log(`[archive] no snapshot at ${ARCHIVE_PERSIST_PATH} — starting empty`);
    } else {
      console.warn(`[archive] could not read snapshot, starting empty:`, err.message);
    }
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[archive] snapshot malformed, starting empty:`, err.message);
    return;
  }
  if (!parsed || typeof parsed !== "object" || !parsed.bins || typeof parsed.bins !== "object") {
    console.warn(`[archive] snapshot has unexpected shape, starting empty`);
    return;
  }
  const cutoff = Date.now() - ARCHIVE_TTL_MS;
  let total = 0;
  for (const [kind, list] of Object.entries(parsed.bins)) {
    if (!ALLOWED_KINDS.has(kind) || !Array.isArray(list)) continue;
    const fresh = list
      .filter(
        (it) =>
          it &&
          typeof it === "object" &&
          typeof it.id === "string" &&
          it.kind === kind &&
          typeof it.text === "string" &&
          typeof it.deliveredAt === "number" &&
          it.deliveredAt >= cutoff
      )
      .map((it) => ({
        ...it,
        // Older snapshots may carry source-encoded entities (e.g. HN's
        // "Adobe&#39;s") — decode once at load so every render path is
        // dealing with canonical UTF-8.
        text: decodeEntities(it.text),
        ...(typeof it.linkLabel === "string"
          ? { linkLabel: decodeEntities(it.linkLabel) }
          : {}),
      }))
      .slice(0, MAX_PER_KIND);
    if (fresh.length > 0) {
      bins.set(kind, fresh);
      total += fresh.length;
    }
  }
  console.log(
    `[archive] loaded ${total} item${total === 1 ? "" : "s"} from ${ARCHIVE_PERSIST_PATH}`
  );
}

function saveArchiveToDisk(force = false) {
  if (!ARCHIVE_PERSIST_PATH) return;
  if (!archiveDirty && !force) return;
  try {
    prune();
    const out = {};
    for (const [kind, list] of bins) out[kind] = list;
    const payload = JSON.stringify({ savedAt: Date.now(), bins: out });
    const tmp = `${ARCHIVE_PERSIST_PATH}.tmp`;
    mkdirSync(dirname(ARCHIVE_PERSIST_PATH), { recursive: true });
    writeFileSync(tmp, payload);
    renameSync(tmp, ARCHIVE_PERSIST_PATH);
    archiveDirty = false;
  } catch (err) {
    console.warn(`[archive] snapshot write failed:`, err.message);
  }
}

function snapshot() {
  prune();
  /** @type {Record<string, unknown[]>} */
  const out = {};
  for (const [kind, list] of bins) out[kind] = list;
  return { bins: out, active: [...activeItems.values()].map(publicActiveItem), ttlMs: ARCHIVE_TTL_MS };
}

function publicActiveItem(item) {
  const { claimedBy, claimUntil, sourceId, ...rest } = item;
  return rest;
}

function defaultPreferences() {
  return { channels: DEFAULT_CHANNELS.slice(), pace: "normal" };
}

function normalizePreferences(raw, previous = defaultPreferences()) {
  if (!raw || typeof raw !== "object") return previous;
  const channels = Array.isArray(raw.channels)
    ? raw.channels.filter((kind) => DEFAULT_CHANNELS.includes(kind))
    : previous.channels;
  const pace = typeof raw.pace === "string" && PACES.has(raw.pace) ? raw.pace : previous.pace;
  return {
    channels: channels.length > 0 ? [...new Set(channels)] : previous.channels,
    pace,
  };
}

function itemMatchesClient(client, item) {
  return client.preferences.channels.includes(item.kind);
}

function activeForClient(client) {
  return [...activeItems.values()].filter((item) => itemMatchesClient(client, item)).map(publicActiveItem);
}

/**
 * Stable identifier for dedup. The narrator emits items with a `sourceId`
 * (the upstream-stable id, e.g. "hn:42") and a per-run `id` like
 * "hn:42:run:abc:5". For dedup against bins we always want the sourceId,
 * so legacy entries that only carry the run-id form fall back to stripping
 * the ":run:" suffix.
 */
function lookupId(item) {
  if (typeof item?.sourceId === "string" && item.sourceId.length > 0) {
    return item.sourceId;
  }
  const id = typeof item?.id === "string" ? item.id : "";
  const idx = id.indexOf(":run:");
  return idx >= 0 ? id.slice(0, idx) : id;
}

function isKnown(srcId) {
  for (const item of activeItems.values()) {
    if (lookupId(item) === srcId) return true;
  }
  for (const list of bins.values()) {
    for (const item of list) {
      if (lookupId(item) === srcId) return true;
    }
  }
  return false;
}

function activeItemFromSource(item) {
  activeSequence = (activeSequence + 1) % Number.MAX_SAFE_INTEGER;
  return {
    ...item,
    sourceId: item.id,
    id: `${item.id}:run:${Date.now().toString(36)}:${activeSequence.toString(36)}`,
    spawnedAt: Date.now(),
  };
}

function addDeliveredItem(item) {
  const list = bins.get(item.kind) ?? [];
  const sid = lookupId(item);
  const filtered = list.filter((d) => lookupId(d) !== sid);
  filtered.unshift(item);
  if (filtered.length > MAX_PER_KIND) filtered.length = MAX_PER_KIND;
  bins.set(item.kind, filtered);
  activeItems.delete(item.id);
  markArchiveDirty();
  broadcastEvent({ type: "add", item });
  broadcastRealtime({ type: "item_delivered", item });
}

/**
 * Push a typed event to every SSE subscriber. Events are deltas — a single
 * added item or a list of expired ids — so the per-client egress on a busy
 * archive is bounded by the size of the change, not the size of the whole
 * archive. Clients that connect mid-stream receive a `snapshot` event up
 * front to seed their state.
 */
function broadcastEvent(event) {
  if (sseClients.size === 0) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      client.res.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

function sendRealtime(client, event) {
  if (client.socket.destroyed) return;
  try {
    client.socket.write(encodeWsText(JSON.stringify(event)));
  } catch {
    wsClients.delete(client);
  }
}

function broadcastRealtime(event) {
  for (const client of wsClients) sendRealtime(client, event);
}

function broadcastRealtimeForItem(event, item) {
  for (const client of wsClients) {
    if (itemMatchesClient(client, item)) sendRealtime(client, event);
  }
}

function encodeWsText(text) {
  const body = Buffer.from(text);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x81, body.length]);
  } else if (body.length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

function decodeWsFrames(client) {
  const messages = [];
  while (client.buffer.length >= 2) {
    const first = client.buffer[0];
    const second = client.buffer[1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (client.buffer.length < offset + 2) break;
      length = client.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (client.buffer.length < offset + 8) break;
      const big = client.buffer.readBigUInt64BE(offset);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        client.socket.destroy();
        return messages;
      }
      length = Number(big);
      offset += 8;
    }
    if (!masked) {
      client.socket.destroy();
      return messages;
    }
    if (client.buffer.length < offset + 4 + length) break;
    const mask = client.buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(client.buffer.subarray(offset, offset + length));
    client.buffer = client.buffer.subarray(offset + length);
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    if (opcode === 0x8) {
      client.socket.end(Buffer.from([0x88, 0x00]));
      return messages;
    }
    if (opcode === 0x1) messages.push(payload.toString("utf-8"));
  }
  return messages;
}

// Drain expired items so connected clients see them disappear in real time
// without waiting for the next read. We also broadcast the *ids* that left
// so clients can patch their state without reloading the whole archive.
setInterval(() => {
  const now = Date.now();
  const cutoff = now - ARCHIVE_TTL_MS;
  /** @type {string[]} */
  const expired = [];
  for (const [kind, list] of bins) {
    const fresh = list.filter((it) => {
      if (it.deliveredAt < cutoff) {
        expired.push(it.id);
        return false;
      }
      return true;
    });
    if (fresh.length === 0) bins.delete(kind);
    else if (fresh.length !== list.length) bins.set(kind, fresh);
  }
  if (expired.length > 0) {
    markArchiveDirty();
    broadcastEvent({ type: "expire", ids: expired });
    broadcastRealtime({ type: "items_expired", ids: expired });
  }

  /** @type {string[]} */
  const activeExpired = [];
  for (const [id, item] of activeItems) {
    if (item.claimUntil && item.claimUntil <= now) {
      delete item.claimedBy;
      delete item.claimUntil;
      broadcastRealtimeForItem({ type: "item_released", id, item: publicActiveItem(item) }, item);
    }
    if (now - item.spawnedAt >= ACTIVE_ITEM_TTL_MS) {
      activeItems.delete(id);
      activeExpired.push(id);
    }
  }
  if (activeExpired.length > 0) {
    broadcastEvent({ type: "expire", ids: activeExpired });
    broadcastRealtime({ type: "items_expired", ids: activeExpired });
  }
}, 60_000).unref();

/**
 * Echo back the request Origin only if it's in our allowlist. Browsers
 * block cross-origin XHR/fetch when the header is missing, which is the
 * desired behaviour for unknown origins. Same-origin and tooling requests
 * (no Origin header — e.g. curl) are unaffected.
 */
function setCors(req, res) {
  const origin = req.headers.origin;
  if (typeof origin === "string" && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function sendJson(req, res, status, body) {
  setCors(req, res);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 8_192) throw new Error("payload too large");
    chunks.push(chunk);
  }
  if (total === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

// ── Radio (Navidrome / Subsonic) ─────────────────────────────────────────
//
// The dino's radio plays random tracks from per-channel Navidrome playlists.
// Credentials live in env vars so they never reach the browser; the client
// hits /radio/track to discover what to play next, then loads the audio
// from /radio/stream/<id> which proxies the actual bytes from Navidrome
// (with a Range header pass-through so the browser can seek).

const NAVIDROME_URL = (process.env.NAVIDROME_URL ?? "").replace(/\/$/, "");
const NAVIDROME_USER = process.env.NAVIDROME_USER ?? "";
const NAVIDROME_PASSWORD = process.env.NAVIDROME_PASSWORD ?? "";
const NAVIDROME_CONFIGURED = !!(NAVIDROME_URL && NAVIDROME_USER && NAVIDROME_PASSWORD);

/** Shared secret for the /admin/* endpoints. Empty disables them entirely. */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";

// ── TTS (ElevenLabs) ─────────────────────────────────────────────────────
//
// Optional voice for dino's thoughts. When ELEVENLABS_API_KEY is set, the
// /tts endpoint proxies a stream of MP3 audio for a given thought back to
// the client. Key never leaves the server.
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY ?? "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? "1LHhf1fWEA2SA0ReEViX";
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID ?? "eleven_v3";
const TTS_MAX_TEXT_LENGTH = 500;

// ── SFX (ElevenLabs sound generation) ────────────────────────────────────
//
// On a slow cadence the archive picks a recent narrator item, asks Claude
// Haiku for a short evocative prompt, runs it through ElevenLabs sound
// generation, and broadcasts a `dino_sfx` event. The audio lives in an
// in-memory cache keyed by an opaque token; clients fetch it via
// /sfx/<token> for a few minutes before it's GC'd.
const SFX_INTERVAL_BASE_MS = 6 * 60_000;
const SFX_INTERVAL_JITTER_MS = 4 * 60_000;
const SFX_INITIAL_DELAY_MS = 60_000;
const SFX_DURATION_SECONDS = 2.5;
const SFX_PROMPT_INFLUENCE = 0.3;
const SFX_CACHE_TTL_MS = 5 * 60_000;
const SFX_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Maps each radio channel to the Navidrome playlist name we should pick
 * from. Singular channel names (quake/fact/bird) target plural
 * playlists (quakes/facts/birds) to match how a human user thinks
 * about them. The "all" channel is the catch-all fallback for any empty
 * channel-specific playlist.
 */
const RADIO_PLAYLIST = {
  all: "all",
  news: "news",
  quake: "quakes",
  fact: "facts",
  space: "space",
  bird: "birds",
};

/** Cache of all playlists. Refreshed every PLAYLIST_CACHE_MS — playlists
 *  rarely change, but we want new ones to appear within ~30s of creation. */
const PLAYLIST_CACHE_MS = 30_000;
let playlistCache = null;
let playlistCacheAt = 0;

/** Cache of each playlist's track entries. Same TTL — adding songs to a
 *  curated channel should appear quickly. */
const PLAYLIST_CONTENTS_CACHE_MS = 30_000;
const playlistContentsCache = new Map();

function subsonicUrl(endpoint, extra = {}) {
  if (!NAVIDROME_CONFIGURED) return null;
  const salt = randomUUID().replace(/-/g, "").slice(0, 12);
  const token = createHash("md5")
    .update(NAVIDROME_PASSWORD + salt)
    .digest("hex");
  const params = new URLSearchParams();
  params.set("u", NAVIDROME_USER);
  params.set("t", token);
  params.set("s", salt);
  params.set("v", "1.16.1");
  params.set("c", "dinosaurus");
  params.set("f", "json");
  // Subsonic uses repeated keys for list params (e.g. songId=A&songId=B), so
  // arrays expand into multiple appends rather than a comma-joined string.
  for (const [k, v] of Object.entries(extra)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      for (const item of v) params.append(k, String(item));
    } else {
      params.append(k, String(v));
    }
  }
  return `${NAVIDROME_URL}/rest/${endpoint}?${params}`;
}

async function subsonicJson(endpoint, params = {}) {
  const url = subsonicUrl(endpoint, params);
  if (!url) throw new Error("navidrome not configured");
  const resp = await fetch(url, { headers: { accept: "application/json" } });
  if (!resp.ok) throw new Error(`navidrome ${endpoint}: HTTP ${resp.status}`);
  const body = await resp.json();
  const sub = body?.["subsonic-response"];
  if (!sub || sub.status !== "ok") {
    throw new Error(
      `navidrome ${endpoint}: ${sub?.error?.message ?? "non-ok response"}`
    );
  }
  return sub;
}

async function getAllPlaylists() {
  const now = Date.now();
  if (playlistCache && now - playlistCacheAt < PLAYLIST_CACHE_MS) return playlistCache;
  const sub = await subsonicJson("getPlaylists.view");
  // The Subsonic schema wraps the array under playlists.playlist.
  playlistCache = Array.isArray(sub?.playlists?.playlist) ? sub.playlists.playlist : [];
  playlistCacheAt = now;
  return playlistCache;
}

async function getPlaylistEntries(playlistId) {
  const cached = playlistContentsCache.get(playlistId);
  const now = Date.now();
  if (cached && now - cached.at < PLAYLIST_CONTENTS_CACHE_MS) return cached.entries;
  const sub = await subsonicJson("getPlaylist.view", { id: playlistId });
  const entries = Array.isArray(sub?.playlist?.entry) ? sub.playlist.entry : [];
  playlistContentsCache.set(playlistId, { entries, at: now });
  return entries;
}

/**
 * Find the playlist whose name matches `targetName` (case-insensitive). The
 * Subsonic API has no name-based lookup, so we scan the (cached) list.
 */
function findPlaylistByName(playlists, targetName) {
  const target = targetName.toLowerCase();
  return playlists.find((p) => typeof p?.name === "string" && p.name.toLowerCase() === target);
}

async function pickRandomEntry(channel, avoidId) {
  const wanted = RADIO_PLAYLIST[channel];
  if (!wanted) return { error: "unknown channel", status: 400 };

  let playlists;
  try {
    playlists = await getAllPlaylists();
  } catch (err) {
    return { error: `navidrome unreachable: ${err.message}`, status: 502 };
  }

  let pl = findPlaylistByName(playlists, wanted);
  let usedFallback = false;
  if (!pl && wanted !== "all") {
    pl = findPlaylistByName(playlists, "all");
    usedFallback = true;
  }
  if (!pl) return { error: "no matching playlist", status: 503 };

  let entries;
  try {
    entries = await getPlaylistEntries(pl.id);
  } catch (err) {
    return { error: `navidrome read failed: ${err.message}`, status: 502 };
  }
  if (entries.length === 0) {
    if (!usedFallback && wanted !== "all") {
      const allPl = findPlaylistByName(playlists, "all");
      if (allPl) {
        try {
          entries = await getPlaylistEntries(allPl.id);
          pl = allPl;
          usedFallback = true;
        } catch {
          /* fall through to empty error */
        }
      }
    }
    if (entries.length === 0) return { error: "playlist is empty", status: 503 };
  }

  // Avoid replaying the same track twice in a row when there's a choice.
  const choices = avoidId ? entries.filter((e) => String(e.id) !== avoidId) : entries;
  const pool = choices.length > 0 ? choices : entries;
  const entry = pool[Math.floor(Math.random() * pool.length)];
  return {
    entry: {
      id: String(entry.id),
      title: typeof entry.title === "string" ? entry.title : "",
      artist: typeof entry.artist === "string" ? entry.artist : "",
      album: typeof entry.album === "string" ? entry.album : "",
      // Subsonic returns duration in whole seconds; convert to ms (or null).
      durationMs: typeof entry.duration === "number" ? entry.duration * 1000 : null,
    },
    playlistName: pl?.name ?? wanted,
    fallback: usedFallback,
  };
}

/**
 * Pipe a Subsonic stream through us so the credentials never reach the
 * client. Forwards the Range header so the browser can seek; mirrors the
 * status code (200 / 206) and the headers needed for media playback.
 */
function proxyStream(targetUrl, req, res) {
  const u = new URL(targetUrl);
  const transport = u.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = transport(
    {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method: "GET",
      headers: req.headers.range ? { range: req.headers.range } : {},
    },
    (upRes) => {
      setCors(req, res);
      const passthrough = [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
        "last-modified",
        "etag",
        "cache-control",
      ];
      const out = {};
      for (const h of passthrough) {
        const v = upRes.headers[h];
        if (v !== undefined) out[h] = v;
      }
      res.writeHead(upRes.statusCode ?? 502, out);
      upRes.pipe(res);
    }
  );
  upstream.on("error", (err) => {
    console.warn("[radio] stream proxy error:", err.message);
    if (!res.headersSent) sendJson(req, res, 502, { error: "stream upstream failed" });
    else res.destroy();
  });
  // If the client aborts (skips track / closes tab), tear down the upstream
  // request so we're not pulling bytes nobody is listening to.
  req.on("close", () => upstream.destroy());
  upstream.end();
}

/**
 * Proxy a TTS request to ElevenLabs and stream the MP3 back. Keeps the API
 * key server-side. Aborts the upstream call if the client disconnects mid
 * stream (e.g. dino moves on to the next thought).
 */
function proxyTts(text, req, res) {
  const path =
    `/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_VOICE_ID)}` +
    `?output_format=mp3_44100_64`;
  const upstream = httpsRequest(
    {
      protocol: "https:",
      hostname: "api.elevenlabs.io",
      port: 443,
      path,
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
    },
    (upRes) => {
      setCors(req, res);
      if (upRes.statusCode !== 200) {
        const chunks = [];
        upRes.on("data", (c) => chunks.push(c));
        upRes.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8").slice(0, 200);
          console.warn("[tts] upstream", upRes.statusCode, body);
          if (!res.headersSent) {
            sendJson(req, res, 502, {
              error: "tts upstream failed",
              status: upRes.statusCode,
            });
          } else {
            res.destroy();
          }
        });
        return;
      }
      res.writeHead(200, {
        "content-type": "audio/mpeg",
        "cache-control": "no-store",
      });
      upRes.pipe(res);
    }
  );
  upstream.on("error", (err) => {
    console.warn("[tts] proxy error:", err.message);
    if (!res.headersSent) sendJson(req, res, 502, { error: "tts proxy failed" });
    else res.destroy();
  });
  req.on("close", () => upstream.destroy());
  upstream.write(JSON.stringify({ text, model_id: ELEVENLABS_MODEL_ID }));
  upstream.end();
}

/**
 * In-memory store of generated sfx clips. Keyed by the random token we
 * embed in the broadcast event's URL. Clients have ~5 minutes to fetch
 * each clip before it's GC'd.
 *
 * @type {Map<string, { buf: Buffer, expiresAt: number }>}
 */
const sfxCache = new Map();

function gcSfxCache() {
  const now = Date.now();
  for (const [token, entry] of sfxCache) {
    if (entry.expiresAt <= now) sfxCache.delete(token);
  }
}

/**
 * Call ElevenLabs sound-generation and resolve with the full MP3 buffer.
 * Used by the slow sfx cadence — we buffer the whole clip (2-3 s, ~30 kB)
 * because we then serve it to N visitors out of an in-memory cache.
 */
function generateSfxAudio(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      text: prompt,
      duration_seconds: SFX_DURATION_SECONDS,
      prompt_influence: SFX_PROMPT_INFLUENCE,
    });
    const req = httpsRequest(
      {
        protocol: "https:",
        hostname: "api.elevenlabs.io",
        port: 443,
        path: "/v1/sound-generation?output_format=mp3_44100_64",
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "content-type": "application/json",
          accept: "audio/mpeg",
        },
        timeout: SFX_REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            const txt = Buffer.concat(chunks).toString("utf-8").slice(0, 200);
            reject(new Error(`upstream ${res.statusCode}: ${txt}`));
            return;
          }
          resolve(Buffer.concat(chunks));
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.write(body);
    req.end();
  });
}

/**
 * Reset the playlist caches so the next /radio/track call re-reads from
 * Navidrome. Used after we mutate playlists ourselves.
 */
function invalidatePlaylistCaches() {
  playlistCache = null;
  playlistCacheAt = 0;
  playlistContentsCache.clear();
}

/**
 * Page through Subsonic's search3 to enumerate every song id in the library.
 * Empty query returns all songs in Navidrome; we keep paging until a partial
 * page tells us we've reached the end.
 */
async function searchAllSongIds() {
  const PAGE = 500;
  const ids = [];
  let offset = 0;
  // Cap iterations so a misbehaving server can't loop us forever.
  for (let i = 0; i < 200; i++) {
    const sub = await subsonicJson("search3.view", {
      query: "",
      songCount: PAGE,
      songOffset: offset,
      artistCount: 0,
      albumCount: 0,
    });
    const list = sub?.searchResult3?.song ?? [];
    for (const s of list) {
      if (s?.id == null) continue;
      ids.push(String(s.id));
    }
    if (list.length < PAGE) break;
    offset += PAGE;
  }
  return ids;
}

/**
 * Resolve (or create) a playlist by name and reduce its contents to exactly
 * `libIds` via chunked updatePlaylist add/remove. Returns the diff stats.
 */
async function syncOnePlaylist(name, libIds) {
  const lower = name.toLowerCase();
  const playlists = await getAllPlaylists();
  const existing = playlists.find(
    (p) => typeof p?.name === "string" && p.name.toLowerCase() === lower
  );

  let playlistId;
  let action;
  if (existing) {
    playlistId = String(existing.id);
    action = "updated";
  } else if (libIds.length === 0) {
    // Don't materialize an empty playlist for a channel with no content yet.
    // The radio's fallback will route to `all` when this name is missing.
    return { name, action: "skipped", reason: "missing and empty", songCount: 0 };
  } else {
    const created = await subsonicJson("createPlaylist.view", {
      name,
      songId: libIds[0],
    });
    playlistId = created?.playlist?.id ? String(created.playlist.id) : null;
    if (!playlistId) {
      invalidatePlaylistCaches();
      const refreshed = await getAllPlaylists();
      const found = refreshed.find(
        (p) => typeof p?.name === "string" && p.name.toLowerCase() === lower
      );
      playlistId = found?.id ? String(found.id) : null;
    }
    if (!playlistId) throw new Error(`created '${name}' but couldn't find its id`);
    action = "created";
  }

  const currentEntries = action === "updated" ? await getPlaylistEntries(playlistId) : [];
  const libSet = new Set(libIds);
  const currentIdSet = new Set(currentEntries.map((e) => String(e.id)));

  const toAdd = libIds.filter((id) => !currentIdSet.has(id));
  // updatePlaylist treats indices positionally, so we remove from the back
  // forward to keep earlier indices stable while we chunk.
  const toRemoveIndices = [];
  currentEntries.forEach((e, i) => {
    if (!libSet.has(String(e.id))) toRemoveIndices.push(i);
  });
  toRemoveIndices.sort((a, b) => b - a);

  // URL length cap: Subsonic accepts repeated params, but ~4KB total query
  // breaks some intermediaries. 80 ids per request stays comfortably below.
  const CHUNK = 80;
  for (let i = 0; i < toRemoveIndices.length; i += CHUNK) {
    await subsonicJson("updatePlaylist.view", {
      playlistId,
      songIndexToRemove: toRemoveIndices.slice(i, i + CHUNK),
    });
  }
  for (let i = 0; i < toAdd.length; i += CHUNK) {
    await subsonicJson("updatePlaylist.view", {
      playlistId,
      songIdToAdd: toAdd.slice(i, i + CHUNK),
    });
  }

  return {
    name,
    action,
    playlistId,
    songCount: libIds.length,
    added: toAdd.length,
    removed: toRemoveIndices.length,
  };
}

/**
 * Per-channel playlist names, derived from the category bins so the
 * Navidrome side always mirrors the dino's bins. "all" is the synced
 * catch-all; the rest are user-curated shells we ensure exist.
 */
const PER_CHANNEL_PLAYLISTS = Object.values(RADIO_PLAYLIST).filter((n) => n !== "all");

/**
 * Ensure an empty playlist with `name` exists. If it already exists, leave
 * its contents alone; we only manage the shell so the user has a
 * destination to drag tracks into in the Navidrome UI.
 */
async function ensureEmptyPlaylist(name) {
  const playlists = await getAllPlaylists();
  const existing = findPlaylistByName(playlists, name);
  if (existing) {
    return { name, action: "exists", playlistId: String(existing.id) };
  }
  // Subsonic createPlaylist.view accepts `name` alone — songId is optional.
  const created = await subsonicJson("createPlaylist.view", { name });
  let playlistId = created?.playlist?.id ? String(created.playlist.id) : null;
  if (!playlistId) {
    invalidatePlaylistCaches();
    const refreshed = await getAllPlaylists();
    const found = findPlaylistByName(refreshed, name);
    playlistId = found?.id ? String(found.id) : null;
  }
  if (!playlistId) throw new Error(`created '${name}' but couldn't find its id`);
  return { name, action: "created", playlistId };
}

/**
 * Sync the radio's `all` playlist to mirror the entire Navidrome library
 * and ensure an empty shell exists for every per-channel playlist that
 * matches a category bin. Existing per-channel playlists are left alone
 * so user-curated contents are never overwritten — only the names are
 * guaranteed to exist. The runtime picker falls back to `all` whenever a
 * per-channel playlist is missing or empty.
 */
async function syncRadioPlaylists() {
  const ids = await searchAllSongIds();
  if (ids.length === 0) {
    return { ok: false, reason: "library empty", songCount: 0 };
  }

  invalidatePlaylistCaches();
  const playlists = [];
  try {
    playlists.push(await syncOnePlaylist("all", ids));
  } catch (err) {
    playlists.push({ name: "all", error: err.message });
  }
  for (const name of PER_CHANNEL_PLAYLISTS) {
    try {
      playlists.push(await ensureEmptyPlaylist(name));
    } catch (err) {
      playlists.push({ name, error: err.message });
    }
  }
  invalidatePlaylistCaches();

  return {
    ok: playlists.every((p) => !p.error),
    songCount: ids.length,
    playlists,
  };
}

function validate(item) {
  if (!item || typeof item !== "object") return null;
  const { id, kind, text, href, linkLabel } = item;
  if (typeof id !== "string" || id.length === 0 || id.length > 200) return null;
  if (typeof kind !== "string" || !ALLOWED_KINDS.has(kind)) return null;
  if (typeof text !== "string" || text.length === 0 || text.length > 600) return null;
  const cleaned = { id, kind, text, deliveredAt: Date.now() };
  if (typeof href === "string" && href.length <= 1000) cleaned.href = href;
  if (typeof linkLabel === "string" && linkLabel.length <= 80) cleaned.linkLabel = linkLabel;
  return cleaned;
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      setCors(req, res);
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(req, res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/archive") {
      sendJson(req, res, 200, snapshot());
      return;
    }

    if (req.method === "GET" && url.pathname === "/events") {
      setCors(req, res);
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // Hint to nginx/edge proxies not to buffer; harmless elsewhere.
        "x-accel-buffering": "no",
      });
      // Send the current archive state immediately so the client doesn't
      // have to race a separate /archive request. Subsequent events are
      // deltas (`add` / `expire`).
      const snap = snapshot();
      res.write(
        `data: ${JSON.stringify({ type: "snapshot", bins: snap.bins, ttlMs: snap.ttlMs })}\n\n`
      );
      const hb = setInterval(() => {
        try {
          res.write(`: ping\n\n`);
        } catch {
          /* socket gone — handled by close listener */
        }
      }, 25_000);
      const client = { res, hb };
      sseClients.add(client);
      req.on("close", () => {
        clearInterval(hb);
        sseClients.delete(client);
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/radio/track") {
      if (!NAVIDROME_CONFIGURED) {
        sendJson(req, res, 503, { error: "navidrome not configured" });
        return;
      }
      const channel = url.searchParams.get("channel") ?? "all";
      const avoid = url.searchParams.get("avoid") ?? null;
      const result = await pickRandomEntry(channel, avoid);
      if (result.error) {
        sendJson(req, res, result.status, { error: result.error });
        return;
      }
      // The stream URL points back at us — keeps Subsonic creds server-side.
      sendJson(req, res, 200, {
        ...result.entry,
        url: `/radio/stream/${encodeURIComponent(result.entry.id)}`,
        playlist: result.playlistName,
        fallback: result.fallback,
      });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/radio/stream/")) {
      if (!NAVIDROME_CONFIGURED) {
        sendJson(req, res, 503, { error: "navidrome not configured" });
        return;
      }
      const id = decodeURIComponent(url.pathname.slice("/radio/stream/".length));
      if (!id) {
        sendJson(req, res, 400, { error: "missing id" });
        return;
      }
      const target = subsonicUrl("stream.view", { id });
      if (!target) {
        sendJson(req, res, 503, { error: "navidrome not configured" });
        return;
      }
      proxyStream(target, req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin/refresh-playlists") {
      if (!NAVIDROME_CONFIGURED) {
        sendJson(req, res, 503, { error: "navidrome not configured" });
        return;
      }
      if (!ADMIN_TOKEN) {
        sendJson(req, res, 503, { error: "admin endpoint not configured" });
        return;
      }
      const headerToken =
        req.headers["x-admin-token"] ??
        (typeof req.headers.authorization === "string"
          ? req.headers.authorization.replace(/^Bearer\s+/i, "")
          : "");
      if (headerToken !== ADMIN_TOKEN) {
        sendJson(req, res, 401, { error: "unauthorized" });
        return;
      }
      try {
        const result = await syncRadioPlaylists();
        sendJson(req, res, 200, result);
      } catch (err) {
        console.warn("[admin] refresh-playlists failed:", err.message);
        sendJson(req, res, 502, { error: `refresh failed: ${err.message}` });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/archive") {
      let body;
      try {
        body = await readJson(req);
      } catch {
        sendJson(req, res, 400, { error: "invalid json" });
        return;
      }
      const item = validate(body);
      if (!item) {
        sendJson(req, res, 400, { error: "invalid item" });
        return;
      }
      addDeliveredItem(item);
      // The POSTing client already updated its own state optimistically; we
      // still send back a small ack so it knows the canonical timestamp.
      sendJson(req, res, 200, { ok: true, item });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/sfx/")) {
      const token = url.pathname.slice("/sfx/".length);
      const entry = sfxCache.get(token);
      if (!entry || entry.expiresAt <= Date.now()) {
        if (entry) sfxCache.delete(token);
        sendJson(req, res, 404, { error: "sfx not found" });
        return;
      }
      setCors(req, res);
      res.writeHead(200, {
        "content-type": "audio/mpeg",
        "cache-control": "no-store",
        "content-length": entry.buf.length,
      });
      res.end(entry.buf);
      return;
    }

    if (req.method === "POST" && url.pathname === "/tts") {
      if (!ELEVENLABS_API_KEY) {
        sendJson(req, res, 503, { error: "tts not configured" });
        return;
      }
      let body;
      try {
        body = await readJson(req);
      } catch {
        sendJson(req, res, 400, { error: "invalid json" });
        return;
      }
      const raw = typeof body?.text === "string" ? body.text.trim() : "";
      if (!raw || raw.length > TTS_MAX_TEXT_LENGTH) {
        sendJson(req, res, 400, { error: "invalid text" });
        return;
      }
      proxyTts(raw, req, res);
      return;
    }

    sendJson(req, res, 404, { error: "not found" });
  } catch (err) {
    console.error("[archive] handler error:", err);
    sendJson(req, res, 500, { error: "internal error" });
  }
});

server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const origin = req.headers.origin;
    if (url.pathname !== "/realtime") {
      socket.destroy();
      return;
    }
    if (typeof origin === "string" && !ALLOWED_ORIGINS.has(origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n",
      ].join("\r\n")
    );

    const client = {
      id: randomUUID(),
      socket,
      buffer: Buffer.from(head ?? []),
      preferences: defaultPreferences(),
    };
    wsClients.add(client);
    sendRealtime(client, { type: "hello", clientId: client.id });
    const snap = snapshot();
    sendRealtime(client, {
      type: "snapshot",
      bins: snap.bins,
      active: activeForClient(client),
      ttlMs: snap.ttlMs,
    });
    if (client.buffer.length > 0) {
      for (const raw of decodeWsFrames(client)) handleRealtimeMessage(client, raw);
    }

    socket.on("data", (chunk) => {
      client.buffer = Buffer.concat([client.buffer, chunk]);
      for (const raw of decodeWsFrames(client)) handleRealtimeMessage(client, raw);
    });
    socket.on("close", () => removeRealtimeClient(client));
    socket.on("error", () => removeRealtimeClient(client));
  } catch {
    socket.destroy();
  }
});

function removeRealtimeClient(client) {
  if (!wsClients.delete(client)) return;
  for (const item of activeItems.values()) {
    if (item.claimedBy === client.id) {
      delete item.claimedBy;
      delete item.claimUntil;
      broadcastRealtimeForItem({ type: "item_released", id: item.id, item: publicActiveItem(item) }, item);
    }
  }
}

function handleRealtimeMessage(client, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    sendRealtime(client, { type: "error", error: "invalid_json" });
    return;
  }
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "hello":
      client.preferences = normalizePreferences(msg.preferences, client.preferences);
      sendRealtime(client, {
        type: "snapshot",
        bins: snapshot().bins,
        active: activeForClient(client),
        ttlMs: ARCHIVE_TTL_MS,
      });
      return;
    case "set_preferences":
      client.preferences = normalizePreferences(msg.preferences, client.preferences);
      for (const item of activeItems.values()) {
        if (item.claimedBy === client.id && !itemMatchesClient(client, item)) {
          delete item.claimedBy;
          delete item.claimUntil;
          broadcastRealtimeForItem({ type: "item_released", id: item.id, item: publicActiveItem(item) }, item);
        }
      }
      sendRealtime(client, {
        type: "preferences_updated",
        preferences: client.preferences,
        active: activeForClient(client),
      });
      return;
    case "claim":
      handleClaim(client, msg.id);
      return;
    case "release":
      handleRelease(client, msg.id);
      return;
    case "deliver":
      handleDeliver(client, msg.id);
      return;
  }
}

function handleClaim(client, id) {
  if (typeof id !== "string") return;
  const item = activeItems.get(id);
  const now = Date.now();
  if (!item) {
    sendRealtime(client, { type: "claim_rejected", id, reason: "missing" });
    return;
  }
  if (item.claimedBy && item.claimedBy !== client.id && (item.claimUntil ?? 0) > now) {
    sendRealtime(client, { type: "claim_rejected", id, reason: "claimed" });
    return;
  }
  item.claimedBy = client.id;
  item.claimUntil = now + CLAIM_LEASE_MS;
  sendRealtime(client, { type: "claim_accepted", id, leaseUntil: item.claimUntil });
  broadcastRealtime({ type: "item_claimed", id, clientId: client.id, leaseUntil: item.claimUntil });
}

function handleRelease(client, id) {
  if (typeof id !== "string") return;
  const item = activeItems.get(id);
  if (!item || item.claimedBy !== client.id) return;
  delete item.claimedBy;
  delete item.claimUntil;
  broadcastRealtimeForItem({ type: "item_released", id, item: publicActiveItem(item) }, item);
}

function handleDeliver(client, id) {
  if (typeof id !== "string") return;
  const item = activeItems.get(id);
  if (!item) {
    sendRealtime(client, { type: "deliver_rejected", id, reason: "missing" });
    return;
  }
  if (item.claimedBy && item.claimedBy !== client.id && (item.claimUntil ?? 0) > Date.now()) {
    sendRealtime(client, { type: "deliver_rejected", id, reason: "claimed" });
    return;
  }
  addDeliveredItem({
    id: item.id,
    sourceId: item.sourceId,
    kind: item.kind,
    text: item.text,
    href: item.href,
    linkLabel: item.linkLabel,
    deliveredAt: Date.now(),
  });
}

// Restore the previous snapshot (if persistence is enabled) before opening
// the port — clients connecting at boot get a populated archive immediately
// instead of an empty one that fills back up over the next polling cycle.
loadArchiveFromDisk();

if (ARCHIVE_PERSIST_PATH) {
  setInterval(() => saveArchiveToDisk(), ARCHIVE_PERSIST_INTERVAL_MS).unref?.();
  // Railway sends SIGTERM ~10s before forcibly killing the container on a
  // redeploy; flush synchronously so the next boot picks up the latest state.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[archive] received ${signal}, flushing snapshot…`);
    saveArchiveToDisk(true);
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

server.listen(PORT, () => {
  console.log(
    `[archive] listening on :${PORT} (TTL ${ARCHIVE_TTL_MS}ms, persist=${
      ARCHIVE_PERSIST_PATH ?? "off"
    })`
  );
});

// One narrator for everyone. Each client used to poll HN/DEV.to/USGS/etc.
// independently; now the server polls once and pushes new items as they're
// chosen, so upstream APIs see ~1 set of requests instead of N.
const narrator = new Narrator({
  cadenceMs: 16_000,
  isAlreadyKnown: isKnown,
  onItem: (item) => {
    if (isKnown(item.id)) return;
    const active = activeItemFromSource(item);
    activeItems.set(active.id, active);
    pushRecentItem(item);
    broadcastEvent({ type: "item", item: active });
    broadcastRealtimeForItem({ type: "item_spawned", item: active }, active);
  },
  logger: console,
});
// Weather is intentionally absent — it's per-visitor (IP-geolocated) and
// surfaced as a transient ambient card on the client, not stored in the
// shared archive.
narrator.registerSource(HackerNews);
narrator.registerSource(DevTo);
narrator.registerSource(Quakes);
narrator.registerSource(Facts);
narrator.registerSource(Space);
narrator.registerSource(createBirds());
narrator.start();

// Dino thoughts are ephemeral: pulled off a buffer on a slow cadence and
// broadcast to every connected client as `dino_thought` events. Clients
// render them as a brief speech bubble above the dino — no card, no bin,
// no archive entry.
const THOUGHT_INTERVAL_BASE_MS = 90_000;
const THOUGHT_INTERVAL_JITTER_MS = 60_000;
const THOUGHT_INITIAL_DELAY_MS = 12_000;
const musings = createMusings({
  apiKey: process.env.ANTHROPIC_API_KEY,
  getRecentItems: () => recentSpokenItems.slice(),
});
async function broadcastDinoThought() {
  try {
    const text = await musings.next();
    if (!text) return;
    broadcastEvent({ type: "dino_thought", text });
    broadcastRealtime({ type: "dino_thought", text });
  } catch (err) {
    console.warn("[musings] thought broadcast failed:", err?.message ?? err);
  }
}
function scheduleNextThought(delay) {
  setTimeout(() => {
    void broadcastDinoThought();
    scheduleNextThought(
      THOUGHT_INTERVAL_BASE_MS + Math.random() * THOUGHT_INTERVAL_JITTER_MS
    );
  }, delay).unref?.();
}
scheduleNextThought(THOUGHT_INITIAL_DELAY_MS);

// Slow ambient sfx cadence. Picks a recent narrator item, asks Claude
// for a short evocative prompt, generates 2-3 s of audio via ElevenLabs,
// and broadcasts a dino_sfx event whose URL points at the in-memory
// cache. Skipped silently when keys are missing, the recent-item buffer
// is empty, no clients are connected, or Claude returned "skip".
const sfxPrompter = createSfxPrompter({ apiKey: process.env.ANTHROPIC_API_KEY });
async function broadcastDinoSfx() {
  if (!ELEVENLABS_API_KEY || !process.env.ANTHROPIC_API_KEY) return;
  if (recentSpokenItems.length === 0) return;
  if (sseClients.size === 0 && wsClients.size === 0) return;
  const item = recentSpokenItems[Math.floor(Math.random() * recentSpokenItems.length)];
  let prompt;
  try {
    prompt = await sfxPrompter.generate(item);
  } catch (err) {
    console.warn("[sfx] prompt failed:", err?.message ?? err);
    return;
  }
  if (!prompt) return;
  try {
    const buf = await generateSfxAudio(prompt);
    gcSfxCache();
    const token = randomUUID();
    sfxCache.set(token, { buf, expiresAt: Date.now() + SFX_CACHE_TTL_MS });
    const event = {
      type: "dino_sfx",
      url: `/sfx/${token}`,
      kind: item.kind,
      hint: prompt,
    };
    broadcastEvent(event);
    broadcastRealtime(event);
  } catch (err) {
    console.warn("[sfx] generation failed:", err?.message ?? err);
  }
}
function scheduleNextSfx(delay) {
  setTimeout(() => {
    void broadcastDinoSfx();
    scheduleNextSfx(SFX_INTERVAL_BASE_MS + Math.random() * SFX_INTERVAL_JITTER_MS);
  }, delay).unref?.();
}
scheduleNextSfx(SFX_INITIAL_DELAY_MS);

// Auto-sync radio playlists shortly after boot and periodically thereafter
// so the `all` playlist tracks the live Navidrome library without anyone
// having to call /admin/refresh-playlists by hand. Set PLAYLIST_SYNC_INTERVAL_MS
// to 0 to disable both the boot sync and the periodic refresh.
const PLAYLIST_SYNC_INTERVAL_MS = Number(
  process.env.PLAYLIST_SYNC_INTERVAL_MS ?? 15 * 60_000
);
const PLAYLIST_SYNC_BOOT_DELAY_MS = 30_000;
async function autoSyncPlaylists(reason) {
  try {
    const result = await syncRadioPlaylists();
    if (result?.ok) {
      console.log(`[playlists] auto-sync (${reason}): ${result.songCount} songs`);
    } else {
      console.warn(`[playlists] auto-sync (${reason}) skipped:`, result?.reason ?? "unknown");
    }
  } catch (err) {
    console.warn(`[playlists] auto-sync (${reason}) failed:`, err?.message ?? err);
  }
}
if (NAVIDROME_CONFIGURED && PLAYLIST_SYNC_INTERVAL_MS > 0) {
  setTimeout(() => void autoSyncPlaylists("boot"), PLAYLIST_SYNC_BOOT_DELAY_MS).unref?.();
  setInterval(
    () => void autoSyncPlaylists("scheduled"),
    PLAYLIST_SYNC_INTERVAL_MS
  ).unref?.();
}
