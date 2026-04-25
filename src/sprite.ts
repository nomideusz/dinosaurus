// Programmatic pixel-art dinosaur — a small bipedal theropod with a taller
// snouted head, chunky body, counterbalancing tail, and expressive poses.
// Pure ink-on-paper silhouette: every body pixel uses the same color, the eye
// is a single transparent pixel so the page bleeds through. No image assets.
//
// Frames live as ASCII grids; we render each to an offscreen canvas once.

import { THEME } from "./theme.js";

type Palette = Record<string, string>;

/** Default body color — overridable via the optional arg to buildFrames. */
export const INK = THEME.ink;

// 20 wide × 18 tall canvas. Default facing is right.
//
// Layout (facing right):
//   - tail tapers off to the left (rows 6-10, cols 0-7)
//   - body main mass center (rows 6-10, cols 1-14)
//   - neck rises into head on the right (rows 5, col 11-14)
//   - head + snout in upper right (rows 0-4, cols 12-19)
//   - two legs underneath the body (rows 11-16)

// idle (both feet planted)
const IDLE = [
  "....................",
  "....................",
  ".............XXXXX..",
  "............XWXXXXX.",
  "............XXXXXXX.",
  "............XXXXX...",
  "...........XXXX.....",
  "......XXXXXXXXX.....",
  "....XXXXXXXXXXX.....",
  "...XXXXXXXXXXX......",
  "....XXXXXXXX........",
  "......XX.X.XX.......",
  "....XX.....XX.......",
  "....XX....XXX.......",
  "...XXX.....XX.......",
  "...XX........XX.....",
  "..XXXX.....XXXX.....",
  "....................",
];

// walk frame A — left leg swung back (foot behind hips), right leg planted
const WALK_A = [
  "....................",
  "....................",
  ".............XXXXX..",
  "............XWXXXXX.",
  "............XXXXXXX.",
  "............XXXXX...",
  "...........XXXX.....",
  "......XXXXXXXXX.....",
  "....XXXXXXXXXXX.....",
  "...XXXXXXXXXXX......",
  "....XXXXXXXX........",
  ".....XX.X.XX........",
  "....XX.....XX.......",
  "...XX......XXX......",
  "..XXX.......XX......",
  "..XX.........XX.....",
  ".XXXX.......XXXX....",
  "....................",
];

// walk frame B — left leg planted, right leg swung forward
const WALK_B = [
  "....................",
  "....................",
  ".............XXXXX..",
  "............XWXXXXX.",
  "............XXXXXXX.",
  "............XXXXX...",
  "...........XXXX.....",
  "......XXXXXXXXX.....",
  "....XXXXXXXXXXX.....",
  "...XXXXXXXXXXX......",
  "....XXXXXXXX........",
  "......XX.X.XX.......",
  "......XX...XX.......",
  "......XX....XX......",
  ".....XXX.....XX.....",
  ".....XX.......XXX...",
  "....XXXX......XXXX..",
  "....................",
];

// looking up — head tilts so snout points up-right and the eye sits high
const LOOK_UP = [
  "....................",
  ".............XXXX...",
  "............XXWXXX..",
  "............XXXXXX..",
  "............XXXXX...",
  "...........XXXX.....",
  "..........XXXX......",
  "......XXXXXXXXX.....",
  "....XXXXXXXXXXX.....",
  "...XXXXXXXXXXX......",
  "....XXXXXXXX........",
  "......XX.X.XX.......",
  "....XX.....XX.......",
  "....XX....XXX.......",
  "...XXX.....XX.......",
  "...XX........XX.....",
  "..XXXX.....XXXX.....",
  "....................",
];

// happy — bright eye, lifted snout, and a tiny open grin cut into the jaw
const HAPPY = [
  "....................",
  "....................",
  ".............XXXXX..",
  "............XWXXXXX.",
  "............XXXXWXX.",
  "............XXXXX...",
  "...........XXXX.....",
  "......XXXXXXXXX.....",
  "....XXXXXXXXXXX.....",
  "...XXXXXXXXXXX......",
  "....XXXXXXXX........",
  "......XX.X.XX.......",
  "....XX.....XX.......",
  "....XX....XXX.......",
  "...XXX.....XX.......",
  "...XX........XX.....",
  "..XXXX.....XXXX.....",
  "....................",
];

