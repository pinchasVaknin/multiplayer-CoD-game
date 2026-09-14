#!/usr/bin/env node
/**
 * M13 Phase D — what is actually inside an animation GLB, read in Node without three.
 *
 * A file dropped into `public/models/bots/animations/incoming/` is named by whoever exported
 * it, and the name is a claim: `Crouch_Idle_Aiming_Pistol.glb` says crouch, idle, pistol, and
 * nothing about whether it is one clip or nine, which skeleton it was exported on, or how deep
 * the crouch is. C1 found all three the hard way: every shipped file carries its whole Mixamo
 * session as cumulative `mixamo.com.NNN` clips of which only the last is the one wanted; the
 * `incoming/` files are on a 69-bone skeleton with a `mixamorigNeck1` the skins lack, so the
 * head lands 3–4 cm lower than authored; and there are two crouch depths in the folder, a
 * kneel and a half-squat, 15 cm apart at the crown. The catalogue's slots are decided from
 * this table, not from the file names.
 *
 * It reads the GLB directly — the 12-byte header, the JSON chunk, and the one BIN chunk —
 * because everything it reports is in the JSON: clip names, channels and their target nodes,
 * and the duration as the sampler input accessor's `max` (which the glTF spec requires an
 * animation input accessor to declare). The one thing it decodes from the BIN chunk is the
 * motion bone's translation track, so a crouch depth is a number here and not a re-run of
 * `measure-crouch.mjs`: the hips' world height through the clip, on the file's own skeleton,
 * in the file's own metres. (`measure-crouch.mjs` plays the clip on a real skin through the
 * real import path and reads the crown; it is the instrument for a layout decision. This one
 * is for sorting a folder.)
 *
 * Node names are sanitised the way three's `GLTFLoader` sanitises them — `mixamorig:Hips`
 * becomes `mixamorigHips` — so the bone names here are the ones the catalogue and the rig
 * profiles use, and a track that targets a bone no skin has is reported by that name.
 *
 *   node scripts/animation-manifest.mjs                     # the whole animations tree
 *   node scripts/animation-manifest.mjs incoming            # one folder under it
 *   node scripts/animation-manifest.mjs path/to/file.glb    # one file
 *   node scripts/animation-manifest.mjs --json              # for another script
 *
 * `check-animations.mjs` and `animation-import.mjs` import `readAnimationFile` from here rather
 * than carrying a second GLB reader.
 */

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ANIMATIONS_DIR = 'public/models/bots/animations';
export const SKINS_DIR = 'public/models/bots/skins';
/** Dropped here, never loaded; the manifest is how a file leaves it. */
export const INCOMING_DIR = 'incoming';
/** The bone the catalogue locks planar root motion on; its height is the crouch depth. */
const MOTION_BONE = 'mixamorigHips';

// -- GLB ------------------------------------------------------------------------

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/**
 * The JSON chunk, and the BIN chunk on request. A skin is 30 MiB of textures behind a
 * few kilobytes of JSON, so the JSON is read through a descriptor rather than by slurping the
 * file; an animation file is small enough that its BIN is read whole when a track is wanted.
 */
export function readGlb(file, { bin = false } = {}) {
  const fd = openSync(file, 'r');
  try {
    const header = Buffer.alloc(20);
    if (readSync(fd, header, 0, 20, 0) !== 20) throw new Error(`${file}: not a GLB (too short)`);
    if (header.readUInt32LE(0) !== GLB_MAGIC) throw new Error(`${file}: not a GLB (bad magic)`);
    const version = header.readUInt32LE(4);
    if (version !== 2) throw new Error(`${file}: GLB version ${version}, expected 2`);
    const jsonLength = header.readUInt32LE(12);
    if (header.readUInt32LE(16) !== CHUNK_JSON) throw new Error(`${file}: first chunk is not JSON`);
    const jsonBytes = Buffer.alloc(jsonLength);
    if (readSync(fd, jsonBytes, 0, jsonLength, 20) !== jsonLength) throw new Error(`${file}: truncated JSON chunk`);
    const json = JSON.parse(jsonBytes.toString('utf8'));
    if (!bin) return { json, bin: null };

    const binHeaderOffset = 20 + jsonLength;
    const binHeader = Buffer.alloc(8);
    if (readSync(fd, binHeader, 0, 8, binHeaderOffset) !== 8) return { json, bin: null };
    if (binHeader.readUInt32LE(4) !== CHUNK_BIN) throw new Error(`${file}: second chunk is not BIN`);
    const binLength = binHeader.readUInt32LE(0);
    const binBytes = Buffer.alloc(binLength);
    if (readSync(fd, binBytes, 0, binLength, binHeaderOffset + 8) !== binLength) throw new Error(`${file}: truncated BIN chunk`);
    return { json, bin: binBytes };
  } finally {
    closeSync(fd);
  }
}

