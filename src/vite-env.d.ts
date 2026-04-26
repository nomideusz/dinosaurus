/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the shared archive service (no trailing slash). */
  readonly VITE_ARCHIVE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "virtual:radio-manifest" {
  /**
   * Map of channel folder names → array of public URLs of the audio files
   * present in that folder. Built at vite dev start / build time by the
   * radioManifestPlugin in vite.config.ts.
   */
  export const RADIO_MANIFEST: Record<string, string[]>;
}
