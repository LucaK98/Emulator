import { defineConfig } from 'vite';

// GitHub Pages project site lives at https://<user>.github.io/Emulator/.
// BASE_PATH lets CI, local dev and e2e tests override it.
const base = process.env.BASE_PATH ?? '/Emulator/';

// Cross-origin isolation is required for SharedArrayBuffer, which the emulator
// workers use for framebuffer and audio transfer. In dev we can set the headers
// directly; in production on GitHub Pages the service worker injects them
// (see public/sw.js) because Pages cannot serve custom headers.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export default defineConfig({
  base,
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
  server: {
    headers: isolationHeaders,
  },
  preview: {
    headers: isolationHeaders,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
