// Static "thought" pool. The dino's own internal monologue — keeps the page
// alive when external sources are flaky and gives him a distinct voice.

const MUSINGS = [
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

export const Musings = {
  name: "musings",
  refreshEveryMs: 30 * 60_000,
  async fetchItems() {
    const now = Date.now();
    return MUSINGS.map((text, i) => ({
      id: `mus:${i}`,
      kind: "thought",
      text,
      publishedAt: now,
      score: 0.18 + Math.random() * 0.05,
    }));
  },
};
