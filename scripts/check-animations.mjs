#!/usr/bin/env node
/**
 * The animation library audit (M13 Phase D).
 *
 * ## The rules
 *
 * The catalogue (`src/client/characters/CharacterCatalog.ts`) and the folder it names
 * (`public/models/bots/animations/`) are two descriptions of one library, and nothing held
 * them to each other: a file could be catalogued and not shipped (a 404 and a procedural body
 * for the whole match), shipped and not catalogued (dead weight in every deploy, or the file
 * the artist thinks is live), or catalogued in a slot the selector never asks for. So:
 *
 *   1. **Every catalogued file exists.** `named('deaths/Death_Stand_01')` is
 *      `deaths/Death_Stand_01.glb`, and it is there.
 *   2. **Every shipped file is catalogued** — every `.glb` outside `incoming/`, which is the
 *      one folder whose files are meant to be waiting.
 *   3. **Every slot the selector can return is non-empty**, and every slot is asked for.
 *      `AnimationSelector.ts` names its answers as string literals; each is a slot in the
 *      catalogue with at least one file. And each catalogued slot is named by the selector or
 *      the animator (which asks for the transitions itself), or it is a file shipped in every
 *      deploy and never drawn.
 *   4. **Every file has exactly one clip, named after the file** — the export contract, met
 *      by every file since decision 13 (2026-09-14). A Mixamo session export in a slot would
 *      fail to load at runtime (the catalogue asks for the clip by name and finds
 *      `mixamo.com.NNN`); here the message names the file and the tool that fixes it.
 *   5. **`DEATH_VARIANTS` is a multiple of every death slot's count.** The simulation deals
 *      `deathVariant` from `DEATH_VARIANTS`; the client indexes the slot's clips by it modulo
 *      their count. With four variants and three clips the first is dealt twice as often, and
 *      nothing would say so.
 *   6. **Every folder is explained.** A folder under the library that the README does not
 *      name is a folder whose meaning is in someone's head.
 *
 *
 * ## Limits, stated rather than assumed
 *
 * It reads the catalogue and the selector with regular expressions, as `check-cosmetics` and
 * `check-unlocks` do, and reads each GLB's JSON chunk through `animation-manifest.mjs`. It
 * knows a slot is named and a file has one clip; it does not know what the clip looks like on
 * a skin. That is `measure-crouch.mjs` and a browser.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ANIMATIONS_DIR, INCOMING_DIR, listGlbFiles, readAnimationFile, ROOT } from './animation-manifest.mjs';

const CATALOG = 'src/client/characters/CharacterCatalog.ts';
const SELECTOR = 'src/client/characters/AnimationSelector.ts';
const ANIMATOR = 'src/client/characters/CharacterAnimator.ts';
const VISUAL_STATE = 'src/shared/ai/BotVisualState.ts';
const README = 'README.md';

function read(rel) {
  const p = path.join(ROOT, rel);
  if (!existsSync(p)) {
    console.error(`animation audit: ${rel} does not exist.`);
    process.exit(1);
  }
  return readFileSync(p, 'utf8');
}

/** Strip block and line comments so prose about a slot is not mistaken for one. */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const failures = [];

// ---- 1. the catalogue: slots and the files behind them --------------------------------

const catalogSource = stripComments(read(CATALOG));

/** The union type: every slot id the game can name. */
const unionMatch = /export type CharacterAnimationId =([^;]+);/.exec(catalogSource);
if (unionMatch === null) {
  console.error('animation audit: cannot find the CharacterAnimationId union.');
  process.exit(1);
}
const slotIds = [...unionMatch[1].matchAll(/'([A-Za-z0-9]+)'/g)].map((m) => m[1]);

/**
 * The library table: `  <slot>: slot('<slot>', '<kind>', '<folder>/<File>', ...),` one line
 * per slot, at one indent level. The line is split into its file paths.
 */
const slotLineRe = /^\s{2}([A-Za-z0-9]+):\s*slot\('([A-Za-z0-9]+)',\s*'([a-zA-Z]+)',([^\n]*)\),?$/gm;
const slots = new Map();
for (const match of catalogSource.matchAll(slotLineRe)) {
  const [, key, id, kind, rest] = match;
  if (key !== id) failures.push(`catalogue slot "${key}" is built as slot('${id}', …) — the key and the id must agree`);
  const files = [...rest.matchAll(/'([A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)+)'/g)].map((entry) => ({ path: entry[1] }));
  if (files.length === 0) failures.push(`catalogue slot "${key}" names no files`);
  slots.set(key, { kind, files });
}
if (slots.size === 0) {
  console.error('animation audit: parsed no slots from the catalogue — the audit read nothing.');
  process.exit(1);
}
for (const id of slotIds) if (!slots.has(id)) failures.push(`slot "${id}" is in the CharacterAnimationId union but not in the library table`);
for (const id of slots.keys()) if (!slotIds.includes(id)) failures.push(`library table has a slot "${id}" that is not in the CharacterAnimationId union`);

// ---- 2. the folder: every catalogued file exists, every shipped file is catalogued -------

