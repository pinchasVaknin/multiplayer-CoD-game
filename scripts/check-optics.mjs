#!/usr/bin/env node
/**
 * The optic audit (playtest round 4, B2 and its regression).
 *
 * ## The rule
 *
 * **A weapon modelled with `optic: 'scope'` must have a `scope` block in its `WeaponDef`.**
 *
 * Those two facts live in different partitions and drive different machinery, and nothing
 * connected them:
 *
 *   `WeaponModelSpec.optic`  (client)  decides the *geometry* — a 12-sided tube whose axis is
 *                                      `sightHeight`, which is the line `ViewmodelAnim.adsY`
 *                                      puts on the centre of the screen when the player aims.
 *   `WeaponDef.scope`        (shared)  decides the *hand-off* — above `SCOPE_VIEWMODEL_HIDDEN`
 *                                      the viewmodel is hidden and `HudTactical` draws the
 *                                      scope picture instead.
 *
 * With the first set and the second absent, aiming puts a solid tube on the sight line and
 * nothing takes it away. That was `ar_longbow`, reported as *"the crosshair is closed on one
 * particular AR"*, and it was exactly one weapon because it was the only disagreement.
 *
 * ## Why this is a check and not a comment
 *
 * The first fix opened the tube's ends so the eye could see through it, which traded a blocked
 * sight for a hollow one: an open cylinder is single-sided, so at hip fire — where the camera is
 * behind the weapon looking along it — all three scoped weapons read as a trough with the
 * reticle floating inside. Two playtests in a row reported a consequence of the same mismatch.
 *
 * A rule a human has to remember is a rule that will be broken, which is the argument
 * `check-boundaries` and `check-unlocks` are already built on. This is cheap, it runs in the
 * gate, and it fails by name.
 *
 * ## Limits, stated rather than assumed
 *
 * It reads sources with regular expressions, exactly as `check-cosmetics` and `check-unlocks`
 * do. It knows a spec *names* `optic: 'scope'` and that a def *has* a `scope:` block; it does
 * not know what either renders. What is on the screen is a browser claim and stays on that list.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPECS = 'src/client/weapons/WeaponModelSpecs.ts';
const DEFS_DIR = 'src/shared/weapons/defs';

function read(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) {
    console.error(`optic audit: ${rel} does not exist.`);
    process.exit(1);
  }
  return fs.readFileSync(p, 'utf8');
}

/** Strip block and line comments so prose about a scope is not mistaken for one. */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// ---- 1. which weapons are *modelled* with a scope --------------------------

const specSource = stripComments(read(SPECS));
const modelled = new Map();

/**
 * The base every spec spreads, and the reason inheritance is resolved rather than skipped.
 *
 * Most entries are `{ ...AR_BASE, receiverLength: ... }` and override only what differs, so an
 * entry with no `optic:` line inherits one. The first version of this audit recorded only
 * entries that named an optic, and reported "10 model specs" against twelve weapons without
 * saying so — a check that quietly examines five sixths of its subject is the shape of probe
 * this milestone has already shipped three of. `ar_vulcan` was the one it skipped.
 */
const baseOptic = (() => {
  const base = /const AR_BASE:\s*WeaponModelSpec\s*=\s*\{[\s\S]*?\n\};/.exec(specSource);
  if (base === null) {
    console.error('optic audit: cannot find AR_BASE, so inherited optics cannot be resolved.');
    process.exit(1);
  }
  const optic = /\boptic:\s*'([a-z]+)'/.exec(base[0]);
  if (optic === null) {
    console.error('optic audit: AR_BASE names no optic.');
    process.exit(1);
  }
  return optic[1];
})();

/**
 * Entries look like `  ar_longbow: {` ... `  },` at one indent level. Splitting on the entry
 * header and taking the text up to the next one is enough, and is what keeps this readable.
 */