/** three's `PropertyBinding.sanitizeNodeName`: spaces to underscores, `[ ] . : /` dropped. */
export function sanitizeNodeName(name) {
  return name.replace(/\s/g, '_').replace(/[[\].:/]/g, '');
}

/** A Vector3 or scalar float accessor out of the BIN chunk, as an array of arrays. */
function readFloatAccessor(json, bin, accessorIndex) {
  const accessor = json.accessors[accessorIndex];
  if (accessor === undefined) throw new Error(`accessor ${accessorIndex} does not exist`);
  if (accessor.componentType !== 5126) throw new Error(`accessor ${accessorIndex} is not float32`);
  const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[accessor.type];
  if (size === undefined) throw new Error(`accessor ${accessorIndex} has type ${accessor.type}`);
  const view = json.bufferViews[accessor.bufferView];
  if (view === undefined) throw new Error(`accessor ${accessorIndex} has no bufferView`);
  const stride = view.byteStride ?? size * 4;
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const out = [];
  for (let i = 0; i < accessor.count; i++) {
    const at = base + i * stride;
    const v = [];
    for (let c = 0; c < size; c++) v.push(bin.readFloatLE(at + c * 4));
    out.push(v);
  }
  return out;
}

// -- the skeleton in a file ------------------------------------------------------

/** Every node that is a joint of a skin, by sanitised name; falls back to every named node. */
function jointNames(json) {
  const names = new Set();
  const joints = (json.skins ?? []).flatMap((skin) => skin.joints ?? []);
  const indices = joints.length > 0 ? joints : json.nodes.map((_, i) => i);
  for (const index of indices) {
    const node = json.nodes[index];
    if (node?.name !== undefined) names.add(sanitizeNodeName(node.name));
  }
  return names;
}

/** Parent index per node, so a bone's world transform can be composed up the chain. */
function parentTable(json) {
  const parent = new Array(json.nodes.length).fill(-1);
  json.nodes.forEach((node, index) => {
    for (const child of node.children ?? []) parent[child] = index;
  });
  return parent;
}

function rotate(q, v) {
  // v' = q v q*, with q = (x, y, z, w).
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  const ix = qw * vx + qy * vz - qz * vy;
  const iy = qw * vy + qz * vx - qx * vz;
  const iz = qw * vz + qx * vy - qy * vx;
  const iw = -qx * vx - qy * vy - qz * vz;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
}

/**
 * A local point in `node` taken to world space through the node's ancestors, each applied as
 * translation ∘ rotation ∘ scale. The armature node above a Mixamo skeleton carries the
 * −90° X rotation and the 0.01 scale that turn centimetre-scale bone space into Y-up metres.
 */
function toWorld(json, parent, node, local) {
  let p = local;
  for (let at = parent[node]; at !== -1; at = parent[at]) {
    const n = json.nodes[at];
    const s = n.scale ?? [1, 1, 1];
    const r = n.rotation ?? [0, 0, 0, 1];
    const t = n.translation ?? [0, 0, 0];
    const scaled = [p[0] * s[0], p[1] * s[1], p[2] * s[2]];
    const rotated = rotate(r, scaled);
    p = [rotated[0] + t[0], rotated[1] + t[1], rotated[2] + t[2]];
  }
  return p;
}

// -- one file ------------------------------------------------------------------------

/**
 * Everything the catalogue could want to know about one animation GLB.
 *
 * `skins` is `skinBoneSet().perSkin`: the bone names each skin actually has. A track that
 * targets a bone some skin lacks is one `importClip` passes through to a bind warning on that
 * skin, and the pose it carried is lost there — which is how C1's `Neck1` cost the head 3–4 cm
 * on six of the seven skins.
 */
