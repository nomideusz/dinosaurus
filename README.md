# 🦖 dino — a tiny pixel friend that lives on your page

A little pixel-art dinosaur strolls around the page like he owns it. Snippets
of the world — top stories from Hacker News, your local weather, small
thoughts — slide in from the edges as floating cards. Dino's job is to walk
over, grab each one, and drag it down to the matching category bin at the
bottom of the page.

Built with **Vite + TypeScript**, no bundled images, and any API keys it
needs stay server-side. Production runs as three Railway services:

- `dinosaurus-frontend`: the static Vite app served by `static-server.mjs`.
- `dinosaurus-archive`: an in-memory 24-hour shared archive plus an
  authoritative WebSocket realtime endpoint and the radio proxy, served
  from `server/server.mjs`.
- `dinosaurus-navidrome`: a custom Navidrome + Syncthing image
  (`navidrome/Dockerfile`) that hosts the music library on a shared volume.

## Quick start

```bash
pnpm install
pnpm dev      # http://localhost:5173
```

Build a static bundle:

```bash
pnpm build    # outputs to ./dist
pnpm preview  # serve ./dist locally
```

Run the archive service locally in another terminal:

```bash
cd server
pnpm install
pnpm start     # http://localhost:8080
```

## Configuration

Frontend build-time variable:

- `VITE_ARCHIVE_URL`: public base URL for the archive service. In production
  this is `https://dinosaurus-archive-production.up.railway.app`.

Archive runtime variables:

- `PORT`: HTTP port. Railway sets this automatically.
- `ALLOWED_ORIGINS`: comma-separated browser origins allowed to call
  `/archive` and `/events`, for example
  `https://dino.zaur.app,http://localhost:5173,http://localhost:5174,http://localhost:4173`.
- `ARCHIVE_PERSIST_PATH`: optional snapshot path (e.g. `/data/bins.json` on a
  Railway volume) so the 24-hour archive survives redeploys. Unset = in-memory
  only.
- `NAVIDROME_URL`, `NAVIDROME_USER`, `NAVIDROME_PASSWORD`: credentials for the
  radio. Unset disables `/radio/*`.
- `ADMIN_TOKEN`: shared secret for `/admin/refresh-playlists`. Empty disables
  admin endpoints entirely.
- `ANTHROPIC_API_KEY`: optional; enables the `musings` source (Claude Haiku
  generates dino thoughts ~once an hour). Without it the source is skipped.

Navidrome service runtime variables (the bundled image):

- `ND_PORT`, `ND_MUSICFOLDER`, `ND_DATAFOLDER`: standard Navidrome — all paths
  live on the shared Railway volume.
- `SYNCTHING_USER` (default `admin`), `SYNCTHING_PASSWORD`: required on first
  boot to seed the Syncthing GUI on `:8384` with bcrypted credentials.

The frontend reads `VITE_ARCHIVE_URL` at build time, so changing it requires a
new frontend build/deploy. The client connects to `${VITE_ARCHIVE_URL}/realtime`
with WebSocket and falls back to archive polling/SSE compatibility when needed.
If archive sync fails, the app keeps working locally and logs a one-time browser
console warning pointing at these variables.

## Dino radio

The bottom-of-page strip is a working audio player that streams tracks from a
Navidrome library. The user picks a channel (`all`, `news`, `quakes`, `facts`,
`thoughts`, `space`, `birds`) and a pace (`chill`, `normal`, `busy`).
Preferences are anonymous, saved in `localStorage`, and sent to `/realtime`
for the current socket only. Pace also throttles how cards spawn so the dino
never gets overwhelmed.

Audio flows through the archive server: the client calls `/radio/track` for
the next track id, then `/radio/stream/<id>` to play the bytes. The archive
proxies Subsonic so Navidrome credentials never reach the browser, and
forwards `Range` headers so the audio element can seek.

