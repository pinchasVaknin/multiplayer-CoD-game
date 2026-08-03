#!/usr/bin/env node
/**
 * The cross-runtime state-hash differ (M9, S7).
 *
 * *"Run N ticks of a fixed command sequence in both runtimes and diff the per-tick hashes,
 * reporting the first divergent tick and the field that differs."*
 *
 * Both halves write the same JSON shape:
 *
 *   node dist-server/hashRun.js --out node-hashes.json
 *   # in the browser console: __operator.determinism.download()
 *   node scripts/diff-hashes.mjs node-hashes.json browser-hashes.json
 *
 * The "and the field that differs" clause is why each sample carries named fields as well as
 * a hash. A hash alone tells you a run diverged and leaves you bisecting; the field tells you
 * whether it was the pose, the ammunition or the RNG stream, which is usually the whole
 * diagnosis. When the M9 check first ran, the answer was "vz, by one unit in the last place"
 * — and that immediately ruled out logic and pointed at arithmetic.
 *
 * The maths digests are compared too, and reported first when they differ, because an
 * arithmetic disagreement *causes* the state disagreement and fixing the state divergence
 * without it would be chasing the symptom.
 */

import fs from 'node:fs';

const [, , aPath, bPath] = process.argv;
if (aPath === undefined || bPath === undefined) {
  console.error('usage: node scripts/diff-hashes.mjs <a.json> <b.json>');
  process.exit(2);
}

const load = (p) => {
  if (!fs.existsSync(p)) {
    console.error(`missing: ${p}`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
};

const a = load(aPath);
const b = load(bPath);

console.log(`A  ${a.runtime}  ${a.version ?? '?'}  ticks ${a.ticks}  fingerprint ${a.fingerprint}`);
console.log(`B  ${b.runtime}  ${b.version ?? '?'}  ticks ${b.ticks}  fingerprint ${b.fingerprint}`);
console.log('');

// ---- 1. arithmetic, before state -------------------------------------------
if (a.math !== undefined && b.math !== undefined) {
  const names = [...new Set([...Object.keys(a.math), ...Object.keys(b.math)])].sort();
  const bad = names.filter((n) => a.math[n] !== b.math[n]);
  if (bad.length > 0) {
    console.log('MATHS DISAGREES between these runtimes:');
    for (const n of bad) console.log(`  ${n.padEnd(12)} A ${a.math[n]}   B ${b.math[n]}`);
    console.log(
      '\nA state divergence below is a consequence of this, not a separate bug. Anything\n' +
        'listed here that the simulation uses must be replaced with a deterministic version\n' +
        '(see shared/core/SimMath.ts) before the state hashes can agree.\n',
    );
  } else {
    console.log(`maths: all ${names.length} digests agree.\n`);
  }
}

// ---- 2. state --------------------------------------------------------------
if (a.seed !== b.seed) {
  console.error(`seeds differ (${a.seed} vs ${b.seed}) — the runs are not comparable.`);
  process.exit(2);
}

const n = Math.min(a.ticks, b.ticks);
if (a.ticks !== b.ticks) {
  console.log(`note: tick counts differ (${a.ticks} vs ${b.ticks}); comparing the first ${n}.`);
}

const FIELDS = [
  'x', 'y', 'z',
  'vx', 'vy', 'vz',
  'yaw', 'pitch',
  'stance', 'grounded', 'eyeHeight',
  'mag', 'reserve', 'adsFraction', 'spreadDeg',
  'rng0', 'rng1', 'rng2', 'rng3',
];

let firstBad = -1;
for (let i = 0; i < n; i++) {
  if (a.samples[i].hash !== b.samples[i].hash) {
    firstBad = i;
    break;
  }
}

if (firstBad === -1) {
  console.log(`STATE MATCHES across all ${n} ticks.`);
  if (a.fingerprint !== b.fingerprint && a.ticks === b.ticks) {
    console.error('but the fingerprints differ — the differ or the fingerprint is wrong.');
    process.exit(1);
  }
  process.exit(0);
}

const sa = a.samples[firstBad];
const sb = b.samples[firstBad];
console.log(`STATE DIVERGES at tick ${firstBad} (of ${n}).`);
console.log(`  previous tick hash: ${firstBad > 0 ? a.samples[firstBad - 1].hash : '(none)'}`);
console.log(`  A hash ${sa.hash}   B hash ${sb.hash}\n`);
console.log('  field         A                          B                          delta');
for (const f of FIELDS) {
  if (sa[f] === sb[f]) continue;
  const delta =
    typeof sa[f] === 'number' && typeof sb[f] === 'number' ? String(sa[f] - sb[f]) : '(not numeric)';
  console.log(`  ${f.padEnd(13)} ${String(sa[f]).padEnd(26)} ${String(sb[f]).padEnd(26)} ${delta}`);
}
process.exit(1);
