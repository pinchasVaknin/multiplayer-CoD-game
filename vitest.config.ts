import { defineConfig } from 'vitest/config';

/**
 * The unit-test runner (M14, Phase A).
 *
 * Its own file rather than a `test` block in `vite.config.ts`, and it does not import that
 * config either: the client config carries `define.__SERVER_URL__`, an `optimizeDeps` list for
 * three and a dev `server` block, none of which a test wants, and importing it would make every
 * test run depend on an environment variable it never reads.
 *
 * Tests are co-located (`X.test.ts` beside `X.ts`) and compiled by the partition they sit in,
 * so a `shared/` test typechecks with no DOM lib and imports `describe/it/expect` explicitly —
 * there are no globals here, by design, because a global `expect` would be a name the boundary
 * check cannot see the origin of. The environment is `node` for the same reason: S2 admits
 * vitest and nothing else, so there is no jsdom, and a client test covers pure functions only.
 *
 * Vitest tests pure functions; the headless harnesses (`npm run harness`, `skirmish`, `leak`,
 * `content`, ...) stay the integration instruments. A test that goes red against the tree as
 * it is reports a finding — it does not get "fixed" in the audit or the harness.
 */
export default defineConfig({
  // The same option the two Vite builds carry (Phase B): oxc lowers legacy decorators only.
  // Standard (TC39) decorators do not run on this toolchain — the `@` line ships verbatim —
  // so the whole tree, tests included, is on `experimentalDecorators`. Harmless before any
  // decorator exists; wrong to leave out once one does, because vitest uses Vite's transform.
  oxc: { decorator: { legacy: true } },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
