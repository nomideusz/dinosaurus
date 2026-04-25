// Shared helpers for ContentSources.

export async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return (await res.json()) as T;
}

/** Trim a title-ish string and collapse whitespace into a single line. */
export function condense(text: string, max = 140): string {
  let t = text.replace(/\s+/g, " ").trim();
  if (t.length > max) t = t.slice(0, max - 1).trimEnd() + "…";
  return t;
}

/**
 * Map a raw popularity number into a 0..1 score using a log curve so a
 * 5000-point story doesn't completely drown out a 50-point one.
 */
export function logScore(raw: number, ceiling = 3.2): number {
  return Math.min(1, Math.log10(Math.max(1, raw)) / ceiling);
}
