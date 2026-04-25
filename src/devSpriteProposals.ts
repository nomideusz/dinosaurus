import { THEME } from "./theme.js";

const PROPOSAL_GRID_W = 20;
const PROPOSAL_GRID_H = 18;

interface SpriteProposal {
  id: string;
  name: string;
  note: string;
  rows: string[];
}

const PROPOSALS: SpriteProposal[] = [
  {
    id: "lean-raptor",
    name: "Lean Raptor",
    note: "Fast, birdlike posture with a long counterweight tail.",
    rows: [
      ".............XXXX...",
      "............XXXXXX..",
      "............XWXXXXX.",
      "............XXXXXX..",
      "...........XXXX.....",
      "..........XXXX......",
      "....XXXXXXXXXX......",
      "...XXXXXXXXXXXX.....",
      "..XXXXXXXXXXXX......",
      "....XXXXXXXX........",
      "......XX..XX........",
      ".....XX...XX........",
      "....XX.....XX.......",
      "...XX......XX.......",
      "...XX.......XX......",
      "..XXX.......XXX.....",
      "..XXXX.....XXXX.....",
      "....................",
    ],
  },
  {
    id: "tiny-tyrant",
    name: "Tiny Tyrant",
    note: "Big head, deep chest, tiny arms, very T-rex.",
    rows: [
      "............XXXXXX..",
      "...........XXXXXXXX.",
      "...........XWXXXXXX.",
      "...........XXXXXXXXX",
      "...........XXXXXXXX.",
      "...........XXXXXX...",
      "........XXXXXXXX....",
      ".....XXXXXXXXXXX....",
      "...XXXXXXXXXXXXX....",
      "...XXXXXXXXXXXX.....",
      "....XXXXXXXXXX......",
      "......XX.X.XX.......",
      "......XX...XX.......",
      ".....XXX...XX.......",
      ".....XX......XX.....",
      "....XXX.....XX......",
      "....XXXX....XXXX....",
      "....................",
    ],
  },
  {
    id: "chunky-rex",
    name: "Chunky Rex",
    note: "Sturdier, toy-like silhouette with heavy feet.",
    rows: [
      "............XXXXX...",
      "...........XXXXXXX..",
      "...........XWXXXXXX.",
      "...........XXXXXXXX.",
      "..........XXXXXXX...",
      ".........XXXXXX.....",
      ".......XXXXXXXX.....",
      "....XXXXXXXXXXXX....",
      "...XXXXXXXXXXXXX....",
      "...XXXXXXXXXXXX.....",
      "....XXXXXXXXXX......",
      ".....XXX..XXX.......",
      ".....XXX..XXX.......",
      ".....XX....XX.......",
      "....XXX....XXX......",
      "....XX......XX......",
      "...XXXXX...XXXXX....",
      "....................",
    ],
  },
  {
    id: "sneaky-raptor",
    name: "Sneaky Raptor",
    note: "Lower hunting stance with a sharper snout and lifted claw.",
    rows: [
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
    ],
  },
  {
    id: "crest-raptor",
    name: "Crest Raptor",
    note: "More character: little head crest, long neck, alert pose.",
    rows: [
      "..............X.....",
      ".............XXX....",
      "............XXXXX...",
      "............XWXXXXX.",
      "............XXXXXXX.",
      "...........XXXXX....",
      "..........XXXX......",
      "......XXXXXXXXX.....",
      "....XXXXXXXXXXX.....",
      "...XXXXXXXXXXXX.....",
      "....XXXXXXXXX.......",
      ".....XXX..XXX.......",
      ".....XX....XX.......",
      "....XX......XX......",
      "...XXX.....XX.......",
      "...XX........XXX....",
      "..XXXX.....XXXX.....",
      "....................",
    ],
  },
];

export function renderSpriteProposals(stage: HTMLElement, canvas: HTMLCanvasElement): void {
  canvas.remove();
  stage.setAttribute("aria-label", "Dino sprite proposal comparison");
  stage.classList.add("sprite-lab");
  stage.replaceChildren(buildView());
}

