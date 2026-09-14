#!/usr/bin/env node
/**
 * M13 Phase D — take a file out of `incoming/` and into a slot folder, meeting the export
 * contract on the way.
 *
 * The contract (`docs/CHARACTER-ASSETS.md`) is one clip per file, named after the file, which
 * the catalogue asks for by name. Nothing delivered has met it: a Mixamo session exported from
 * Blender carries every animation of the session as cumulative `mixamo.com.NNN` clips, of
 * which the last is the one the file is named for, and until decision 13 a legacy "last clip
 * plus expected duration" selector was how the game found it. That rule is a thing a human has
 * to remember at every export, so here it is as a tool instead:
 *
 *   node scripts/animation-import.mjs incoming/Death_Stand_01.glb deaths
 *
 * writes `deaths/Death_Stand_01.glb` containing exactly one clip, named `Death_Stand_01`,
 * with the chosen clip's track data copied byte for byte — the sampler accessors are the same
 * bytes at new offsets — and everything the other clips referenced dropped, so the file is
 * also a fraction of its size. The source leaves `incoming/` unless `--keep` says otherwise.
 * `--clip <index>` picks a clip other than the last, `--as <Name>` names the output (and its
 * clip) differently from the source, and `--dry-run` reports without writing. With no folder,
 *
 *   node scripts/animation-import.mjs deaths/Death_Stand.glb
 *
 * rewrites a file already in its slot folder in place — how the original eleven session
 * exports were brought onto the contract (decision 13, 2026-09-14).
 *
 * It rewrites the GLB at the JSON level: keep one animation, walk every reference to an
 * accessor (the animation's samplers, the skins' inverse bind matrices, any mesh), keep those
 * accessors and the buffer views under them, repack the BIN chunk from the kept views, and
 * renumber. It does not decode a single float, so it cannot change one. `check-animations`
 * then holds the catalogue to the file, and `animation-manifest.mjs` reads it back the same
 * way it read the source.
 */

import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANIMATIONS_DIR, INCOMING_DIR, readAnimationFile, readGlb, ROOT, skinBoneSet } from './animation-manifest.mjs';

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

// -- the rewrite -------------------------------------------------------------------

/**
 * A new glTF JSON and BIN holding only `animations[clipIndex]`, renamed `clipName`.
 *
 * Every accessor index in the document is visited through one table of where accessor
 * references live, so a file with a mesh or a second skin keeps them intact; an animation-only
 * container keeps its throwaway skeleton and the inverse bind matrices the skin points at.
 */
