
/**
 * Weapon camouflages (brief S6.5): six. The patterns themselves are generated in `client/meta/CamoTextures.ts`.
 *
 * Zero external assets (S2), so every one of these is drawn with 2D canvas calls from a
 * seeded `Rng` — which also means they are reproducible: the same camo is byte-identical
 * across reloads, and a pattern that looked wrong can be tuned by changing one number
 * rather than by re-exporting an image.
 *
 * They are *not* six recolourings of the same noise. Each generator is a different
 * construction, because the whole point of a camo unlock is that the reward is visibly a
 * different thing:
 *
 * | Camo     | Construction                                                  |
 * |----------|---------------------------------------------------------------|
 * | DIGITAL  | Aligned pixel grid, three-tone, blocks biased by a value field |
 * | SPLINTER | Straight-edged angular shards from a random half-plane cut     |
 * | TIGER    | Sinusoidally warped horizontal stripes with broken ends        |
 * | FRACTAL  | Summed octaves of value noise, posterised to four bands        |
 * | GOLD     | Vertical brushed metal with a specular sweep and an edge burn  |
 * | OBSIDIAN | Voronoi facets lit from one direction, over an ink base        |
 *
 * OBSIDIAN is S6.5's "one that requires the others" — its challenge is completing the
 * five camo challenges below it, so it cannot be reached any other way.
 */

export type CamoId = 'digital' | 'splinter' | 'tiger' | 'fractal' | 'gold' | 'obsidian';

export interface CamoDef {
  readonly id: CamoId;
  readonly name: string;
  /** How it is earned, in one line. The challenge itself lives in `Challenges.ts`. */
  readonly requirement: string;
  /** Drawn into the picker as a swatch, and the base tint of the pattern. */
  readonly swatch: string;
}

export const CAMOS: Readonly<Record<CamoId, CamoDef>> = {
  digital: {
    id: 'digital',
    name: 'DIGITAL',
    requirement: '25 kills with the weapon',
    swatch: '#5c6350',
  },
  splinter: {
    id: 'splinter',
    name: 'SPLINTER',
    requirement: '15 headshots with the weapon',
    swatch: '#6d6152',
  },
  tiger: {
    id: 'tiger',
    name: 'TIGER',
    requirement: '10 longshot kills with the weapon',
    swatch: '#7a6234',
  },
  fractal: {
    id: 'fractal',
    name: 'FRACTAL',
    requirement: '5 one-magazine multikills with the weapon',
    swatch: '#4d5560',
  },
  gold: {
    id: 'gold',
    name: 'GOLD',
    requirement: '100 kills with the weapon',
    swatch: '#c9a13c',
  },
  obsidian: {
    id: 'obsidian',
    name: 'OBSIDIAN',
    requirement: 'Earn every other camo',
    swatch: '#1b1d24',
  },
};

export const CAMO_IDS = Object.keys(CAMOS) as CamoId[];

/** The five OBSIDIAN is built on. Read by the challenge that awards it. */
export const CAMO_PREREQUISITES: readonly CamoId[] = ['digital', 'splinter', 'tiger', 'fractal', 'gold'];

export function camoDef(id: CamoId): CamoDef {
  return CAMOS[id];
}

export function isCamoId(value: string): value is CamoId {
  return Object.prototype.hasOwnProperty.call(CAMOS, value);
}


