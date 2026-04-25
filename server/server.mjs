// Tiny in-memory archive for the dino's sorted items.
//
// Everyone who loads the page shares the same archive, so a visitor who shows
// up later sees what the dino has been sorting for the past two hours. Items
// older than ARCHIVE_TTL_MS are pruned on every read and write.
//
// No database — the data is intentionally ephemeral. A redeploy clears it,
// which is fine for a 2-hour rolling window.

import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8080);
const ARCHIVE_TTL_MS = 2 * 60 * 60 * 1000;
/** Hard cap per kind so a misbehaving client can't blow up memory. */
const MAX_PER_KIND = 200;
const ALLOWED_KINDS = new Set([
  "news",
  "weather",
  "fact",
  "thought",
  "quake",
  "history",
]);

/** @type {Map<string, Array<{ id: string, kind: string, text: string, href?: string, linkLabel?: string, deliveredAt: number }>>} */
const bins = new Map();

/** @type {Set<{ res: import("node:http").ServerResponse, hb: NodeJS.Timeout }>} */
const sseClients = new Set();

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

function snapshot() {
  prune();
  /** @type {Record<string, unknown[]>} */
  const out = {};
  for (const [kind, list] of bins) out[kind] = list;
  return { bins: out, ttlMs: ARCHIVE_TTL_MS };
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

// Drain expired items so connected clients see them disappear in real time
// without waiting for the next read. We also broadcast the *ids* that left
// so clients can patch their state without reloading the whole archive.
setInterval(() => {
  const cutoff = Date.now() - ARCHIVE_TTL_MS;
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
    broadcastEvent({ type: "expire", ids: expired });
  }
}, 60_000).unref();

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function sendJson(res, status, body) {
  setCors(res);
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
      setCors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/archive") {
      sendJson(res, 200, snapshot());
      return;
    }

    if (req.method === "GET" && url.pathname === "/events") {
      setCors(res);
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

    if (req.method === "POST" && url.pathname === "/archive") {
      let body;
      try {
        body = await readJson(req);
      } catch {
        sendJson(res, 400, { error: "invalid json" });
        return;
      }
      const item = validate(body);
      if (!item) {
        sendJson(res, 400, { error: "invalid item" });
        return;
      }
      const list = bins.get(item.kind) ?? [];
      // Replace any existing entry for this id so re-deliveries refresh.
      const filtered = list.filter((d) => d.id !== item.id);
      filtered.unshift(item);
      if (filtered.length > MAX_PER_KIND) filtered.length = MAX_PER_KIND;
      bins.set(item.kind, filtered);
      // The POSTing client already updated its own state optimistically; we
      // still send back a small ack so it knows the canonical timestamp.
      sendJson(res, 200, { ok: true, item });
      broadcastEvent({ type: "add", item });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    console.error("[archive] handler error:", err);
    sendJson(res, 500, { error: "internal error" });
  }
});

server.listen(PORT, () => {
  console.log(`[archive] listening on :${PORT} (TTL ${ARCHIVE_TTL_MS}ms)`);
});
