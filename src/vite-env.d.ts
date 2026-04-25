/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the shared archive service (no trailing slash). */
  readonly VITE_ARCHIVE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