export function isolateClip(json, bin, clipIndex, clipName) {
  const chosen = json.animations?.[clipIndex];
  if (chosen === undefined) throw new Error(`no animation at index ${clipIndex} (${json.animations?.length ?? 0} in the file)`);

  const out = structuredClone(json);
  out.animations = [{ ...structuredClone(chosen), name: clipName }];

  // 1. Which accessors survive: every one something still points at.
  const keptAccessors = new Set();
  const visitAccessors = (document, visit) => {
    for (const animation of document.animations ?? []) {
      for (const sampler of animation.samplers ?? []) {
        visit(sampler, 'input');
        visit(sampler, 'output');
      }
    }
    for (const skin of document.skins ?? []) visit(skin, 'inverseBindMatrices');
    for (const mesh of document.meshes ?? []) {
      for (const primitive of mesh.primitives ?? []) {
        visit(primitive, 'indices');
        for (const key of Object.keys(primitive.attributes ?? {})) visit(primitive.attributes, key);
        for (const target of primitive.targets ?? []) for (const key of Object.keys(target)) visit(target, key);
      }
    }
  };
  visitAccessors(out, (holder, key) => {
    if (typeof holder[key] === 'number') keptAccessors.add(holder[key]);
  });

  // 2. Which buffer views survive: those under a kept accessor (and any image or sparse index).
  const keptViews = new Set();
  const visitViews = (document, accessorKept, visit) => {
    (document.accessors ?? []).forEach((accessor, index) => {
      if (!accessorKept(index)) return;
      visit(accessor, 'bufferView');
      if (accessor.sparse !== undefined) {
        visit(accessor.sparse.indices, 'bufferView');
        visit(accessor.sparse.values, 'bufferView');
      }
    });
    for (const image of document.images ?? []) visit(image, 'bufferView');
  };
  visitViews(out, (index) => keptAccessors.has(index), (holder, key) => {
    if (holder !== undefined && typeof holder[key] === 'number') keptViews.add(holder[key]);
  });

  // 3. Repack the BIN from the kept views, in their original order, each 4-byte aligned.
  const viewOrder = [...keptViews].sort((a, b) => a - b);
  const viewIndex = new Map();
  const chunks = [];
  let offset = 0;
  const newViews = [];
  for (const oldIndex of viewOrder) {
    const view = out.bufferViews[oldIndex];
    if (view === undefined) throw new Error(`bufferView ${oldIndex} does not exist`);
    if ((view.buffer ?? 0) !== 0) throw new Error(`bufferView ${oldIndex} is not in the BIN chunk (buffer ${view.buffer})`);
    const start = view.byteOffset ?? 0;
    const bytes = bin.subarray(start, start + view.byteLength);
    if (bytes.length !== view.byteLength) throw new Error(`bufferView ${oldIndex} runs past the BIN chunk`);
    viewIndex.set(oldIndex, newViews.length);
    newViews.push({ ...view, buffer: 0, byteOffset: offset });
    chunks.push(bytes);
    offset += bytes.length;
    const pad = (4 - (offset % 4)) % 4;
    if (pad > 0) {
      chunks.push(Buffer.alloc(pad));
      offset += pad;
    }
  }
  const newBin = Buffer.concat(chunks, offset);

  // 4. Renumber accessors, then every reference to either table.
  const accessorOrder = [...keptAccessors].sort((a, b) => a - b);
  const accessorIndex = new Map(accessorOrder.map((oldIndex, newIndex) => [oldIndex, newIndex]));
  const newAccessors = accessorOrder.map((oldIndex) => structuredClone(out.accessors[oldIndex]));
  out.accessors = newAccessors;
  out.bufferViews = newViews;
  out.buffers = [{ byteLength: newBin.length }];
  visitViews(out, () => true, (holder, key) => {
    if (holder !== undefined && typeof holder[key] === 'number') {
      const mapped = viewIndex.get(holder[key]);
      if (mapped === undefined) throw new Error(`bufferView ${holder[key]} was referenced but not kept`);
      holder[key] = mapped;
    }
  });
  visitAccessors(out, (holder, key) => {
    if (typeof holder[key] === 'number') {
      const mapped = accessorIndex.get(holder[key]);
      if (mapped === undefined) throw new Error(`accessor ${holder[key]} was referenced but not kept`);
      holder[key] = mapped;
    }
  });

  return { json: out, bin: newBin };
}

/** A GLB from a JSON document and a BIN chunk, padded as the container format requires. */
export function encodeGlb(json, bin) {
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc(jsonPad, 0x20)]);
  const binPad = (4 - (bin.length % 4)) % 4;
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPad, 0)]);
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const header = Buffer.alloc(20);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  header.writeUInt32LE(jsonChunk.length, 12);
  header.writeUInt32LE(CHUNK_JSON, 16);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk.length, 0);
  binHeader.writeUInt32LE(CHUNK_BIN, 4);
  return Buffer.concat([header, jsonChunk, binHeader, binChunk], total);
}

