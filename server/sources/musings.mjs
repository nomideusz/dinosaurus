// The dino's internal monologue. When ANTHROPIC_API_KEY is set, this asks
// Claude Haiku 4.5 to write small fresh thoughts in the dino's voice, given
// a list of items the dino has recently been sorting (so musings can quietly
// reference what's been in the air). Without a key — or if the API call
// fails — we fall back to a stable hand-written pool. The narrator dedupes
// by id, so every batch carries a unique batch timestamp in the id.

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
 * Build the Musings source. `apiKey` is optional — without it (or on any
 * Claude call failure) the source returns the static FALLBACK pool, so the
 * dino keeps talking when offline.
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

  return {
    name: "musings",
    refreshEveryMs: REFRESH_EVERY_MS,
    /** @param {AbortSignal} signal */
    async fetchItems(signal) {
      const now = Date.now();
      if (!client) return staticBatch(now);

      try {
        const recent = (getRecentItems?.() ?? []).slice(0, 12);
        const lines = await generateThoughts(client, model, recent, signal);
        if (lines.length === 0) return staticBatch(now);
        return lines.map((text, i) => ({
          id: `musing:${now.toString(36)}:${i}`,
          kind: "thought",
          text,
          publishedAt: now,
          // Slightly above fallback so live thoughts get picked first when both
          // are in the pool.
          score: 0.32 + Math.random() * 0.08,
        }));
      } catch (err) {
        if (err && err.name !== "AbortError") {
          console.warn(
            "[musings] Claude call failed; falling back to static pool:",
            err?.message ?? err
          );
        }
        return staticBatch(now);
      }
    },
  };
}

function staticBatch(now) {
  return FALLBACK.map((text, i) => ({
    id: `musing:fallback:${i}`,
    kind: "thought",
    text,
    publishedAt: now,
    score: 0.18 + Math.random() * 0.05,
  }));
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
