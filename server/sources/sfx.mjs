// Turn a single card snippet into a short ambient sound-effect prompt for
// ElevenLabs. Claude Haiku 4.5 reads the snippet and writes one line of
// concrete sensory phrasing (no music, no speech, no melody) — or returns
// "skip" if the text doesn't suggest an obvious environmental sound.
//
// Used by the archive's slow sfx cadence (server.mjs). Failures and the
// "skip" reply both surface as `null` so the cadence loop just moves on.

import Anthropic from "@anthropic-ai/sdk";

const DEFAULT_MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 80;
const MAX_INPUT_CHARS = 220;
const MAX_PROMPT_CHARS = 200;

const SYSTEM_PROMPT = `You write short ambient sound-effect prompts for ElevenLabs' sound generator.

Given a one-line snippet of news, weather, wildlife, earthquakes, or astronomy, output a single short prompt that captures the atmosphere the snippet evokes — the kind of brief environmental sound a thoughtful designer would loop quietly behind the moment.

Rules:
- 4 to 12 words
- describe ambient atmosphere only: weather, machines, animals, places, nature
- never describe music, melody, vocals, speech, or human voices
- prefer concrete sensory phrasing ("low distant rumble, faint dust") over generic labels ("earthquake sound")
- if the snippet doesn't suggest a real-world ambient sound (a tech headline, an abstract fact, a number), reply with the single word: skip

Output the prompt only — no quotes, no preface, no trailing punctuation beyond commas.`;

/**
 * Build a generator. Without `apiKey`, `generate()` always returns null so
 * callers can no-op the cadence cleanly.
 *
 * @param {{ apiKey?: string, model?: string }} opts
 * @returns {{ generate: (item: { kind: string, text: string }, signal?: AbortSignal) => Promise<string | null> }}
 */
export function createSfxPrompter(opts = {}) {
  const { apiKey, model = DEFAULT_MODEL } = opts;
  if (!apiKey) {
    return { async generate() { return null; } };
  }
  const client = new Anthropic({ apiKey });
  return {
    async generate(item, signal) {
      const text = String(item?.text ?? "").trim();
      if (!text) return null;
      const userText = `[${item.kind}] ${text.slice(0, MAX_INPUT_CHARS)}`;
      try {
        const response = await client.messages.create(
          {
            model,
            max_tokens: MAX_TOKENS,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: userText }],
          },
          signal ? { signal } : undefined
        );
        const raw = response.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (!raw) return null;
        const cleaned = raw
          .replace(/^["'`]+|["'`]+$/g, "")
          .replace(/\s+/g, " ")
          .slice(0, MAX_PROMPT_CHARS)
          .trim();
        if (!cleaned || /^skip\b/i.test(cleaned)) return null;
        return cleaned;
      } catch (err) {
        if (err && err.name === "AbortError") return null;
        throw err;
      }
    },
  };
}
