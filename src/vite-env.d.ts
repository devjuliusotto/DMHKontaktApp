/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_CHANNEL?: "stable" | "admin-test";
  readonly VITE_SOURCE_COMMIT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
