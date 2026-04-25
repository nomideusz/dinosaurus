// Single source of truth for colors. The values here are mirrored in
// styles.css :root variables so DOM elements (message cards, bins) and
// canvas rendering (sprite, world) stay perfectly in sync.

export const THEME = {
  /** Page background. */
  bg:      "#14141a",
  /** Slightly lighter card background — used for message cards & bins. */
  paper:   "#1f1e26",
  /** Foreground / dino body color. */
  ink:     "#e8e4d8",
  /** Muted secondary text. */
  inkSoft: "#8a8678",
  /** Faint dot-grid color. */
  grid:    "rgba(232, 228, 216, 0.06)",
} as const;
