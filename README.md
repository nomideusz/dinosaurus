# 🦖 dino — a tiny pixel friend that lives on your page

A little pixel-art dinosaur strolls around the page like he owns it. Snippets
of the world — top stories from Hacker News, your local weather, small
thoughts — slide in from the edges as floating cards. Dino's job is to walk
over, grab each one, and drag it down to the matching category bin at the
bottom of the page.

Built with **Vite + TypeScript**, no images, no API keys, no backend.

## Quick start

```bash
npm install
npm run dev      # http://localhost:5173
```

Build a static bundle:

```bash
npm run build    # outputs to ./dist
npm run preview  # serve ./dist locally
```

## What's inside

```
src/
├── main.ts            # entry point + courier loop (dino ↔ messages)
├── world.ts           # animated sky, sun/moon, clouds, hills, ground
├── dino.ts            # dino entity + tiny state machine (wander/seek/carry/deliver)
├── sprite.ts          # programmatic pixel-art frames (no image files)
├── messages.ts        # floating message cards + category bins (DOM overlay)
├── narrator.ts        # picks what dino should hear about & when
└── services/
    ├── content.ts     # ContentSource interface
    ├── news.ts        # Hacker News top stories
    ├── weather.ts     # Open-Meteo current + tomorrow
    └── musings.ts     # offline fallback thoughts
```

## How a message gets sorted

1. Each `ContentSource` produces scored items on its own refresh schedule.
2. The `Narrator` keeps a deduped pool, ranks them (score + recency + a
   diversity penalty so the same kind doesn't dominate), and emits one item
   at a time.
3. The new item spawns as a card that **slides in from the left, right, or
   top** and gently bobs in the air.
4. The courier loop in `main.ts` looks at all floating cards, picks the one
   nearest to dino, and tells him to walk over.
5. Dino seeks → grabs → carries the card above his head → walks down to the
   bin matching that card's `kind` → drops it in.
6. The bin's counter ticks up and bumps. Dino goes back to wandering until
   the next card arrives.

While he has nothing to deliver, dino does his usual thing: walking,
looking up, blinking, occasionally napping.

## Adding a new content source

Implement `ContentSource` and register it in `main.ts`:

```ts
class MarsWeatherSource implements ContentSource {
  readonly name = "mars-weather";
  readonly refreshEveryMs = 30 * 60_000;
  async fetchItems(signal: AbortSignal): Promise<ContentItem[]> {
    // …fetch + map to { id, kind, text, href?, publishedAt, score }
  }
}

narrator.registerSource(new MarsWeatherSource());
```

If you introduce a new `ContentKind`, also add a bin for it in `main.ts`:

```ts
const messages = new MessageWorld(stage, [
  { kind: "news",    label: "news",     icon: "▤" },
  { kind: "weather", label: "weather",  icon: "☁" },
  { kind: "thought", label: "thoughts", icon: "✦" },
  { kind: "fact",    label: "facts",    icon: "❍" },
], cssW, cssH);
```

That's the whole extension surface — dino will start sorting Mars weather on
his own, mixed in with everything else.

## Credits

- News: [Hacker News API](https://github.com/HackerNews/API)
- Weather: [Open-Meteo](https://open-meteo.com/) (no API key required)
- Approximate location: [ipapi.co](https://ipapi.co/) (falls back to London)

## License

MIT
