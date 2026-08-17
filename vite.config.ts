import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { viteStaticCopy } from 'vite-plugin-static-copy';

// Deployed under https://<user>.github.io/ppt/ via GitHub Pages (project
// sites are served at /<repo-name>/). BASE_PATH can override for local
// preview or a different repo name; CI passes it from the actual repo name.
const base = process.env.BASE_PATH ?? '/ppt/';

export default defineConfig({
  base,
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        // pdf.js needs cmaps for CID-keyed fonts (e.g. Adobe-Korea1 in scanned conti PDFs)
        { src: 'node_modules/pdfjs-dist/cmaps', dest: '.' },
        { src: 'node_modules/pdfjs-dist/standard_fonts', dest: '.' },
      ],
    }),
  ],
  build: {
    target: 'es2022',
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    alias: {
      // The shared proxy extends Cloudflare's DurableObject base class. Tests
      // run its routes in plain Node, so the import resolves to a stub and the
      // storage comes from tests/support/workerHarness.ts.
      'cloudflare:workers': new URL('./tests/support/cloudflare-workers-stub.ts', import.meta.url).pathname,
    },
  },
});
