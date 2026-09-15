#!/usr/bin/env node
/**
 * The skin library audit (M15, B0).
 *
 * `check-animations` holds the clip library to its catalogue; this holds the skins to theirs,
 * and to a size. The size rule exists because of a number: the seven skins weighed 109 MB,
 * three of them 24–38 MB, and the one that preloads at boot was 28 MB — so a Create-a-Class
 * stage that shows the player's skin would have waited on a download twenty times the size
 * of the whole client. `scripts/skin-compress.mjs` brought the library to 17 MB; this is what
 * keeps it there when the next skin is dropped into the folder at 2048×2048.
 *
 *   1. **Every catalogued skin exists**, and **every shipped skin is catalogued** —
 *      `CHARACTER_DEFINITIONS` names a file per id (`character('echo', 'Echo.glb', …)`), and
 *      the folder holds exactly those files.
 *   2. **No skin is over `MAX_SKIN_BYTES`** (5 MB): the size the four light skins always were,
 *      and the heaviest is 4.0 MB after the pass.
 *   3. **No texture is over 1024 on a side, and none is a PNG.** The cause of rule 2 failing,
 *      named so the message says what to run rather than what went wrong.
 *
 * The images are read with `glb-images.mjs`; nothing here decodes a pixel. Exit code 1 on any
 * violation.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { glbImages, readGlb } from './glb-images.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKINS_DIR = 'public/models/bots/skins';
const CATALOG = 'src/client/characters/CharacterCatalog.ts';
const MAX_SKIN_BYTES = 5 * 1024 * 1024;
const MAX_TEXTURE_SIDE = 1024;
const FIX = 'run `node scripts/skin-compress.mjs`, then bump CHARACTER_VERSION';

const problems = [];

// ---- 1. the catalogue and the folder agree ---------------------------------------
const catalog = readFileSync(path.join(ROOT, CATALOG), 'utf8');
const catalogued = new Map();
for (const m of catalog.matchAll(/character\('([a-z]+)',\s*'([A-Za-z0-9_-]+\.glb)'/g)) catalogued.set(m[2], m[1]);
if (catalogued.size === 0) problems.push(`${CATALOG} has no character('id', 'File.glb', …) entries to audit.`);

const dir = path.join(ROOT, SKINS_DIR);
const shipped = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.glb')).sort() : [];
for (const [file, id] of catalogued) {
  if (!shipped.includes(file)) problems.push(`'${id}' is catalogued as ${SKINS_DIR}/${file}, which does not exist.`);
}
for (const file of shipped) {
  if (!catalogued.has(file)) problems.push(`${SKINS_DIR}/${file} is shipped but no character in ${CATALOG} names it.`);
}

// ---- 2 and 3. size, and the reason for it -------------------------------------------
let totalBytes = 0;
let textures = 0;
for (const file of shipped) {
  const full = path.join(dir, file);
  const bytes = statSync(full).size;
  totalBytes += bytes;
  const images = glbImages(readGlb(full));
  textures += images.length;
  const oversize = images.filter((im) => im.width > MAX_TEXTURE_SIDE || im.height > MAX_TEXTURE_SIDE);
  const pngs = images.filter((im) => im.mimeType === 'image/png');
  if (bytes > MAX_SKIN_BYTES) {
    problems.push(
      `${SKINS_DIR}/${file} is ${(bytes / 1048576).toFixed(1)} MB; the limit is ${MAX_SKIN_BYTES / 1048576} MB — ${FIX}.`,
    );
  }
  for (const im of oversize) {
    problems.push(`${SKINS_DIR}/${file} image ${im.index} (${im.name || im.mimeType}) is ${im.width}x${im.height}; the limit is ${MAX_TEXTURE_SIDE} on a side — ${FIX}.`);
  }
  for (const im of pngs) {
    problems.push(`${SKINS_DIR}/${file} image ${im.index} (${im.name || 'unnamed'}) is a ${Math.round(im.bytes / 1024)} kB PNG; every material is opaque, so it should be a JPEG — ${FIX}.`);
  }
}

if (problems.length > 0) {
  console.error('skin audit FAILED:\n');
  for (const p of problems) console.error(`  ${p}\n`);
  console.error(`${problems.length} problem(s). See scripts/check-skins.mjs.`);
  process.exit(1);
}

console.log(
  `skin audit ok — ${shipped.length} skins, ${(totalBytes / 1048576).toFixed(1)} MB in all, ${textures} textures, ` +
    `none over ${MAX_SKIN_BYTES / 1048576} MB or ${MAX_TEXTURE_SIDE} px, every one catalogued.`,
);
