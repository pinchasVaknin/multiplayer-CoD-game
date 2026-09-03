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
 * ## 2. A client-authored entitlement
 *
 * Every bit in the table is the server's. A `'surface'` code — one the client applies to itself
 * without asking — must therefore carry no bits at all, and a bit outside `CHEAT_SIMULATION`
 * could never be granted by anybody. Both are silent failures: the first is an exploit, the
 * second is a code that does nothing.
 *
 * ## What this file deliberately does *not* check
 *
 * The arithmetic. `bitsClearing` clearing every mask to exactly zero is the property the shipped
 * regression violated, and it was written here first — as a re-implementation of the function in
 * JavaScript, because this script cannot import TypeScript. Watched red, it **stayed green** with
 * the real function broken, because it was proving a property of its own copy.
 *
 * That is the trap this milestone keeps meeting from a new direction, so the proof moved to where
 * the real function runs: `assertClearingArithmetic` in `skirmishHarness.ts`, which imports it and
 * folds `toggleCheat` over its answer for every reachable mask on **every** harness run. A check
 * that cannot fail is worse than no check, because it is trusted.
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

// ---- 2. every bit is server-authored, and no surface code carries one ----
const bits = [...src.matchAll(/^  (\w+): 1 << (\d+),$/gm)].map((m) => ({
  name: m[1],
  value: 1 << Number(m[2]),
}));
if (bits.length === 0) {
  problems.push(`found no entitlement bits in ${CHEATS} — this check has stopped checking`);
}
const sim = maskOf('CHEAT_SIMULATION');
for (const bit of bits) {
  if ((sim & bit.value) === 0) {
    problems.push(
      `Cheat.${bit.name} is not in CHEAT_SIMULATION, so nothing can ever grant it: ` +
        'Game.cheatMask and NetClient both mask with it and this bit falls out of each. Either ' +
        'add it, or delete a bit nothing can grant.',
    );
  }
}

// A `'surface'` code is applied by the client without asking anybody, so it must not be able to
// grant an entitlement. This is the invariant that replaced F14's separate `local` flag.
for (const m of src.matchAll(/\{ code: '([^']+)', effect: \{ kind: '(\w+)'([^}]*)\}/g)) {
  const [, code, kind, rest] = m;
  if (kind === 'surface' && /bits/.test(rest)) {
    problems.push(
      `${code} is a 'surface' code and carries entitlement bits. A surface code is applied by ` +
        'the client without asking the server, so a bit on one is a bit a client can author ' +
        'for itself.',
    );
  }
  if (kind === 'toggle' && !/bits/.test(rest)) {
    problems.push(`${code} is a 'toggle' and carries no bits, so it toggles nothing.`);
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
  `cheat audit ok — ${codes.length} codes, ${bits.length} entitlement bits (all server-authored), ` +
    'no code named outside the table. The clearing arithmetic is proved in the harness, ' +
    'against the real function — see the note at the top of this file.',
);