// -- main -------------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { source: null, folder: null, clip: null, as: null, keep: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === '--clip') args.clip = Number(next());
    else if (arg === '--as') args.as = next();
    else if (arg === '--keep') args.keep = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: animation-import.mjs <file.glb> [<folder under animations>] [--clip <index>] [--as <Name>] [--keep] [--dry-run]');
      process.exit(0);
    } else if (args.source === null) args.source = arg;
    else if (args.folder === null) args.folder = arg;
    else throw new Error(`unexpected argument ${arg}`);
  }
  if (args.source === null) throw new Error('need a source file; --help');
  if (args.clip !== null && (!Number.isInteger(args.clip) || args.clip < 0)) throw new Error('--clip must be a non-negative integer');
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const animationsRoot = path.join(ROOT, ANIMATIONS_DIR);

  const under = path.join(animationsRoot, args.source);
  const source = existsSync(under) ? under : path.resolve(ROOT, args.source);
  if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`no such file: ${args.source}`);

  // No folder: the file is already where it belongs and is rewritten in place.
  const inPlace = args.folder === null;
  const folder = inPlace ? path.dirname(source) : path.join(animationsRoot, args.folder);
  const relFolder = path.relative(animationsRoot, folder).replace(/\\/g, '/');
  if (relFolder.startsWith('..') || relFolder === '' || relFolder === INCOMING_DIR || relFolder.startsWith(`${INCOMING_DIR}/`)) {
    throw new Error(
      inPlace
        ? `${args.source} is not in a slot folder; give it one to import it`
        : `destination must be a slot folder under ${ANIMATIONS_DIR}, not "${args.folder}"`,
    );
  }

  const name = args.as ?? path.basename(source, '.glb');
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`"${name}" is not a clip name: letters, digits and underscores only`);
  const destination = path.join(folder, `${name}.glb`);
  const replacing = path.resolve(destination) === path.resolve(source);
  if (existsSync(destination) && !replacing) throw new Error(`${path.relative(ROOT, destination)} already exists`);

  const { json, bin } = readGlb(source, { bin: true });
  if (bin === null) throw new Error(`${args.source} has no BIN chunk`);
  const clipCount = json.animations?.length ?? 0;
  if (clipCount === 0) throw new Error(`${args.source} contains no animations`);
  const clipIndex = args.clip ?? clipCount - 1;
  if (clipIndex >= clipCount) throw new Error(`--clip ${clipIndex} but the file has ${clipCount} clip(s)`);

  const before = readAnimationFile(source, skinBoneSet().perSkin);
  const chosen = before.clips[clipIndex];
  const rewritten = isolateClip(json, bin, clipIndex, name);
  const glb = encodeGlb(rewritten.json, rewritten.bin);

  console.log(
    `${path.relative(ROOT, source).replace(/\\/g, '/')} → ${replacing ? 'in place' : path.relative(ROOT, destination).replace(/\\/g, '/')}: ` +
      `clip ${clipIndex} of ${clipCount} ("${chosen.name}", ${chosen.duration.toFixed(3)} s, ${chosen.channels} tracks) as "${name}"; ` +
      `${(before.bytes / 1024).toFixed(0)} KiB → ${(glb.length / 1024).toFixed(0)} KiB` +
      (chosen.offSkin.length > 0 ? `; off-skin tracks kept: ${chosen.offSkin.map((o) => o.bone).join(', ')}` : ''),
  );
  if (args.dryRun) return;

  // Written beside the destination and read back the way the manifest will, so a malformed
  // write is caught here and not in a browser — and an in-place rewrite never half-replaces
  // its own source.
  mkdirSync(folder, { recursive: true });
  const staging = `${destination}.importing`;
  writeFileSync(staging, glb);
  const after = readAnimationFile(staging, skinBoneSet().perSkin);
  const only = after.clips[0];
  if (after.clips.length !== 1 || only.name !== name) {
    unlinkSync(staging);
    throw new Error(`the written file does not meet the contract (clips: ${after.clips.length}, name: "${only?.name}")`);
  }
  if (Math.abs(only.duration - chosen.duration) > 1e-6 || only.channels !== chosen.channels || only.targetBones !== chosen.targetBones) {
    unlinkSync(staging);
    throw new Error(`the written clip differs from the source (${only.duration} s / ${only.channels} tracks vs ${chosen.duration} s / ${chosen.channels})`);
  }
  renameSync(staging, destination);

  if (!args.keep && !replacing) unlinkSync(source);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
