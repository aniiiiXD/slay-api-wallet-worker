/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend base URL. Set in .env.local to target a local Worker. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
