import { MATERIAL_KEYS, type MaterialKey } from './types';

/**
 * The base colour of every map material, in one place (playtest round 4, F9).
 *
 * ## Why this is not in `ProceduralTextures`, where it used to live
 *
 * "The third map is very dark" has now been reported three times. Post-M8 raised Depot's
 * hemisphere intensity; round 2 found that intensity was the wrong lever and re-derived the
 * hemisphere *colours* in linear space, which was correct arithmetic and moved the picture
 * far less than it should have. Both passes edited `depot.ts`, because that is the file with
 * the word `lights` in it.
 *
 * The number that dominates both of them was in a painter in `client/engine`: Depot's yard is
 * one `asphalt` span from wall to wall, and `asphalt`'s base colour is a **linear luminance of
 * 0.019** against Foundry's floor at 0.101 — a surface that returns two per cent of what falls
 * on it. Multiplying the light by 1.5 multiplies two per cent by 1.5. That is why each fix
 * looked partial, and why the third report says the same thing as the first.
 *
 * So the base colours live here, in `shared/`, where the same process that runs the simulation
 * can read them and answer *"how bright is this map, in numbers"* without a browser. The
 * painters in `ProceduralTextures` take their fill from this table; the grain, aggregate,
 * cracks and paint they lay over it stay where they are, because those are texture rather than
 * albedo. It is the same reasoning that put `HudSurfaces` and `pickSpectatorTarget` in
 * `shared/`: the half that can be wrong invisibly belongs where it can be measured.
 *
 * ## What a number here means
 *
 * An sRGB hex, the way it would be authored in an image editor — which is exactly the trap.
 * `0x24262b` reads as "dark asphalt" in a swatch and is 0.019 in the linear space the renderer
 * multiplies in. `MapLuminance.linearLuminance` is the function that says so, and F9's whole
 * finding is the gap between those two readings.
 */
export const MATERIAL_BASE_COLOR: Readonly<Record<MaterialKey, number>> = {
  concrete: 0x6a6f78,
  concreteDark: 0x3d424b,
  floor: 0x555a63,
  metal: 0x4c515a,
  hazard: 0x14171c,
  accent: 0x14171c,
  rubber: 0x24272d,
  brick: 0x4a3a34,
  rust: 0x6d4a35,
  grate: 0x101317,

  // -- M8 --------------------------------------------------------------------
  sand: 0xbfa274,
  plaster: 0xc4ab86,
  clayTile: 0x8f5236,
  wood: 0x6d5334,

  /**
   * Depot's yard, raised at round 4 (F9), and the one entry with an argument attached.
   *
   * It was `0x24262b` — linear 0.019 — with a comment saying that was deliberate, because "a
   * ground that reflects much of anything flattens the pools into a uniform grey". The premise
   * is wrong, and it is worth saying why rather than just changing the number: **albedo is a
   * multiplier, so it cannot change the ratio between a mast pool and the gap between two of
   * them.** `readability` measures that ratio across the whole playable grid at **2.60x**, and
   * it is 2.60x on both sides of this change by construction. What flattens pools is *fill* —
   * the hemisphere term, which is added rather than multiplied — and the fill is the one thing
   * the previous two passes did raise.
   *
   * So the pools survive and the yard between them comes up with everything else. The value is
   * chosen in linear space rather than picked in a swatch, and measured rather than judged:
   * the yard goes from a mean of **4.4 / 255 to 21.3 / 255** against Foundry's floor at 61.7.
   * Depot stays by a wide margin the darkest map in the game, which is what a night map is
   * for; it stops being one where the ground is three counts off black.
   */
  asphalt: 0x474b53,

  paintedSteel: 0x2f4a4f,
};

/**
 * Every material has a base colour.
 *
 * `MaterialKey` already forces the record above to be exhaustive at compile time, so this is
 * not a type check — it is the guard for the case the type cannot see: a key added to
 * `MATERIAL_KEYS` and to this table, and the table then read through an index that returns
 * `undefined` at runtime under `noUncheckedIndexedAccess`. Throwing beats the `?? 0x000000`
 * that would otherwise be written here, for the reason `equipmentUnlockLevel` throws: a
 * default on a lookup table turns a missing row into a silently wrong picture.
 */
export function materialBaseColor(key: MaterialKey): number {
  const colour = MATERIAL_BASE_COLOR[key];
  if (colour === undefined) throw new Error(`material "${key}" has no base colour`);
  return colour;
}

/** For probes that want to walk the whole table. Ordered as `MATERIAL_KEYS` is. */
export function allMaterialBaseColors(): ReadonlyArray<readonly [MaterialKey, number]> {
  return MATERIAL_KEYS.map((key) => [key, materialBaseColor(key)] as const);
}
