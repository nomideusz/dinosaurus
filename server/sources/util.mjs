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
  let t = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > max) t = t.slice(0, max - 1).trimEnd() + "…";
  return t;
}

/** Map a raw popularity number into a 0..1 score using a log curve. */
export function logScore(raw, ceiling = 3.2) {
  return Math.min(1, Math.log10(Math.max(1, raw)) / ceiling);
}