export function readAnimationFile(file, skins = new Map()) {
  const { json, bin } = readGlb(file, { bin: true });
  const parent = parentTable(json);
  const bones = jointNames(json);
  const nodeName = (index) => sanitizeNodeName(json.nodes[index]?.name ?? `node${index}`);
  const motionNode = json.nodes.findIndex((n) => sanitizeNodeName(n.name ?? '') === MOTION_BONE);

  const clips = (json.animations ?? []).map((animation, index) => {
    let duration = 0;
    const targets = new Map();
    const paths = new Set();
    let motionSampler = null;
    for (const channel of animation.channels) {
      const sampler = animation.samplers[channel.sampler];
      const input = json.accessors[sampler.input];
      const max = input?.max?.[0];
      if (typeof max === 'number') duration = Math.max(duration, max);
      const name = nodeName(channel.target.node);
      targets.set(name, (targets.get(name) ?? 0) + 1);
      paths.add(channel.target.path);
      if (channel.target.node === motionNode && channel.target.path === 'translation') motionSampler = sampler;
    }

    // The motion bone's height through the clip, on this file's own skeleton, in its metres.
    let hips = null;
    if (motionSampler !== null && bin !== null && motionNode !== -1) {
      const times = readFloatAccessor(json, bin, motionSampler.input).map((t) => t[0]);
      const values = readFloatAccessor(json, bin, motionSampler.output);
      const heights = [];
      let planar = 0;
      const first = values[0] === undefined ? null : toWorld(json, parent, motionNode, values[0]);
      for (const v of values) {
        const w = toWorld(json, parent, motionNode, v);
        heights.push(w[1]);
        if (first !== null) planar = Math.max(planar, Math.hypot(w[0] - first[0], w[2] - first[2]));
      }
      const sum = heights.reduce((a, b) => a + b, 0);
      hips = {
        keys: times.length,
        first: heights[0],
        last: heights[heights.length - 1],
        min: Math.min(...heights),
        max: Math.max(...heights),
        mean: sum / heights.length,
        /** Largest planar excursion of the hips from their first key: root motion, if any. */
        planarTravel: planar,
      };
    }

    const offSkin = lackedBy([...targets.keys()], skins);
    return {
      index,
      name: animation.name ?? '',
      duration,
      channels: animation.channels.length,
      targetBones: targets.size,
      paths: [...paths].sort(),
      offSkin,
      hips,
    };
  });

  return {
    file,
    bytes: statSync(file).size,
    generator: json.asset?.generator ?? '',
    bones: bones.size,
    hasMeshes: (json.meshes ?? []).length > 0,
    /** Bones this file's skeleton has that one or more skins do not. */
    skinLacks: lackedBy([...bones], skins),
    clips,
    /**
     * The export contract: one clip, named after the file. Anything else is a Mixamo session
     * export and needs the legacy "last clip" rule or a pass through `animation-import.mjs`.
     */
    contract: clips.length === 1 && clips[0].name === path.basename(file, '.glb'),
  };
}

/**
 * Of `names`, the ones at least one skin lacks, each with the skins that lack it. Sorted by how
 * many skins lack the bone, most first, so a bone no skin has heads the list.
 */
function lackedBy(names, skins) {
  const out = [];
  for (const bone of names) {
    const lacking = [...skins].filter(([, set]) => !set.has(bone)).map(([id]) => id);
    if (lacking.length > 0) out.push({ bone, lacking });
  }
  return out.sort((a, b) => b.lacking.length - a.lacking.length || a.bone.localeCompare(b.bone));
}

/** The joints of every skin in `dir`, per skin — what a clip's tracks can bind to. */
export function skinBoneSet(dir = path.join(ROOT, SKINS_DIR)) {
  const perSkin = new Map();
  for (const name of readdirSync(dir).sort()) {
    if (!name.toLowerCase().endsWith('.glb')) continue;
    perSkin.set(path.basename(name, '.glb'), jointNames(readGlb(path.join(dir, name)).json));
  }
  return { perSkin };
}

/** Every `.glb` under `dir`, recursively, sorted, as paths relative to `dir`. */
export function listGlbFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(childAbs, childRel);
      else if (entry.name.toLowerCase().endsWith('.glb')) out.push(childRel);
    }
  };
  walk(dir, '');
  return out;
}

// -- the report ----------------------------------------------------------------------

function fmt(v, digits = 3) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—';
}

function short(bone) {
  return bone.startsWith('mixamorig') ? bone.slice('mixamorig'.length) : `\`${bone}\``;
}

/** `Neck1 (6/7)`: the bone, and how many of the skins lack it. */
function lacked(list, skinCount) {
  return list.map((entry) => `${short(entry.bone)} (${entry.lacking.length}/${skinCount})`).join(', ');
}

