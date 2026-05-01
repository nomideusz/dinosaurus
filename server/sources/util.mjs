// Shared helpers used by every server-side source.

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/**
 * @template T
 * @param {string} url
 * @param {AbortSignal} signal
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
export async function fetchJson(url, signal, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  timeout.unref?.();
  const abort = () => ctrl.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });

  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json", "user-agent": "dinosaurus-archive/0.1" },
    });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

/** Trim a title-ish string and collapse whitespace into a single line. */
export function condense(text, max = 140) {
  let t = decodeEntities(String(text ?? ""))
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > max) t = t.slice(0, max - 1).trimEnd() + "…";
  return t;
}

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Decode the small set of HTML entities sources actually emit (HN's API in
 * particular returns titles like `Adobe&#39;s` instead of `Adobe's`). We
 * want canonical UTF-8 in storage so escapeHtml on the client renders
 * correctly. Unknown entities are left alone.
 */
export function decodeEntities(s) {
  if (typeof s !== "string" || s.length === 0) return s;
  return s.replace(
    /&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z]+));/g,
    (full, dec, hex, name) => {
      if (dec !== undefined) {
        const code = Number(dec);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : full;
      }
      if (hex !== undefined) {
        const code = parseInt(hex, 16);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : full;
      }
      if (name && NAMED_ENTITIES[name] !== undefined) return NAMED_ENTITIES[name];
      return full;
    }
  );
}

/** Map a raw popularity number into a 0..1 score using a log curve. */
export function logScore(raw, ceiling = 3.2) {
  return Math.min(1, Math.log10(Math.max(1, raw)) / ceiling);
}
