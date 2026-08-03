import { defineConfig } from 'vite';

/**
 * The server build (M9).
 *
 * Node cannot load this source directly. Its native type stripping requires an explicit
 * `.js` extension on every relative import, and the tree uses extensionless specifiers
 * throughout — adding ~400 extensions across `shared/` so that Node could read it would be a
 * change the browser build carries for the server's benefit, which is the coupling this
 * milestone exists to remove.
 *
 * So the server is bundled, with the bundler already in the stack (S2 permits no new
 * libraries; Vite is not a new one). `ssr` mode targets Node, leaves built-ins external, and
 * resolves specifiers exactly the way the client build does — so the two targets cannot
 * disagree about which module a path means.
 *
 * The output is a single ESM file with a sourcemap, so a stack trace from a soak run points
 * at real source lines rather than at bundle offsets.
 */
export default defineConfig({
  build: {
    // Two entries: the server itself, and the determinism run of S6.6. The second is not a
    // flag on the first because it is not a match — no loop, no bots, no mode.
    ssr: true,
    outDir: 'dist-server',
    emptyOutDir: true,
    target: 'node22',
    sourcemap: true,
    minify: false,
    rollupOptions: {
      input: {
        main: 'src/server/main.ts',
        hashRun: 'src/server/hashRun.ts',
      },
      output: { entryFileNames: '[name].js', format: 'esm' },
    },
  },
  ssr: {
    // Nothing here should reach for a dependency at all. `three` is banned in both `shared/`
    // and `server/` by the boundary check, and this build would fail loudly if one appeared.
    noExternal: true,
  },
});
