import {
  bodyBoxes,
  bodyTubes,
  chargingBoxes,
  magazineBoxes,
  magazineTubes,
  type BoxPart,
  type TubePart,
} from './WeaponMeshParts';
import { modelSpecFor } from './WeaponModelSpecs';

/**
 * A weapon's side profile, as SVG path data, from the model it is a profile of.
 *
 * ## Why this exists (playtest round 4, F15)
 *
 * F15 asked for the loadout picker to show the weapon, and the instruction attached to it was
 * *one source for what a weapon looks like* — with `WeaponIcons.ts` named as the second source
 * that can drift. It was: one hand-drawn `AR` outline, forty-eight coordinates typed out in
 * M4, standing in for a *class* rather than a weapon. Eleven of the twelve shipped weapons had
 * no icon at all and the killfeed printed their names instead.
 *
 * The editor's preview solved its half by building the real model (`WeaponPreview`). This is
 * the other half: the killfeed's glyph is now **projected from the same `WeaponModelSpec`**
 * the viewmodel is built from, so a barrel that gets longer gets longer in the feed too, and
 * there is no second description of a rifle anywhere in the client. Twelve weapons have
 * twelve silhouettes because twelve specs exist, not because somebody drew twelve outlines.
 *
 * ## The projection
 *
 * Orthographic, straight down +X, which is the view the specs were authored to read at: the
 * file comment on `WeaponModelSpecs` says the numbers are chosen so *"the LMG reads as heavier
 * than the SMG at a glance"*, and a glance is a side view. Model space is +X right, +Y up and
 * **-Z forward**, so the barrel points down -Z and the screen axes are `x = -z`, `y = -y`.
 *
 * Every part becomes one axis-aligned quad, and the union of the quads is the outline — SVG's
 * non-zero fill rule makes overlapping subpaths one solid shape at no cost. `rx` is honoured
 * because it rotates in exactly the plane being drawn (the grip's rake, the stock's drop, the
 * magazine's curve are all `rx`); `ry` and `rz` are ignored, because they turn a part out of
 * this plane and an ejection-port sliver seen edge-on is not part of a 16-pixel silhouette.
 *
 * `lens` and `reticle` are skipped: the glass and the dot are what you see *through*, and a
 * filled red-dot window would close the aperture that M7 opened.
 */

/** The viewBox `WeaponIcons` publishes, and what the killfeed's CSS sizes against. */
const VIEW_W = 48;
const VIEW_H = 16;
/** Kept clear on every side, so a muzzle brake does not touch the edge of the box. */
const MARGIN = 0.5;

/** One projected quad, in model units, before it is fitted to the viewBox. */
interface Quad {
  readonly points: readonly [number, number][];
}

const cache = new Map<string, string>();

/**
 * SVG path data for a weapon's outline, in a 48 x 16 viewBox with the barrel pointing right.
 *
 * Memoised per weapon: the shape is a pure function of a frozen spec, and the killfeed asks
 * for one every time a weapon appears in it.
 */
export function weaponSilhouettePath(weaponId: string): string {
  const cached = cache.get(weaponId);
  if (cached !== undefined) return cached;
  const built = build(weaponId);
  cache.set(weaponId, built);
  return built;
}

function build(weaponId: string): string {
  const spec = modelSpecFor(weaponId);
  const quads: Quad[] = [];
  for (const box of [...bodyBoxes(spec), ...magazineBoxes(spec), ...chargingBoxes(spec)]) {
    const quad = boxQuad(box);
    if (quad !== null) quads.push(quad);
  }
  for (const tube of [...bodyTubes(spec), ...magazineTubes(spec)]) {
    const quad = tubeQuad(tube);
    if (quad !== null) quads.push(quad);
  }
  if (quads.length === 0) {
    throw new Error(`Weapon "${weaponId}" projected to no geometry; its spec builds nothing.`);
  }
  return fit(quads);
}

/** Skip the parts that are apertures rather than material. See the file comment. */
function drawable(surface: BoxPart['surface']): boolean {
  return surface !== 'lens' && surface !== 'reticle';
}

function boxQuad(part: BoxPart): Quad | null {
  if (!drawable(part.surface)) return null;
  const halfD = part.d * 0.5;
  const halfH = part.h * 0.5;
  const rx = part.rx ?? 0;
  const cos = Math.cos(rx);
  const sin = Math.sin(rx);
  const points: [number, number][] = [];
  for (const [dz, dy] of [
    [-halfD, -halfH],
    [halfD, -halfH],
    [halfD, halfH],
    [-halfD, halfH],
  ] as const) {
    // `rotation.x` in three's convention: y' = y cos - z sin, z' = y sin + z cos.
    const y = part.y + (dy * cos - dz * sin);
    const z = part.z + (dy * sin + dz * cos);
    points.push([-z, -y]);
  }
  return { points };
}

function tubeQuad(part: TubePart): Quad | null {
  if (!drawable(part.surface)) return null;
  const alongY = part.vertical === true;
  const halfZ = alongY ? part.radius : part.length * 0.5;
  const halfY = alongY ? part.length * 0.5 : part.radius;
  const points: [number, number][] = [
    [-(part.z - halfZ), -(part.y - halfY)],
    [-(part.z + halfZ), -(part.y - halfY)],
    [-(part.z + halfZ), -(part.y + halfY)],
    [-(part.z - halfZ), -(part.y + halfY)],
  ];
  return { points };
}

/**
 * Scale the projected quads into the viewBox, preserving aspect and centring what is left.
 *
 * Uniform scale, deliberately: stretching a pistol to fill a 3:1 box would make it read as a
 * carbine, and the whole reason the killfeed carries a silhouette rather than a label is that
 * the shape is meant to be recognisable at a glance.
 */
function fit(quads: readonly Quad[]): string {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const quad of quads) {
    for (const [x, y] of quad.points) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const scale = Math.min((VIEW_W - MARGIN * 2) / spanX, (VIEW_H - MARGIN * 2) / spanY);
  const offsetX = (VIEW_W - spanX * scale) * 0.5 - minX * scale;
  const offsetY = (VIEW_H - spanY * scale) * 0.5 - minY * scale;

  const parts: string[] = [];
  for (const quad of quads) {
    const coords = quad.points.map(([x, y]) => {
      const px = (x * scale + offsetX).toFixed(2);
      const py = (y * scale + offsetY).toFixed(2);
      return `${px} ${py}`;
    });
    parts.push(`M${coords.join(' L')} Z`);
  }
  return parts.join('');
}
