import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Single self-contained HTML file (JS + CSS inlined, no separate asset
// requests) -- this is what server.js's `spaHtml` option serves at `/`.
// No CDN fetches anywhere in this config or its output: fonts are system
// stacks (see web/theme/tokens.css), not remote-loaded.
export default defineConfig({
  root: 'web',
  base: './',
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000, // inline everything; there is no CDN/asset server for this to matter to.
    cssCodeSplit: false,
  },
});
