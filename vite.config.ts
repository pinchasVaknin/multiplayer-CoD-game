import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    // `three/examples/jsm/*` imports bare `three`, which the dep optimiser is happy to
    // resolve to a second copy — Three then warns about multiple instances at boot and
    // the two copies stop sharing state. One `three`, deduped.
    dedupe: ['three'],
  },
  optimizeDeps: {
    include: ['three', 'three/examples/jsm/utils/BufferGeometryUtils.js'],
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
