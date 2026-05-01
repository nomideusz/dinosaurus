// Optional voice for dino's thoughts. When enabled, each `dino_thought`
// event triggers a fetch to /tts, which streams MP3 audio back from the
// archive server (ElevenLabs proxy). The audio is played through a Blob
// URL that's revoked as soon as playback ends — nothing is persisted.
//
// Browsers block autoplay until the user has interacted with the page, so
// the toggle button itself acts as that gesture: clicking it counts as the
// activation that lets subsequent `audio.play()` calls succeed.

const STORAGE_KEY = "dino-voice-enabled";

export class DinoVoice {
  private enabled: boolean;
  private current: HTMLAudioElement | null = null;
  private currentUrl: string | null = null;
  private currentAbort: AbortController | null = null;

  constructor(private readonly archiveUrl: string) {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {
      // Private mode / storage disabled — fall through, default off.
    }
    this.enabled = stored === "1";
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(value: boolean): void {
    this.enabled = value;
    try {
      localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
    } catch {
      // ignore — runtime state is still authoritative for this tab
    }
    if (!value) this.stopCurrent();
  }

  toggle(): boolean {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  async say(text: string): Promise<void> {
    if (!this.enabled) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    this.stopCurrent();
    const ac = new AbortController();
    this.currentAbort = ac;

    let blob: Blob | null = null;
    try {
      const resp = await fetch(`${this.archiveUrl}/tts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: trimmed }),
        signal: ac.signal,
      });
      if (!resp.ok) return;
      blob = await resp.blob();
    } catch (err) {
      if ((err as { name?: string })?.name !== "AbortError") {
        console.warn("[voice] fetch failed:", err);
      }
      return;
    } finally {
      if (this.currentAbort === ac) this.currentAbort = null;
    }

    if (ac.signal.aborted || !blob) return;

    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    this.current = audio;
    this.currentUrl = url;

    const cleanup = () => {
      if (this.currentUrl === url) {
        URL.revokeObjectURL(url);
        this.currentUrl = null;
      }
      if (this.current === audio) this.current = null;
    };
    audio.addEventListener("ended", cleanup);
    audio.addEventListener("error", cleanup);

    try {
      await audio.play();
    } catch {
      // Autoplay blocked, or playback rejected. Drop quietly.
      cleanup();
    }
  }

  private stopCurrent(): void {
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }
    if (this.current) {
      try {
        this.current.pause();
      } catch {
        // ignore
      }
      this.current = null;
    }
    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }
  }
}

export function mountVoiceToggle(
  parent: HTMLElement,
  voice: DinoVoice
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "dino-voice-toggle";
  const render = () => {
    const on = voice.isEnabled();
    btn.textContent = on ? "🔊" : "🔇";
    btn.setAttribute("aria-label", on ? "mute dino" : "unmute dino");
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.classList.toggle("dino-voice-toggle--on", on);
  };
  btn.addEventListener("click", () => {
    voice.toggle();
    render();
  });
  render();
  parent.appendChild(btn);
  return btn;
}
