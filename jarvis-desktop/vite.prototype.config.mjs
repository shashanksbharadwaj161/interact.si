import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Builds the companion experience prototype next to a copy of the hub, so the prototype can open the real hub (on its
// browser preview bridge) in a frame. Output goes to dist-prototype/, never into the production dist/.
const r = (p) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 4329, open: '/prototype/index.html' },
  preview: { host: '127.0.0.1', port: 4329 },
  build: { outDir: 'dist-prototype', emptyOutDir: true, rollupOptions: { input: { prototype: r('./prototype/index.html'), board: r('./prototype/board.html'), island: r('./prototype/island.html'), hub: r('./index.html') } } },
});
