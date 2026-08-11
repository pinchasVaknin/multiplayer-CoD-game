/**
 * The six killstreaks, as data (brief S6.1).
 *
 * Every number that decides how a streak *feels* is here rather than inside the class that
 * implements it, which is S3's rule and is what lets the debug panel slider them without the
 * streak knowing it is being tuned.
 *
 * `requirement` is the raw consecutive-kill count. It is never read directly by gameplay —
 * `StreakSystem.requirementFor` applies Hardline's discount first, and the HUD is told the
 * *effective* number so it never has to know a perk exists.
 */

export type StreakId = 'uav' | 'counter_uav' | 'care_package' | 'mortar' | 'sentry' | 'chopper';

export interface StreakDef {
  readonly id: StreakId;
  readonly name: string;
  /** Consecutive kills, before Hardline. */
  readonly requirement: number;
  /**
   * How long the streak lasts once activated, seconds. Zero for one-shot streaks that finish
   * their own work (the care package drop, the mortar barrage).
   */
  readonly durationSeconds: number;
  /** One line, shown under the name in the HUD's streak strip. */
  readonly blurb: string;
  /**
   * Whether a care package may contain this. False for the package itself — a package that
   * can drop a package is a loop — and for the streaks the brief calls "higher".
   */
  readonly fromCarePackage: boolean;
}

export const STREAK_DEFS: readonly StreakDef[] = [
  {
    id: 'uav',
    name: 'UAV',
    requirement: 4,
    durationSeconds: 30,
    blurb: 'Sweeping radar · enemies pinged for 30 s',
    fromCarePackage: false,
  },
  {
    id: 'counter_uav',
    name: 'COUNTER-UAV',
    requirement: 5,
    durationSeconds: 25,
    blurb: 'Enemy minimap scrambled',
    fromCarePackage: true,
  },
  {
    id: 'care_package',
    name: 'CARE PACKAGE',
    requirement: 5,
    // The crate lives until somebody claims it or the cap expires it.
    durationSeconds: 60,
    blurb: 'Drops a random higher streak · contestable',
    fromCarePackage: false,
  },
  {
    id: 'mortar',
    name: 'MORTAR STRIKE',
    requirement: 7,
    durationSeconds: 14,
    blurb: 'Mark a zone · shells land in sequence',
    fromCarePackage: true,
  },
  {
    id: 'sentry',
    name: 'SENTRY GUN',
    requirement: 8,
    durationSeconds: 90,
    blurb: 'Placeable auto-turret · destructible',
    fromCarePackage: true,
  },
  {
    id: 'chopper',
    name: 'CHOPPER GUNNER',
    requirement: 12,
    durationSeconds: 32,
    blurb: 'Take the gun · thermal optics',
    fromCarePackage: true,
  },
];

/** Whether an arbitrary string names a shipped streak. Used by the save repair. */
export function isStreakId(value: string): value is StreakId {
  return STREAK_DEFS.some((s) => s.id === value);
}

export function streakDef(id: StreakId): StreakDef {
  const found = STREAK_DEFS.find((s) => s.id === id);
  if (found === undefined) throw new Error(`Unknown streak "${id}"`);
  return found;
}

/**
 * Tuning for the streaks that place something in the world.
 *
 * Split from `StreakDef` because these are *mechanics* rather than the streak's identity: a
 * designer changing how far a sentry can see is doing something different from changing what
 * a sentry costs.
 */
export interface StreakConfig {
  // ---- UAV ----------------------------------------------------------------
  /** Seconds for one full radar revolution. Sweeping, not continuous (S6.1). */
  readonly uavSweepSeconds: number;
  /** How long a contact stays lit after the sweep passes over it, seconds. */
  readonly uavContactFadeSeconds: number;

  // ---- care package -------------------------------------------------------
  /** Seconds of standing on the crate to claim it. */
  readonly packageCaptureSeconds: number;
  /** How close counts as on it, metres. */
  readonly packageRadius: number;
  /** Metres the crate falls from, and how fast. */
  readonly packageDropHeight: number;
  readonly packageDropSpeed: number;

