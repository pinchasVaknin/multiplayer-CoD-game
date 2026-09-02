#!/usr/bin/env node
/**
 * The F14 cheat audit, as a check that can fail (M11 Gate B, playtest round 4).
 *
 * F14's design is one sentence — *a code is input, an entitlement is state, and every effect
 * reads the entitlement* — and the two ways that sentence stops being true are both silent.
 *
 * ## 1. An effect that asks whether a code was typed
 *
 * The failure that actually happens is not a second entitlement store; it is one `if
 * (code === 'SPEC[]1')` written in a hurry somewhere downstream, at which point the server has
 * stopped being the source of truth about that effect and nobody can tell by reading the
 * entitlement. So a code string may appear in exactly two places: the table that defines it, and
 * the harness that types one to test it. Anywhere else fails.
 *
 * ## 2. A bit in both halves of the partition, or in neither
 *
 * `CHEAT_SIMULATION` and `CHEAT_LOCAL` are what make the merge in `Game.cheatMask` one
 * expression instead of a rule somebody has to remember, and the whole security argument rests
 * on them being disjoint and complete. A bit in both would let a client author a simulation
 * entitlement for itself. A bit in neither would be an entitlement that silently cannot be
 * granted at all — the quieter failure of the two, and the one a playtest would report as "the
 * code does nothing".
 *
 * Same mechanism as `check-cosmetics` and `check-unlocks`: a rule a human has to remember is a
 * rule that will be broken by the next milestone.
 */

import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const CHEATS = 'src/shared/cheats/Cheats.ts';
/** The one file allowed to type a code, because typing one is what it is for. */
const HARNESS = 'src/server/skirmishHarness.ts';

const problems = [];
const src = readFileSync(CHEATS, 'utf8');

// ---- the codes, read out of the table ------------------------------------
const codes = [...src.matchAll(/\{ code: '([^']+)'/g)].map((m) => m[1]);
if (codes.length === 0) {
  problems.push(`found no codes in ${CHEATS} — this check has stopped checking`);
}

// ---- 1. nothing else names one -------------------------------------------
for (const file of walk('src')) {
  const rel = file.split(path.sep).join('/');
  if (rel === CHEATS || rel === HARNESS) continue;
  const body = readFileSync(file, 'utf8');
  for (const code of codes) {
    if (body.includes(`'${code}'`) || body.includes(`"${code}"`)) {
      problems.push(
        `${rel} names the cheat code ${code} as a literal. A code is input and an entitlement ` +
          'is state: read the entitlement (see `Cheat` in shared/cheats/Cheats.ts) instead, or ' +
          'the server has stopped being the authority for whatever this line decides.',
      );
    }
  }
}

// ---- 2. the partition is disjoint and complete ---------------------------
const bits = [...src.matchAll(/^  (\w+): 1 << (\d+),$/gm)].map((m) => ({
  name: m[1],
  value: 1 << Number(m[2]),
}));
if (bits.length === 0) {
  problems.push(`found no entitlement bits in ${CHEATS} — this check has stopped checking`);
}
const sim = maskOf('CHEAT_SIMULATION');
const local = maskOf('CHEAT_LOCAL');
for (const bit of bits) {
  const inSim = (sim & bit.value) !== 0;
  const inLocal = (local & bit.value) !== 0;
  if (inSim && inLocal) {
    problems.push(
      `Cheat.${bit.name} is in both CHEAT_SIMULATION and CHEAT_LOCAL. A client would be able ` +
        'to author it for itself while the server also claimed it — the merge in Game.cheatMask ' +
        'cannot resolve that, and the bit is an exploit.',
    );
  }
  if (!inSim && !inLocal) {
    problems.push(
      `Cheat.${bit.name} is in neither CHEAT_SIMULATION nor CHEAT_LOCAL, so nothing can ever ` +
        'grant it: Game.cheatMask masks with both halves and this bit falls out of each. Add it ' +
        'to whichever authority owns it.',
    );
  }
}

/** The value of a named mask, by resolving the `Cheat.X | Cheat.Y` expression it is written as. */
function maskOf(name) {
  const at = src.indexOf(`export const ${name} =`);
  if (at < 0) {
    problems.push(`${CHEATS} has no ${name} — the partition this check exists for is gone`);
    return 0;
  }
  const expr = src.slice(at, src.indexOf(';', at));
  let mask = 0;
  for (const m of expr.matchAll(/Cheat\.(\w+)/g)) {
    const bit = bits.find((b) => b.name === m[1]);
    if (bit === undefined) {
      problems.push(`${name} names Cheat.${m[1]}, which is not a bit in the table`);
      continue;
    }
    mask |= bit.value;
  }
  return mask;
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (full.endsWith('.ts')) yield full;
  }
}

if (problems.length > 0) {
  console.error('cheat audit FAILED (playtest round 4, F14):');
  for (const line of problems) console.error(`  - ${line}`);
  process.exit(1);
}

console.log(
  `cheat audit ok — ${codes.length} codes, ${bits.length} entitlement bits, ` +
    'partition disjoint and complete, no code named outside the table.',
);
