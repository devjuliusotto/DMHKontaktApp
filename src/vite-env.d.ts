/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_CHANNEL?: "stable" | "admin-test";
  readonly VITE_FEATURE_AUTHENTICATOR_DEFAULT?: "true" | "false";
  readonly VITE_FEATURE_SERVICES_DEFAULT?: "true" | "false";
  readonly VITE_SOURCE_COMMIT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