Per-channel playlists are hand-curated in Navidrome's UI. The
`POST /admin/refresh-playlists` endpoint (auth via `X-Admin-Token`) mirrors
the entire library into the `all` playlist and ensures an empty shell exists
for every per-channel playlist matching a category bin (`news`, `quakes`,
`facts`, `thoughts`, `space`, `birds`). Existing per-channel contents are
never touched — only the names are guaranteed to be present so you have
ready destinations to drag tracks into. The runtime picker falls back to
`all` whenever a per-channel playlist is missing or empty.

## What's inside

```
src/
├── main.ts            # entry point + courier loop (dino ↔ messages)
├── world.ts           # animated sky, sun/moon, clouds, hills, ground
├── dino.ts            # dino entity + tiny state machine (wander/seek/carry/deliver)
├── sprite.ts          # programmatic pixel-art frames (no image files)
├── messages.ts        # floating message cards + category bins (DOM overlay)
├── weather.ts         # per-visitor weather card + ambient sky state
└── services/
    └── content.ts     # shared ContentItem types

server/
├── server.mjs         # archive API, WebSocket authority, radio proxy, admin
├── narrator.mjs       # server-side source scheduler and item picker
└── sources/           # HN, DEV.to, quakes, facts, musings, space, birds

navidrome/
├── Dockerfile         # Navidrome + Syncthing combined image
└── entrypoint.sh      # boots Syncthing in the background and Navidrome up front
```

## How a message gets sorted

1. Each server-side source produces scored items on its own refresh schedule.
2. The archive `Narrator` keeps a deduped pool, ranks them (score + recency + a
   diversity penalty so the same kind doesn't dominate), and creates an active
   server-owned card.
3. Connected browsers receive `item_spawned` over `/realtime`. Each client
   queues active cards locally and only spawns a few at a time so one dino
   does not get overwhelmed.
4. The courier loop in `main.ts` looks at floating cards, claims one over the
   realtime socket, and tells the dino to walk over.
5. Dino seeks → grabs → carries the card above his head → walks down to the
   bin matching that card's `kind` → drops it in.
6. The client sends `deliver`; the server accepts the delivery, moves the card
   into the shared archive, and broadcasts `item_delivered` so every browser
   cancels any duplicate local work.

While he has nothing to deliver, dino does his usual thing: walking,
looking up, blinking, occasionally napping.

## Adding a new shared content source

Add a source module under `server/sources/` and register it in `server/server.mjs`:

```js
export const MarsWeather = {
  name: "mars-weather",
  refreshEveryMs: 30 * 60_000,
  async fetchItems(signal) {
    // fetch + map to { id, kind, text, href?, publishedAt, score }
  },
};
```

If you introduce a new `ContentKind`, also add it to `src/services/content.ts`,
`server/server.mjs`'s `ALLOWED_KINDS`, and the bin list in `src/main.ts`:

```ts
const messages = new MessageWorld(stage, [
  { kind: "news",    label: "news",     icon: "▤" },
  { kind: "thought", label: "thoughts", icon: "✦" },
  { kind: "fact",    label: "facts",    icon: "❍" },
], cssW, cssH);
```

That's the whole extension surface — dino will start sorting Mars weather on
his own, mixed in with everything else.

## Credits

- News: [Hacker News API](https://github.com/HackerNews/API) and [DEV.to](https://dev.to/api)
- Weather: [Open-Meteo](https://open-meteo.com/) (no API key required)
- Approximate location: [ipapi.co](https://ipapi.co/) (falls back to London)
- Earthquakes: [USGS](https://earthquake.usgs.gov/fdsnws/event/1/) feed
- Space: [NASA APOD](https://api.nasa.gov/) and the asteroid feed
- Birds: [eBird](https://documenter.getpostman.com/view/664302/S1ENwy59) recent observations
- Musings: [Anthropic Claude](https://www.anthropic.com/) (Haiku) — optional
- Radio: [Navidrome](https://www.navidrome.org/) + [Syncthing](https://syncthing.net/)

## License

MIT
