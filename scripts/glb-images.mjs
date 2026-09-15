/**
 * What a GLB carries, read without a dependency (M15, B0).
 *
 * A `.glb` is a 12-byte header, a JSON chunk and a binary chunk; the images live in the binary
 * chunk as PNG or JPEG bytes that `bufferViews` point into. That is enough structure to answer
 * the two questions `check-skins.mjs` and `skin-compress.mjs` ask — how big is each texture,
 * and did the pass touch anything that was not a texture — with forty lines and no parser
 * package. `animation-manifest.mjs` reads the same JSON chunk for the clips; this file is the
 * image half, kept apart because the audits that use each are different audits.
 */
import { readFileSync } from 'node:fs';

/** The JSON chunk and the binary chunk of a GLB, as the spec lays them out. */
export function readGlb(file) {
  const buf = readFileSync(file);
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: not a GLB`);
  const jsonLength = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'));
  const bin = buf.subarray(20 + jsonLength + 8);
  return { json, bin, bytes: buf.length };
}

function pngSize(data) {
  if (data.length < 24 || data.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function jpegSize(data) {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < data.length) {
    if (data[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = data[i + 1];
    // SOFn frames carry the dimensions; C4, C8 and CC are not frames.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7) };
    }
    i += 2 + data.readUInt16BE(i + 2);
  }
  return null;
}

/** Every image in the file: its index, MIME type, byte size, pixel size and name. */
export function glbImages({ json, bin }) {
  return (json.images ?? []).map((image, index) => {
    const view = json.bufferViews[image.bufferView];
    const start = view.byteOffset ?? 0;
    const data = bin.subarray(start, start + view.byteLength);
    const size = pngSize(data) ?? jpegSize(data);
    return {
      index,
      mimeType: image.mimeType ?? '?',
      bytes: view.byteLength,
      width: size?.width ?? 0,
      height: size?.height ?? 0,
      name: image.name ?? '',
    };
  });
}

/**
 * The parts of a skin a texture pass must not change, as one string: node names in order,
 * every skin's joint count, and every animation's name and channel count. Two files with the
 * same signature are the same rig wearing different pixels.
 */
export function rigSignature({ json }) {
  const nodes = (json.nodes ?? []).map((n) => n.name ?? '').join('|');
  const joints = (json.skins ?? []).map((s) => s.joints.length).join(',');
  const animations = (json.animations ?? []).map((a) => `${a.name ?? ''}:${a.channels.length}`).join(',');
  return `${nodes}#${joints}#${animations}`;
}
