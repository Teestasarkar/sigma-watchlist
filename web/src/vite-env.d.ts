/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Base URL for the API.
   *
   * Empty in development (Vite proxies /api) and in single-origin production
   * builds. Set it when the frontend is deployed separately from the API -
   * which is the case on the free hosting tiers, where the static site and the
   * Node process live on different domains.
   */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
