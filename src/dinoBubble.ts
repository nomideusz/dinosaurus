// Ephemeral speech bubble anchored above the dino's head. Driven by the
// server's `dino_thought` events — short lines that fade in, hang for a
// few seconds, then fade out. Each new thought replaces any in-flight one.

import type { Dino } from "./dino.js";

const BUBBLE_DURATION_MS = 6_500;
const FADE_OUT_MS = 320;

let stylesInjected = false;
function injectStylesOnce(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .dino-bubble {
      position: absolute;
      max-width: 220px;
      padding: 8px 10px 7px;
      background: var(--paper, #1f1e26);
      color: var(--ink, #e8e4d8);
      border: 1px solid rgba(232, 228, 216, 0.18);
      box-shadow: 0 4px 0 rgba(0, 0, 0, 0.35);
      font: 400 11px/1.4 "Ioskeley Mono", ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
      pointer-events: none;
      opacity: 0;
      transform: translate(-50%, -100%) translateY(-12px);
      transition: opacity 240ms ease, transform 240ms cubic-bezier(.2,.7,.2,1.4);
      z-index: 5;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .dino-bubble::after {
      content: "";
      position: absolute;
      left: 50%;
      bottom: -7px;
      width: 0;
      height: 0;
      transform: translateX(-50%);
      border-left: 6px solid transparent;
      border-right: 6px solid transparent;
      border-top: 7px solid var(--paper, #1f1e26);
      filter: drop-shadow(0 1px 0 rgba(232, 228, 216, 0.18));
    }
    .dino-bubble--visible {
      opacity: 1;
      transform: translate(-50%, -100%) translateY(-6px);
    }
    @media (max-width: 600px) {
      .dino-bubble { max-width: 180px; font-size: 10px; padding: 6px 8px 5px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .dino-bubble { transition: opacity 200ms ease; }
    }
  `;
  document.head.appendChild(style);
}

export class DinoBubble {
  private readonly el: HTMLDivElement;
  private hideTimer: number | null = null;
  private removeTimer: number | null = null;
  private visible = false;

  constructor(stage: HTMLElement, private readonly dino: Dino) {
    injectStylesOnce();
    this.el = document.createElement("div");
    this.el.className = "dino-bubble";
    this.el.setAttribute("aria-live", "polite");
    this.el.setAttribute("aria-atomic", "true");
    stage.appendChild(this.el);
    this.position();
  }

  /** Show a fresh thought, replacing any in-flight bubble. */
  show(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    if (this.removeTimer !== null) {
      clearTimeout(this.removeTimer);
      this.removeTimer = null;
    }
    this.el.textContent = trimmed;
    this.position();
    // Force a reflow so the transition runs even when we replace text rapidly.
    void this.el.offsetWidth;
    this.el.classList.add("dino-bubble--visible");
    this.visible = true;
    this.hideTimer = window.setTimeout(() => this.hide(), BUBBLE_DURATION_MS);
  }

  /** Reposition the bubble to follow the dino. Called each frame. */
  update(): void {
    if (!this.visible) return;
    this.position();
  }

  private hide(): void {
    this.hideTimer = null;
    this.el.classList.remove("dino-bubble--visible");
    this.visible = false;
    this.removeTimer = window.setTimeout(() => {
      this.removeTimer = null;
      // Leave the element in the tree — we'll reuse it on the next thought.
    }, FADE_OUT_MS);
  }

  private position(): void {
    const a = this.dino.bubbleAnchor;
    this.el.style.left = `${a.x}px`;
    this.el.style.top = `${a.top}px`;
  }
}
