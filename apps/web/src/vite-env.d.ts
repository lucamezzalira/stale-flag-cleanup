/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DATAFILE_URL: string;
  readonly VITE_BUILD_ID?: string;
  readonly VITE_TINYBIRD_API_HOST?: string;
  readonly VITE_TINYBIRD_APPEND_TOKEN?: string;
  readonly VITE_EVENT_FLUSH_MS?: string;
  readonly VITE_EVENT_BATCH_SIZE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
