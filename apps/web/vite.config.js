import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works on GitHub Pages / any static host subpath.
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  server: {
    host: true,
  },
});