function buildView(): HTMLElement {
  injectStylesOnce();

  const root = document.createElement("section");
  root.className = "sprite-lab__panel";

  const title = document.createElement("h1");
  title.textContent = "dino sprite proposals";

  const intro = document.createElement("p");
  intro.textContent = "Five rough 20x18 silhouettes for comparing raptor / tyrannosaurus directions.";

  const grid = document.createElement("div");
  grid.className = "sprite-lab__grid";

  for (const proposal of PROPOSALS) {
    grid.appendChild(buildCard(proposal));
  }

  root.append(title, intro, grid);
  return root;
}

function buildCard(proposal: SpriteProposal): HTMLElement {
  validateProposal(proposal);

  const card = document.createElement("article");
  card.className = "sprite-lab__card";

  const canvas = document.createElement("canvas");
  canvas.className = "sprite-lab__sprite";
  renderRows(canvas, proposal.rows, 6);

  const heading = document.createElement("h2");
  heading.textContent = proposal.name;

  const note = document.createElement("p");
  note.textContent = proposal.note;

  const code = document.createElement("pre");
  code.textContent = proposal.rows.join("\n");

  card.append(canvas, heading, note, code);
  return card;
}

function renderRows(canvas: HTMLCanvasElement, rows: string[], scale: number): void {
  canvas.width = PROPOSAL_GRID_W * scale;
  canvas.height = PROPOSAL_GRID_H * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = THEME.ink;

  for (let y = 0; y < PROPOSAL_GRID_H; y++) {
    for (let x = 0; x < PROPOSAL_GRID_W; x++) {
      if (rows[y]?.[x] === "X") {
        ctx.fillRect(x * scale, y * scale, scale, scale);
      }
    }
  }
}

function validateProposal(proposal: SpriteProposal): void {
  if (
    proposal.rows.length !== PROPOSAL_GRID_H ||
    proposal.rows.some((row) => row.length !== PROPOSAL_GRID_W)
  ) {
    throw new Error(`Sprite proposal "${proposal.id}" must be ${PROPOSAL_GRID_W}x${PROPOSAL_GRID_H}`);
  }
}

let stylesInjected = false;
function injectStylesOnce(): void {
  if (stylesInjected) return;
  stylesInjected = true;

  const style = document.createElement("style");
  style.textContent = `
    .sprite-lab {
      overflow: auto;
      padding: clamp(18px, 4vw, 48px);
    }

    .sprite-lab__panel {
      width: min(1180px, 100%);
      margin: 0 auto;
    }

    .sprite-lab__panel h1 {
      margin: 0 0 8px;
      font-size: clamp(24px, 4vw, 44px);
      letter-spacing: -0.04em;
    }

    .sprite-lab__panel > p {
      margin: 0 0 24px;
      color: var(--ink-soft);
    }

    .sprite-lab__grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 16px;
    }

    .sprite-lab__card {
      padding: 16px;
      border: 1px solid color-mix(in srgb, var(--ink), transparent 70%);
      background:
        linear-gradient(var(--grid), var(--grid)) 0 0 / 8px 8px,
        var(--paper);
    }

    .sprite-lab__sprite {
      display: block;
      width: 120px;
      height: 108px;
      margin: 0 auto 14px;
      image-rendering: pixelated;
      image-rendering: crisp-edges;
    }

    .sprite-lab__card h2 {
      margin: 0 0 6px;
      font-size: 15px;
    }

    .sprite-lab__card p {
      min-height: 48px;
      margin: 0 0 12px;
      color: var(--ink-soft);
      font-size: 12px;
      line-height: 1.45;
    }

    .sprite-lab__card pre {
      overflow: auto;
      margin: 0;
      padding: 10px;
      background: var(--bg);
      color: var(--ink-soft);
      font: 10px/1 "Ioskeley Mono", ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
    }
  `;
  document.head.appendChild(style);
}
