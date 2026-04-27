// The dino's internal monologue. When ANTHROPIC_API_KEY is set, this asks
// Claude Haiku 4.5 to write small fresh thoughts in the dino's voice, given
// a list of items the dino has recently been sorting (so musings can quietly
// reference what's been in the air). Without a key — or if the API call
// fails — we fall back to a stable hand-written pool. Thoughts are now
// ephemeral: the server pulls one off the buffer on a slow cadence and
// broadcasts it to clients as a `dino_thought` event for the speech bubble.

import Anthropic from "@anthropic-ai/sdk";

const FALLBACK = [
  "the grass tastes especially crunchy today.",
  "do you think the clouds are just sky sheep?",
  "i tried to count the pixels in my tail. lost count at 7.",
  "*rawr* — that means hello, by the way.",
  "stretching helps after a long meteor.",
  "i had a dream about a comet. very shiny.",
  "if i stand still long enough, am i a houseplant?",
  "ferns. underrated.",
  "scrolling? what's a scroll?",
  "i wonder if pterodactyls have email.",
  "you can pet me with the cursor. (you can't.)",
  "my favorite color is the green of new leaves.",
  "small reminder: drink some water.",
  "hmm. i think i'll walk left for a bit.",
  "did you know my ancestors invented napping?",
  "nice posture you've got there.",
  "*sniff sniff* — smells like adventure.",
];

// Persona + style. Static across calls so it's easy to audit and tweak in
// one place. Caching is intentionally not worth it at this volume + prefix
// size (1 call/hour, ~200 token system prompt, well under Haiku's 4096-token
// minimum cacheable prefix).
const SYSTEM_PROMPT = `You are a small, friendly cartoon dinosaur who lives on a webpage. The page shows you a stream of news, earthquakes, facts, weather, asteroids, and astronomy as cards floating by, and you sort them into bins for a human to read. Between deliveries you have small thoughts about the world.

Your voice:
- lowercase, casual, contemplative or whimsical
- one sentence each, max ~110 characters
- sometimes references something you just sorted ("that asteroid sounded close"), often pure dino thoughts (food, naps, ferns, your tail, the clouds)
- occasionally wry, never sarcastic; friendly, not validation-y
- no emoji except occasional asterisk-actions like *sniff* or *rawr*
- no hashtags, no @mentions, no markdown, no quotes around the line

Each line stands alone. Don't number them, don't bullet them, don't preface. Just the thoughts, one per line.`;

const DEFAULT_MODEL = "claude-haiku-4-5";
const REFRESH_EVERY_MS = 60 * 60_000; // ~1 API call per hour
const TARGET_BATCH = 16;
const MAX_TOKENS = 1024;
const MAX_LINE_CHARS = 200;

/**
 * Build the Musings buffer. `apiKey` is optional — without it (or on any
 * Claude call failure) the buffer is filled from the static FALLBACK pool,
 * so the dino keeps talking when offline.
 *
 * Returns an object with `next(signal)` that yields one thought string at a
 * time. Internally the buffer is refilled when it runs low or when the last
 * Claude call is older than REFRESH_EVERY_MS.
 *
 * @param {{
 *   apiKey?: string,
 *   getRecentItems?: () => Array<{ kind: string, text: string }>,
 *   model?: string,
 * }} opts
 */
export function createMusings(opts = {}) {
  const { apiKey, getRecentItems, model = DEFAULT_MODEL } = opts;
  const client = apiKey ? new Anthropic({ apiKey }) : null;

  const buffer = [];
  let lastRefreshAt = 0;
  let refreshing = null;

  function fillFromFallback() {
    buffer.push(...shuffle([...FALLBACK]));
    lastRefreshAt = Date.now();
  }

  async function refresh(signal) {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        if (!client) {
          fillFromFallback();
          return;
        }
        try {
          const recent = (getRecentItems?.() ?? []).slice(0, 12);
          const lines = await generateThoughts(client, model, recent, signal);
          if (lines.length === 0) {
            fillFromFallback();
            return;
          }
          buffer.push(...lines);
          lastRefreshAt = Date.now();
        } catch (err) {
          if (err && err.name !== "AbortError") {
            console.warn(
              "[musings] Claude call failed; falling back to static pool:",
              err?.message ?? err
            );
          }
          fillFromFallback();
        }
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  return {
    /**
     * Return the next thought, or null if the buffer is empty (and we
     * couldn't refill it). Callers may pass an AbortSignal to abort the
     * underlying Claude call if it's still in flight.
     */
    async next(signal) {
      const stale = Date.now() - lastRefreshAt > REFRESH_EVERY_MS;
      if (buffer.length === 0 || stale) {
        await refresh(signal);
      }
      if (buffer.length === 0) return null;
      return buffer.shift();
    },
  };
}

async function generateThoughts(client, model, recentItems, signal) {
  const itemsLine =
    recentItems.length === 0
      ? "(no recent items yet — pure dino thoughts please)"
      : recentItems.map((it) => `- [${it.kind}] ${it.text}`).join("\n");

  const userPrompt = `Recent items you've been sorting:
${itemsLine}

Write ${TARGET_BATCH} fresh thoughts. One per line, nothing else.`;

  const response = await client.messages.create(
    {
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    },
    { signal }
  );

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return text
    .split("\n")
    .map((l) => l.trim())
    // Strip leading bullet/number scaffolding the model sometimes adds despite
    // instructions to the contrary.
    .map((l) => l.replace(/^[-*•▪►◦◆◇]+\s*/, ""))
    .map((l) => l.replace(/^\d+[.)\s]+/, ""))
    .map((l) => l.replace(/^["“]+|["”]+$/g, ""))
    .filter((l) => l.length > 0 && l.length <= MAX_LINE_CHARS);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
