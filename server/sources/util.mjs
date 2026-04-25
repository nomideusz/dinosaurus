// Shared helpers used by every server-side source.

/**
 * @template T
 * @param {string} url
 * @param {AbortSignal} signal
 * @returns {Promise<T>}
 */
export async function fetchJson(url, signal) {
  const res = await fetch(url, {
    signal,
    headers: { accept: "application/json", "user-agent": "dinosaurus-archive/0.1" },
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
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