// angry — lower brow, squared snout, and a braced stance
const ANGRY = [
  "....................",
  "....................",
  "............XXXXXX..",
  "............XXWXXXX.",
  "............XXXXXXXX",
  "...........XXXXXX...",
  "..........XXXXX.....",
  ".....XXXXXXXXXX.....",
  "...XXXXXXXXXXXX.....",
  "..XXXXXXXXXXXX......",
  "...XXXXXXXXX........",
  ".....XXX.X.XX.......",
  "....XXX....XX.......",
  "....XX....XXX.......",
  "...XXX.....XX.......",
  "...XX.......XXX.....",
  "..XXXX.....XXXX.....",
  "....................",
];

// sad — drooped head and tail, with the body sitting lower in the frame
const SAD = [
  "....................",
  "....................",
  "....................",
  "............XXXXX...",
  "...........XWXXXXX..",
  "...........XXXXWXX..",
  "...........XXXXX....",
  "..........XXXX......",
  "......XXXXXXXX......",
  "....XXXXXXXXXXX.....",
  "...XXXXXXXXXXX......",
  "....XXXXXXXX........",
  "......XX.X.XX.......",
  "....XX.....XX.......",
  "....XX....XXX.......",
  "...XXX.....XX.......",
  "..XXXX.....XXXX.....",
  "....................",
];

// blink — eye pixel filled in
const BLINK = [
  "....................",
  "....................",
  ".............XXXXX..",
  "............XXXXXXX.",
  "............XXXXXXX.",
  "............XXXXX...",
  "...........XXXX.....",
  "......XXXXXXXXX.....",
  "....XXXXXXXXXXX.....",
  "...XXXXXXXXXXX......",
  "....XXXXXXXX........",
  "......XX.X.XX.......",
  "....XX.....XX.......",
  "....XX....XXX.......",
  "...XXX.....XX.......",
  "...XX........XX.....",
  "..XXXX.....XXXX.....",
  "....................",
];

// sleeping — curled low, head tucked, eye closed, legs folded under
const SLEEP = [
  "....................",
  "....................",
  "....................",
  "....................",
  "....................",
  "....................",
  "....................",
  ".......XXXXXXX......",
  "...XXXXXXXXXXXXX....",
  "..XXXXXXXXXXXXXXXX..",
  ".XXXXXXXXXXXXXXXXXX.",
  ".XXXXXXXXXXXXXXXXXX.",
  "..XXXXXXXXXXXXXXXX..",
  "...XXXXXXXXXXXXXX...",
  "....XXXXXXXXXXXX....",
  ".....XXXX..XXXX.....",
  "....................",
  "....................",
];

export type FrameId =
  | "idle"
  | "walk_a"
  | "walk_b"
  | "look_up"
  | "happy"
  | "angry"
  | "sad"
  | "blink"
  | "sleep";

const RAW_FRAMES: Record<FrameId, string[]> = {
  idle: IDLE,
  walk_a: WALK_A,
  walk_b: WALK_B,
  look_up: LOOK_UP,
  happy: HAPPY,
  angry: ANGRY,
  sad: SAD,
  blink: BLINK,
  sleep: SLEEP,
};

export const SPRITE_GRID_W = 20;
export const SPRITE_GRID_H = 18;

export interface RenderedFrame {
  /** Right-facing canvas. */
  right: HTMLCanvasElement;
  /** Pre-flipped left-facing canvas (avoids per-frame transforms). */
  left: HTMLCanvasElement;
  scale: number;
}

/** Render every frame to offscreen canvases at the given pixel scale. */
export function buildFrames(scale: number, color: string = INK): Record<FrameId, RenderedFrame> {
  const palette: Palette = { ".": "transparent", "X": color, "W": "transparent" };
  const out = {} as Record<FrameId, RenderedFrame>;
  for (const id of Object.keys(RAW_FRAMES) as FrameId[]) {
    out[id] = renderOne(RAW_FRAMES[id], scale, palette);
  }
  return out;
}

function renderOne(rows: string[], scale: number, palette: Palette): RenderedFrame {
  const w = SPRITE_GRID_W * scale;
  const h = SPRITE_GRID_H * scale;

  const right = document.createElement("canvas");
  right.width = w;
  right.height = h;
  const ctx = right.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;

  for (let y = 0; y < SPRITE_GRID_H; y++) {
    const row = rows[y] ?? "";
    for (let x = 0; x < SPRITE_GRID_W; x++) {
      const ch = row[x] ?? ".";
      const color = palette[ch];
      if (!color || color === "transparent") continue;
      ctx.fillStyle = color;
      ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }

  const left = document.createElement("canvas");
  left.width = w;
  left.height = h;
  const lctx = left.getContext("2d")!;
  lctx.imageSmoothingEnabled = false;
  lctx.translate(w, 0);
  lctx.scale(-1, 1);
  lctx.drawImage(right, 0, 0);

  return { right, left, scale };
}
