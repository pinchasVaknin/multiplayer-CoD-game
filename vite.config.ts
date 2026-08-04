import { defineConfig } from 'vite';

/**
 * The server address, injected at build time (M10, S4.9).
 *
 * S4.9: *"The server address is **configuration**, injected at build or runtime. Never
 * hardcoded."* This is the build-time half; `?server=` on the URL is the runtime half and
 * takes precedence over it. Both are absent by default, and absent means single-player —
 * which is what keeps opening the page behaving exactly as it did before this milestone.
 *
 * ```bash
 *   VITE_SERVER_URL=wss://play.example.com/ws npm run build
 * ```
 */
const serverUrl = process.env['VITE_SERVER_URL'] ?? '';

export default defineConfig({
  define: {
    __SERVER_URL__: JSON.stringify(serverUrl),
  },
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