  // ---- mortar -------------------------------------------------------------
  readonly mortarShells: number;
  /** Seconds between impacts. */
  readonly mortarInterval: number;
  /** Seconds from confirming the target to the first shell. */
  readonly mortarDelay: number;
  /** Spread of impacts around the marked point, metres. */
  readonly mortarScatter: number;
  readonly mortarDamage: number;
  readonly mortarRadius: number;

  // ---- sentry -------------------------------------------------------------
  readonly sentryHealth: number;
  readonly sentryRange: number;
  /** Degrees per second the turret may slew. Deliberately unhurried. */
  readonly sentryTurnRateDeg: number;
  /** Half-angle of the arc it watches, degrees. A sentry is not omniscient. */
  readonly sentryArcDeg: number;
  readonly sentryRpm: number;
  readonly sentryDamage: number;
  /** Seconds between acquiring a target and the first round. */
  readonly sentryReactionSeconds: number;

  // ---- chopper ------------------------------------------------------------
  /** Height the gun sits at, metres. */
  readonly chopperHeight: number;
  /** Metres from the map centre; it orbits at this radius. */
  readonly chopperOrbitRadius: number;
  /** Radians per second around the map. */
  readonly chopperOrbitSpeed: number;
  readonly chopperRpm: number;
  readonly chopperDamage: number;
  /** Seconds of held trigger before the barrels reach full rate. */
  readonly chopperSpinUpSeconds: number;
  /**
   * Rounds in a belt, and the seconds it takes to feed the next one (round 2 playtest).
   *
   * The report was that the gun's unlimited ammunition made a held trigger "too overpowered",
   * and it is right for a reason worth writing down: at 900 rpm the only thing that was ever
   * bounding the streak's damage was its 30-second timer, so the optimal way to fly it was to
   * hold the trigger from the first frame to the last and sweep. There was no decision in it.
   *
   * A belt is what puts one back. 50 rounds is 3.3 seconds of sustained fire at full rate,
   * which is long enough to work a group of three and short enough that a miss costs
   * something; 2.4 seconds of feed is long enough to be felt and short enough not to waste a
   * meaningful slice of a 30-second streak. The ammunition is still *unlimited* — the belt
   * always comes back — so nothing about the streak's length changes. What changes is that
   * the gunner now has to pick which five seconds matter.
   */
  readonly chopperMagSize: number;
  readonly chopperReloadSeconds: number;
}

export const DEFAULT_STREAK_CONFIG: StreakConfig = {
  uavSweepSeconds: 2.6,
  uavContactFadeSeconds: 1.1,

  packageCaptureSeconds: 3.5,
  packageRadius: 2.2,
  packageDropHeight: 26,
  packageDropSpeed: 9,

  mortarShells: 12,
  mortarInterval: 0.55,
  mortarDelay: 2.4,
  mortarScatter: 7.5,
  mortarDamage: 130,
  mortarRadius: 5.2,

  sentryHealth: 260,
  sentryRange: 26,
  sentryTurnRateDeg: 105,
  sentryArcDeg: 80,
  sentryRpm: 420,
  sentryDamage: 18,
  sentryReactionSeconds: 0.42,

  chopperHeight: 34,
  chopperOrbitRadius: 42,
  chopperOrbitSpeed: 0.12,
  chopperRpm: 900,
  chopperDamage: 26,
  chopperSpinUpSeconds: 0.85,
  chopperMagSize: 50,
  chopperReloadSeconds: 2.4,
};

export function cloneStreakConfig(src: StreakConfig): StreakConfig {
  return { ...src };
}

/**
 * Every shipped streak id, in def order.
 *
 * The list a combatant with no class earns from — which is every bot, and is what bots have
 * always had. Shared rather than rebuilt per composition root (M11 Gate B): it lived in
 * `ClientMatch` and the dedicated server would have needed its own copy, which is one more
 * pair of facts that can drift when a seventh streak is added.
 */
export const ALL_STREAK_IDS: readonly StreakId[] = STREAK_DEFS.map((d) => d.id);
