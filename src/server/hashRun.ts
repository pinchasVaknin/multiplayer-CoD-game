import { writeFileSync } from 'node:fs';
import { installClock } from '../shared/core/Clock';
import { verifyAgainstNative } from '../shared/core/SimMath';
import {
  DETERMINISM_DEFAULTS,
  mathDigest,
  runDeterminismScenario,
  runFingerprint,
} from '../shared/debug/Determinism';
import { nodeClock } from './NodeClock';

/**
 * Node's half of the cross-runtime determinism check (M9, S6.6 and S7).
 *
 * Runs the fixed command sequence through the shared simulation and writes one JSON file of
 * per-tick samples. The browser writes its own from the debug console
 * (`__operator.determinism.download()`), and `scripts/diff-hashes.mjs` compares the two and
 * reports the first divergent tick and the field that differs.
 *
 * Kept as its own entry point rather than a flag on `main.ts` because it is not a match — it
 * runs no loop, no bots and no mode, and mixing it into the server's argument parsing would
 * imply otherwise.
 *
 * Usage:
 *   npm run hashes
 *   node dist-server/hashRun.js --ticks 7200 --out node-hashes.json
 */

interface Args {
  ticks: number;
  seed: number;
  out: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    ticks: DETERMINISM_DEFAULTS.ticks,
    seed: DETERMINISM_DEFAULTS.seed,
    out: 'node-hashes.json',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      i++;
      return v;
    };
    switch (a) {
      case '--ticks':
        args.ticks = Number.parseInt(next(), 10);
        break;
      case '--seed':
        args.seed = Number.parseInt(next(), 10);
        break;
      case '--out':
        args.out = next();
        break;
      default:
        throw new Error(`unknown argument "${a}"`);
    }
  }
  if (!Number.isFinite(args.ticks) || args.ticks < 1) throw new Error('--ticks must be >= 1');
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  installClock(nodeClock);

  const started = nodeClock.nowMs();
  const samples = runDeterminismScenario({ ticks: args.ticks, seed: args.seed });
  const elapsed = nodeClock.nowMs() - started;

  const payload = {
    runtime: 'node',
    version: process.version,
    v8: process.versions.v8,
    ticks: samples.length,
    seed: args.seed,
    fingerprint: runFingerprint(samples),
    // Reported alongside, because when the state fingerprints disagree this is what says
    // which arithmetic disagreed. See `mathDigest`.
    math: mathDigest(),
    simMathAccuracy: verifyAgainstNative(200000, 64),
    samples,
  };
  writeFileSync(args.out, JSON.stringify(payload), 'utf8');

  process.stdout.write(
    `${samples.length} ticks in ${elapsed.toFixed(1)}ms — fingerprint ${payload.fingerprint}\n` +
      `v8 ${payload.v8}\n` +
      `simSin/simCos vs native: max ${payload.simMathAccuracy.maxUlpSin.toFixed(2)} / ` +
      `${payload.simMathAccuracy.maxUlpCos.toFixed(2)} ULP over ` +
      `${payload.simMathAccuracy.samples} samples\n` +
      Object.entries(payload.math)
        .map(([k, v]) => `  ${k.padEnd(12)} ${v}`)
        .join('\n') +
      `\nwritten to ${args.out}\n`,
  );
}

try {
  main();
} catch (err: unknown) {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
