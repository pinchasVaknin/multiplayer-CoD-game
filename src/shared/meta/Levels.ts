/**
 * The level curve (brief S6.1), authored as a table.
 *
 * S6.1 is explicit that this must be data and not "a formula buried in logic", and the
 * reason is pacing: the only way to answer "does level 12 arrive too late" is to look at
 * the row for level 12 and change it. `LEVEL_XP[n]` is the XP required to go from level
 * `n + 1` to level `n + 2`, so the array has 54 entries for 55 levels.
 *
 * The shape is deliberately front-loaded. The first ten levels cost 18,600 XP between
 * them — about six matches — because every weapon with an `unlockLevel` under 12 needs to
 * arrive while the player is still deciding whether to keep playing. From level 11 the
 * steps settle into a steady climb, and the last stretch to 55 is the wall prestige
 * exists to make meaningful.
 *
 * Every number here is reachable from the XP simulator in the F1 panel
 * (`__operator.simulateXp(n)`), which fast-forwards N matches of average performance and
 * reports where the curve puts you — S7's requirement, and the thing that makes this
 * table tunable without playing 55 levels.
 */

export const MAX_LEVEL = 55;

/**
 * XP from level n+1 to level n+2, in order. 54 rows.
 *
 * Rows 1-10 are hand-authored for the opening. Rows 11 onward step by a constant 500,
 * which is a deliberate choice rather than an accident of generation: a curve that
 * accelerates all the way to 55 makes the last ten levels take longer than the first
 * forty-five, and the simulator made that obvious the first time it was run.
 */
export const LEVEL_XP: readonly number[] = [
  // 1 -> 11: the opening. Six matches to level 10.
  500, 700, 900, 1200, 1500, 1900, 2300, 2700, 3200, 3700,
  // 11 -> 21
  4200, 4700, 5200, 5700, 6200, 6700, 7200, 7700, 8200, 8700,
  // 21 -> 31
  9200, 9700, 10200, 10700, 11200, 11700, 12200, 12700, 13200, 13700,
  // 31 -> 41
  14200, 14700, 15200, 15700, 16200, 16700, 17200, 17700, 18200, 18700,
  // 41 -> 51
  19200, 19700, 20200, 20700, 21200, 21700, 22200, 22700, 23200, 23700,
  // 51 -> 55
  24200, 24700, 25200, 25700,
];

/** Cumulative XP at the start of each level. `LEVEL_START[0]` is level 1, always 0. */
const LEVEL_START: readonly number[] = buildCumulative();

function buildCumulative(): number[] {
  const out: number[] = [0];
  let total = 0;
  for (const step of LEVEL_XP) {
    total += step;
    out.push(total);
  }
  return out;
}

/** Total XP needed to reach `MAX_LEVEL`. 676,400 on the shipped table. */
export const XP_TO_MAX = LEVEL_START[LEVEL_START.length - 1] ?? 0;

/** XP required to advance out of `level`. Zero at the cap. */
export function xpForLevel(level: number): number {
  if (level >= MAX_LEVEL) return 0;
  return LEVEL_XP[Math.max(0, level - 1)] ?? 0;
}

/** Cumulative XP at which `level` begins. */
export function xpAtLevelStart(level: number): number {
  const index = Math.min(Math.max(level, 1), MAX_LEVEL) - 1;
  return LEVEL_START[index] ?? 0;
}

/**
 * The level a lifetime XP total puts you at, 1..55.
 *
 * Linear scan over 55 entries. It is called on a level-up and by the summary screen, not
 * in the sim path, and a binary search over a fifty-five element array would be less
 * readable for no measurable gain.
 */
export function levelForXp(totalXp: number): number {
  const xp = Math.max(0, totalXp);
  for (let level = MAX_LEVEL; level >= 1; level--) {
    if (xp >= xpAtLevelStart(level)) return level;
  }
  return 1;
}

/** How far into the current level a total sits, and how far it has to go. */
export interface LevelProgress {
  readonly level: number;
  /** XP earned since this level began. */
  readonly into: number;
  /** XP this level costs in total. Zero at the cap. */
  readonly span: number;
  /** 0..1 through the level. 1 at the cap. */
  readonly fraction: number;
  readonly atCap: boolean;
}

export function levelProgress(totalXp: number): LevelProgress {
  const level = levelForXp(totalXp);
  const start = xpAtLevelStart(level);
  const span = xpForLevel(level);
  const into = Math.max(0, totalXp - start);
  const atCap = level >= MAX_LEVEL;
  return {
    level,
    into,
    span,
    fraction: atCap ? 1 : span > 0 ? Math.min(1, into / span) : 0,
    atCap,
  };
}

// -- prestige -----------------------------------------------------------------

/**
 * Prestige (S6.1): at 55 the level and the unlocks reset, the icon persists, and one
 * permanent unlock token is granted.
 *
 * A token permanently unlocks a single item *across resets* — which is what makes it a
 * choice worth thinking about rather than a currency. `PRESTIGE_MAX` is a bound rather
 * than a design statement: ten is where the icon vocabulary in `PrestigeIcons` runs out,
 * and nothing in the save schema cares.
 */
export const PRESTIGE_MAX = 10;

/** Tokens granted per prestige. One, deliberately. */
export const TOKENS_PER_PRESTIGE = 1;

/** Whether a profile at this level and prestige may prestige right now. */
export function canPrestige(level: number, prestige: number): boolean {
  return level >= MAX_LEVEL && prestige < PRESTIGE_MAX;
}

/**
 * The prestige badge, as a short label.
 *
 * Roman numerals rather than generated art: the icon has to read at 11 px in a scoreboard
 * row next to a name, and a procedural emblem at that size is a smudge.
 */
const PRESTIGE_LABELS: readonly string[] = [
  '',
  'I',
  'II',
  'III',
  'IV',
  'V',
  'VI',
  'VII',
  'VIII',
  'IX',
  'X',
];

export function prestigeLabel(prestige: number): string {
  return PRESTIGE_LABELS[Math.max(0, Math.min(PRESTIGE_MAX, prestige))] ?? '';
}