const entryRe = /^\s{2}([a-z0-9_]+):\s*\{/gm;
const headers = [...specSource.matchAll(entryRe)];
for (let i = 0; i < headers.length; i++) {
  const id = headers[i][1];
  const start = headers[i].index;
  const end = i + 1 < headers.length ? headers[i + 1].index : specSource.length;
  const body = specSource.slice(start, end);
  const optic = /\boptic:\s*'([a-z]+)'/.exec(body);
  // An entry that does not override the optic inherits AR_BASE's.
  modelled.set(id, optic !== null ? optic[1] : baseOptic);
}

if (modelled.size === 0) {
  console.error('optic audit: parsed no weapon model specs — the audit read nothing.');
  process.exit(1);
}

// ---- 2. which weapons the simulation actually scopes ------------------------

const scopedDefs = new Set();
const definedIds = new Set();
for (const file of fs.readdirSync(path.join(ROOT, DEFS_DIR))) {
  if (!file.endsWith('.ts')) continue;
  const source = stripComments(read(path.join(DEFS_DIR, file)));
  const defRe = /^export const [A-Z0-9_]+:\s*WeaponDef\s*=\s*\{/gm;
  const defs = [...source.matchAll(defRe)];
  for (let i = 0; i < defs.length; i++) {
    const start = defs[i].index;
    const end = i + 1 < defs.length ? defs[i + 1].index : source.length;
    const body = source.slice(start, end);
    const id = /\bid:\s*'([a-z0-9_]+)'/.exec(body);
    if (id === null) continue;
    definedIds.add(id[1]);
    if (/^\s{2}scope:\s*\{/m.test(body)) scopedDefs.add(id[1]);
  }
}

if (definedIds.size === 0) {
  console.error('optic audit: parsed no weapon defs — the audit read nothing.');
  process.exit(1);
}

// ---- 3. the rule ------------------------------------------------------------

const failures = [];

for (const [id, optic] of modelled) {
  if (!definedIds.has(id)) {
    failures.push(`model spec "${id}" has no weapon def with that id`);
    continue;
  }
  if (optic === 'scope' && !scopedDefs.has(id)) {
    failures.push(
      `"${id}" is modelled with optic: 'scope' but its WeaponDef has no scope block — ` +
        `aiming it puts the tube on the sight line and nothing hands the picture to the overlay`,
    );
  }
}

/**
 * The converse, and it is worth checking too.
 *
 * A weapon the simulation scopes but that is *not* modelled with one hides its viewmodel at ADS
 * and draws a scope overlay over a rifle that has no scope on it. Nobody has shipped that, and
 * it is the failure that would look like "my sniper has no scope" rather than like a blocked
 * sight, so it would be reported differently and diagnosed from scratch.
 */
for (const id of scopedDefs) {
  // A def with no entry of its own falls back to AR_BASE — see `modelSpecFor`.
  const optic = modelled.get(id) ?? baseOptic;
  if (optic !== 'scope') {
    failures.push(
      `"${id}" has a scope block in its WeaponDef but is modelled with optic: '${optic}' — ` +
        `the overlay would replace a viewmodel that never had a scope on it`,
    );
  }
}

if (failures.length > 0) {
  console.error(`\nOPTIC AUDIT FAILED (${failures.length})\n`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    '\nWeaponModelSpec.optic and WeaponDef.scope are two answers to one question. They must agree:\n' +
      "a scope in the model without one in the def is a sight the player cannot see through.\n",
  );
  process.exit(1);
}

const scopedCount = [...definedIds].filter((id) => (modelled.get(id) ?? baseOptic) === 'scope').length;
const inherited = [...definedIds].filter((id) => !modelled.has(id)).length;
console.log(
  `optic audit ok — ${definedIds.size} weapons examined ` +
    `(${modelled.size} with their own model spec, ${inherited} inheriting AR_BASE's '${baseOptic}'), ` +
    `${scopedCount} scoped model(s) against ${scopedDefs.size} scoped def(s), every pair agreeing.`,
);
