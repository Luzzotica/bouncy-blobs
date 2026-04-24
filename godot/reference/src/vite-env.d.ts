/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SPACETIME_DB_URL?: string;
  readonly VITE_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