const animationsRoot = path.join(ROOT, ANIMATIONS_DIR);
const shipped = new Set(listGlbFiles(animationsRoot).filter((rel) => !rel.startsWith(`${INCOMING_DIR}/`)));
const catalogued = new Map();
for (const [id, slot] of slots) {
  for (const file of slot.files) {
    const rel = `${file.path}.glb`;
    if (catalogued.has(rel)) failures.push(`"${rel}" is catalogued twice (slots "${catalogued.get(rel).slot}" and "${id}")`);
    catalogued.set(rel, { slot: id, ...file });
    if (!shipped.has(rel)) {
      failures.push(
        rel.startsWith(`${INCOMING_DIR}/`)
          ? `slot "${id}" names "${rel}" — nothing in ${INCOMING_DIR}/ is loaded; import it into a slot folder first`
          : `slot "${id}" names "${rel}" but ${ANIMATIONS_DIR}/${rel} does not exist`,
      );
    }
  }
}
for (const rel of shipped) {
  if (!catalogued.has(rel)) failures.push(`${ANIMATIONS_DIR}/${rel} is shipped but no slot names it — catalogue it or move it to ${INCOMING_DIR}/`);
}

// ---- 3. the selector: every answer it can give is a non-empty slot -----------------------

const selectorSource = stripComments(read(SELECTOR));
const asked = new Set([...selectorSource.matchAll(/'([A-Za-z0-9]+)'/g)].map((m) => m[1]).filter((word) => slotIds.includes(word)));
if (asked.size === 0) {
  console.error('animation audit: the selector names no slots — the audit read nothing.');
  process.exit(1);
}
for (const id of asked) {
  const slot = slots.get(id);
  if (slot === undefined || slot.files.length === 0) failures.push(`the selector can return "${id}" and the catalogue has no file for it`);
}

/**
 * The converse: a slot nobody asks for is a file shipped in every deploy and never drawn.
 * The transitions are the animator's to ask for rather than the selector's, so both sources
 * count.
 */
const animatorSource = stripComments(read(ANIMATOR));
const askedAnywhere = new Set([...asked, ...[...animatorSource.matchAll(/'([A-Za-z0-9]+)'/g)].map((m) => m[1]).filter((word) => slotIds.includes(word))]);
for (const id of slots.keys()) {
  if (!askedAnywhere.has(id)) failures.push(`slot "${id}" is catalogued but neither the selector nor the animator ever asks for it`);
}

// ---- 4. the contract, per file ---------------------------------------------------------

for (const rel of catalogued.keys()) {
  if (!shipped.has(rel)) continue;
  let file;
  try {
    file = readAnimationFile(path.join(animationsRoot, rel));
  } catch (error) {
    failures.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  const stem = path.basename(rel, '.glb');
  if (!file.contract) {
    failures.push(
      `${rel} has ${file.clips.length} clip(s) named ${file.clips.map((c) => `"${c.name}"`).join(', ') || 'nothing'} — ` +
        `the contract is one clip named "${stem}"; run scripts/animation-import.mjs on it`,
    );
    continue;
  }
  if (file.clips[0].hips === null) failures.push(`${rel}: the clip has no mixamorigHips translation track, which the root lock needs`);
}

// ---- 5. deaths: the simulation's count against the catalogue's ---------------------------

const visualSource = stripComments(read(VISUAL_STATE));
const deathVariants = /export const DEATH_VARIANTS = (\d+);/.exec(visualSource);
if (deathVariants === null) {
  failures.push(`cannot find DEATH_VARIANTS in ${VISUAL_STATE}`);
} else {
  const variants = Number(deathVariants[1]);
  for (const [id, slot] of slots) {
    if (!/^death/.test(id)) continue;
    const count = slot.files.length;
    if (count > 0 && variants % count !== 0) {
      failures.push(
        `death slot "${id}" has ${count} clip(s) and DEATH_VARIANTS is ${variants} — indexed modulo ${count}, ` +
          `the variants are not dealt evenly; make DEATH_VARIANTS a multiple of ${count}`,
      );
    }
  }
}

// ---- 6. the README names every folder --------------------------------------------------

const readme = existsSync(path.join(animationsRoot, README)) ? readFileSync(path.join(animationsRoot, README), 'utf8') : null;
if (readme === null) {
  failures.push(`${ANIMATIONS_DIR}/${README} is missing — the folder is meant to explain itself`);
} else {
  const folders = [];
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      folders.push(childRel);
      walk(path.join(abs, entry.name), childRel);
    }
  };
  walk(animationsRoot, '');
  for (const folder of folders) {
    // A leaf folder is named in full (`locomotion/stand/`); a parent is covered by its leaves.
    const hasChildren = folders.some((other) => other.startsWith(`${folder}/`));
    if (hasChildren) continue;
    if (!readme.includes(`\`${folder}/\``)) failures.push(`${ANIMATIONS_DIR}/${folder}/ is not named in ${ANIMATIONS_DIR}/${README}`);
  }
}

// ---- verdict ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\nANIMATION AUDIT FAILED (${failures.length})\n`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    '\nThe catalogue and the animations folder are two descriptions of one library. They must agree:\n' +
      'a file nobody catalogued is never drawn, a slot nobody shipped is a procedural body for the match.\n',
  );
  process.exit(1);
}

const variantSlots = [...slots.values()].filter((slot) => slot.files.length > 1).length;
const incoming = listGlbFiles(animationsRoot).filter((rel) => rel.startsWith(`${INCOMING_DIR}/`)).length;
console.log(
  `animation audit ok — ${slots.size} slots (${asked.size} the selector can return, ${variantSlots} with variants) over ` +
    `${shipped.size} shipped files, every one on the export contract; ${incoming} waiting in ${INCOMING_DIR}/.`,
);
