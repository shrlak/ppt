/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Base URL of the optional shared recognition proxy (e.g. a Cloudflare
   * Worker) that holds the site owner's Gemini/NVIDIA/Hugging Face API keys
   * server-side. When set, users with no personal key can still recognize
   * scores — see worker/README.md. Non-secret: safe to bake into the build.
   */
  readonly VITE_RECOGNITION_PROXY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