function printReport(entries, skins) {
  const line = (s = '') => console.log(s);
  const skinCount = skins.perSkin.size;
  const skinList = [...skins.perSkin.entries()].map(([id, set]) => `${id} (${set.size})`).join(', ');
  line('# Animation manifest (M13 Phase D)');
  line();
  line(`- ${entries.length} file(s) under \`${ANIMATIONS_DIR}\`; skins and their bone counts: ${skinList}.`);
  line('- Duration is the largest sampler input `max` in the clip. Hips is the motion bone\'s world height on the file\'s own skeleton, in the file\'s metres (no skin, no `modelScale`): first → last for a one-shot, min / **mean** / max for a loop. Travel is the hips\' largest planar excursion, which is 0 for an in-place clip.');
  line('- **Last** is the clip the legacy `last` selector takes; a file that meets the export contract has exactly one clip, named after the file.');
  line();
  line('- "Off-skin" is a bone the clip animates that some skins do not have, with how many of the skins lack it: the track binds to nothing there and the pose it carried is lost on that skin.');
  line();
  line('| File | KiB | Bones | Clips | Last clip | Length | Tracks | Off-skin tracks | Hips first → last | Hips min / mean / max | Travel |');
  line('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const entry of entries) {
    const last = entry.clips.at(-1);
    const hips = last?.hips ?? null;
    const contract = entry.contract ? ' ✓' : '';
    line(
      `| \`${entry.rel}\` | ${(entry.bytes / 1024).toFixed(0)} | ${entry.bones} | ${entry.clips.length}${contract} | ${last === undefined ? '—' : `\`${last.name}\``} | ${last === undefined ? '—' : `${fmt(last.duration, 3)} s`} | ${last === undefined ? '—' : `${last.channels} on ${last.targetBones} (${last.paths.map((p) => p[0].toUpperCase()).join('')})`} | ${last === undefined || last.offSkin.length === 0 ? 'none' : lacked(last.offSkin, skinCount)} | ${hips === null ? '—' : `${fmt(hips.first)} → ${fmt(hips.last)}`} | ${hips === null ? '—' : `${fmt(hips.min)} / **${fmt(hips.mean)}** / ${fmt(hips.max)}`} | ${hips === null ? '—' : fmt(hips.planarTravel, 3)} |`,
    );
  }
  line();

  const cumulative = entries.filter((e) => e.clips.length > 1);
  if (cumulative.length > 0) {
    line('## Every clip in the cumulative files');
    line();
    line('A Mixamo session export: each clip is one animation of the session and only the last is the one the file is named for. The others are what the legacy selector skips and what `animation-import.mjs` drops.');
    line();
    line('| File | # | Clip | Length | Hips mean |');
    line('|---|---|---|---|---|');
    for (const entry of cumulative) {
      for (const clip of entry.clips) {
        line(`| \`${entry.rel}\` | ${clip.index} | \`${clip.name}\` | ${fmt(clip.duration, 3)} s | ${clip.hips === null ? '—' : fmt(clip.hips.mean)} |`);
      }
    }
    line();
  }

  const offSkinFiles = entries.filter((e) => e.skinLacks.length > 0);
  if (offSkinFiles.length > 0) {
    line('## Export skeletons the skins do not match');
    line();
    line("Bones in the file's skeleton that some skins lack, whether or not the last clip animates them. A skin that lacks a bone drops its track on import (`importClip` reports it as a bind warning).");
    line();
    line('| File | Bones | Skins lacking a bone |');
    line('|---|---|---|');
    for (const entry of offSkinFiles) {
      line(`| \`${entry.rel}\` | ${entry.bones} | ${lacked(entry.skinLacks, skinCount)} |`);
    }
    line();
  }

  const legacy = entries.filter((e) => !e.contract);
  line(`${entries.length - legacy.length} file(s) meet the export contract; ${legacy.length} need the legacy selector or an import.`);
}

// -- main -------------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { targets: [], json: false };
  for (const arg of argv) {
    if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: animation-manifest.mjs [--json] [<folder under animations> | <file.glb>]...');
      process.exit(0);
    } else args.targets.push(arg);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const animationsRoot = path.join(ROOT, ANIMATIONS_DIR);
  const skins = skinBoneSet();

  const files = [];
  if (args.targets.length === 0) {
    for (const rel of listGlbFiles(animationsRoot)) files.push({ rel, abs: path.join(animationsRoot, rel) });
  } else {
    for (const target of args.targets) {
      const under = path.join(animationsRoot, target);
      const abs = existsSync(under) ? under : path.resolve(ROOT, target);
      if (!existsSync(abs)) throw new Error(`no such file or folder: ${target}`);
      if (statSync(abs).isDirectory()) {
        for (const rel of listGlbFiles(abs)) files.push({ rel: path.relative(animationsRoot, path.join(abs, rel)).replace(/\\/g, '/'), abs: path.join(abs, rel) });
      } else {
        files.push({ rel: path.relative(animationsRoot, abs).replace(/\\/g, '/'), abs });
      }
    }
  }

  const entries = files.map(({ rel, abs }) => ({ rel, ...readAnimationFile(abs, skins.perSkin) }));
  if (args.json) {
    console.log(JSON.stringify({ skins: Object.fromEntries([...skins.perSkin].map(([k, v]) => [k, [...v]])), files: entries }, null, 2));
    return;
  }
  printReport(entries, skins);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
}
