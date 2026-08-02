import type { TunableMeta } from '../player/MovementConfig';

/**
 * Difficulty tiers (brief S6.7).
 *
 * Four tiers vary reaction time, accuracy cone, convergence rate, push aggression and
 * peek frequency. **Health is not in this table and never will be.** A bot that takes
 * more bullets than its silhouette says it should is the single most-hated thing in bot
 * FPS design, and the way to make sure that never happens by accident is to leave the
 * number out of the only file that is allowed to differ per tier.
 *
 * Grenade usage is listed by S6.7 and belongs to M5, which is the milestone that has
 * grenades. It is absent rather than present-and-ignored.
 *
 * Every value here is a slider (S7). The `Record<keyof TierConfig, TunableMeta>` type is
 * what guarantees that: adding a field without metadata is a compile error.
 */

export const BOT_TIERS = ['RECRUIT', 'REGULAR', 'HARDENED', 'VETERAN'] as const;
export type BotTier = (typeof BOT_TIERS)[number];

export interface TierConfig {
  // -- reaction (S6.3): first valid LOS to first shot ----------------------
  reactionMin: number;
  reactionMax: number;

  // -- aim (S6.4) ---------------------------------------------------------
  /** Half-angle of the settled aim error, degrees. The steady-state accuracy. */
  aimConeDeg: number;
  /** Half-angle of the deliberate opening offset, degrees. The miss-first-burst rule. */
  firstBurstConeDeg: number;
  /** How long the opening offset is held before convergence begins, seconds. */
  firstBurstHold: number;
  /** Exponential convergence of the aim offset onto the target, per second. */
  convergeRate: number;
  /** How often the aim error picks a new wander target, seconds. */
  jitterPeriod: number;
  /** Fraction of the ideal lead applied to a moving target, 0..1. */
  leadFraction: number;
  /** Extra aim cone per m/s of target lateral speed, degrees. */
  trackingErrorDeg: number;
  /**
   * Range beyond which the aim cone starts to open, metres (M6).
   *
   * The M5 playtest reported that bots "feel too accurate at long distances", and the
   * reason is that a *constant angular* cone gets easier to shoot inside as the range
   * grows relative to how hard the shot actually is: a human at 40 m has worse angular
   * precision than at 10 m, not the same. Below this range nothing changes, so every M3-M5
   * close-quarters measurement still describes the same behaviour.
   */
  rangeErrorStart: number;
  /**
   * Degrees added to the aim cone per 10 m past `rangeErrorStart`.
   *
   * Roughly doubled after the M7 playtest, which reported bots as still too accurate down a
   * lane. The term exists because a *constant angular* cone gets easier to shoot inside as
   * range grows — the linear miss radius at 40 m is four times the radius at 10 m for the
   * same number of degrees — so a bot that felt fair in a room felt like a laser across a
   * yard. Nothing inside `rangeErrorStart` changes, so close quarters are untouched.
   */
  rangeErrorPerTenM: number;
  /** Yaw slew ceiling, degrees per second. A bot may not teleport its aim. */
  turnRateDeg: number;

  // -- trigger discipline -------------------------------------------------
  burstMin: number;
  burstMax: number;
  burstPauseMin: number;
  burstPauseMax: number;
  /** Longest range the bot will open fire at, metres. */
  engageRange: number;
  /** Range at or beyond which the bot aims down sights, metres. */
  adsRange: number;

  // -- tactics ------------------------------------------------------------
  /** Chance per tactical evaluation of pushing the target rather than holding, 0..1. */
  pushAggression: number;
  /** Peeks per second while holding cover. */
  peekRate: number;
  /** Seconds a peek lasts. */
  peekDuration: number;
  /** Chance per tactical evaluation of flanking rather than pushing head-on, 0..1. */
  flankChance: number;
  /** Fraction of engagement ticks spent strafing rather than planted, 0..1. */
  strafeBias: number;
  /** Seconds before a strafe reverses. */
  strafePeriod: number;
  /** Health fraction below which the bot breaks contact for cover. */
  coverHealthFraction: number;
  /** Seconds a lost contact stays worth investigating before the bot gives up. */
  memorySeconds: number;

  // -- grenades (S6.7, arriving with M5) ----------------------------------
  /**
   * Chance per grenade evaluation of actually throwing, 0..1. Zero disables the tier.
   *
   * S6.7 lists grenade usage as a tiered property and M3 deliberately left it out rather
   * than shipping a field nothing read. This is that field, now that there is something
   * to throw.
   */
  grenadeChance: number;
  /** Seconds between grenade evaluations for one bot. */
  grenadeCooldown: number;
  /**
   * Closest a bot will let its own grenade land, metres.
   *
   * The hard half of "bots must not grenade themselves" is the trajectory check in
   * `BotThrower`; this is the margin it checks against, and it is per tier because a
   * Recruit should be more cautious than a Veteran, not more reckless.
   */
  grenadeSafeRadius: number;
  /** Longest range a bot will throw, metres. Beyond it the arc is a guess. */
  grenadeRange: number;
}

export type TierTable = Record<BotTier, TierConfig>;

/**
 * The shipped tiers.
 *
 * Reaction times span the 0.15-0.6 s band S6.3 specifies, ordered so Veteran is at the
 * fast end. The aim cones were chosen against measured hit rate at 10 m rather than by
 * feel — see the acceptance table in PLAN.md — because "accuracy cone" only means
 * something once you know what fraction of rounds it puts on a torso.
 */
export const DEFAULT_TIERS: TierTable = {
  RECRUIT: {
    reactionMin: 0.45,
    reactionMax: 0.6,
    aimConeDeg: 5.6,
    firstBurstConeDeg: 10.5,
    firstBurstHold: 0.45,
    convergeRate: 1.6,
    jitterPeriod: 0.34,
    leadFraction: 0.0,
    trackingErrorDeg: 0.5,
    rangeErrorStart: 12,
    rangeErrorPerTenM: 3.1,
    turnRateDeg: 200,
    burstMin: 2,
    burstMax: 4,
    burstPauseMin: 0.5,
    burstPauseMax: 1.0,
    engageRange: 34,
    adsRange: 16,
    pushAggression: 0.12,
    peekRate: 0.3,
    peekDuration: 0.7,
    flankChance: 0.05,
    strafeBias: 0.2,
    strafePeriod: 1.3,
    coverHealthFraction: 0.8,
    memorySeconds: 3.0,
    // A Recruit never throws. `EquipmentDef.minBotTier` gates *what* each tier may carry;
    // this gates whether it uses it at all, and the two together are S6.3's "gated by
    // difficulty tier".
    grenadeChance: 0,
    grenadeCooldown: 30,
    grenadeSafeRadius: 8.5,
    grenadeRange: 18,
  },
  REGULAR: {
    reactionMin: 0.32,
    reactionMax: 0.45,
    aimConeDeg: 4.0,
    firstBurstConeDeg: 7.5,
    firstBurstHold: 0.32,
    convergeRate: 2.6,
    jitterPeriod: 0.3,
    leadFraction: 0.25,
    trackingErrorDeg: 0.4,
    rangeErrorStart: 14,
    rangeErrorPerTenM: 2.4,
    turnRateDeg: 280,
    burstMin: 3,
    burstMax: 5,
    burstPauseMin: 0.38,
    burstPauseMax: 0.75,
    engageRange: 40,
    adsRange: 14,
    pushAggression: 0.25,
    peekRate: 0.5,
    peekDuration: 0.8,
    flankChance: 0.15,
    strafeBias: 0.4,
    strafePeriod: 1.1,
    coverHealthFraction: 0.65,
    memorySeconds: 4.0,
    grenadeChance: 0.35,
    grenadeCooldown: 22,
    grenadeSafeRadius: 8.0,
    grenadeRange: 20,
  },
  HARDENED: {
    reactionMin: 0.22,
    reactionMax: 0.32,
    aimConeDeg: 2.5,
    firstBurstConeDeg: 5.2,
    firstBurstHold: 0.24,
    convergeRate: 4.2,
    jitterPeriod: 0.26,
    leadFraction: 0.55,
    trackingErrorDeg: 0.28,
    rangeErrorStart: 16,
    rangeErrorPerTenM: 1.7,
    turnRateDeg: 380,
    burstMin: 4,
    burstMax: 6,
    burstPauseMin: 0.28,
    burstPauseMax: 0.55,
    engageRange: 44,
    adsRange: 12,
    pushAggression: 0.4,
    peekRate: 0.75,
    peekDuration: 0.9,
    flankChance: 0.28,
    strafeBias: 0.6,
    strafePeriod: 0.95,
    coverHealthFraction: 0.5,
    memorySeconds: 5.0,
    grenadeChance: 0.55,
    grenadeCooldown: 16,
    grenadeSafeRadius: 7.5,
    grenadeRange: 24,
  },
  VETERAN: {
    reactionMin: 0.15,
    reactionMax: 0.22,
    aimConeDeg: 1.35,
    firstBurstConeDeg: 3.6,
    firstBurstHold: 0.18,
    convergeRate: 6.5,
    jitterPeriod: 0.22,
    leadFraction: 0.8,
    trackingErrorDeg: 0.18,
    rangeErrorStart: 18,
    rangeErrorPerTenM: 1.2,
    turnRateDeg: 480,
    // Short, controlled bursts. Measured hit rate was *lower* than Hardened at 5-9 rounds
    // because the weapon's own recoil walks off target inside a long burst — a disciplined
    // shooter fires fewer rounds, not more, and Veteran's edge is the cone and the
    // convergence rate rather than volume of fire. See PLAN.md.
    burstMin: 3,
    burstMax: 5,
    burstPauseMin: 0.18,
    burstPauseMax: 0.34,
    // Also pulled in from 52 m: rounds sent at the far end of the room are rounds that
    // miss, and they dragged the tier's hit rate below Hardened's.
    engageRange: 46,
    adsRange: 10,
    pushAggression: 0.55,
    peekRate: 1.0,
    peekDuration: 1.0,
    flankChance: 0.4,
    strafeBias: 0.75,
    strafePeriod: 0.8,
    coverHealthFraction: 0.38,
    memorySeconds: 6.0,
    grenadeChance: 0.75,
    grenadeCooldown: 12,
    grenadeSafeRadius: 7.0,
    grenadeRange: 28,
  },
};

export const TIER_TUNABLES: Readonly<Record<keyof TierConfig, TunableMeta>> = {
  reactionMin: { label: 'Reaction min', group: 'Reaction', min: 0.05, max: 1.2, step: 0.01, unit: 's' },
  reactionMax: { label: 'Reaction max', group: 'Reaction', min: 0.05, max: 1.5, step: 0.01, unit: 's' },

  aimConeDeg: { label: 'Aim cone', group: 'Aim', min: 0.1, max: 10, step: 0.05, unit: '°' },
  firstBurstConeDeg: { label: 'First-burst cone', group: 'Aim', min: 0, max: 16, step: 0.1, unit: '°' },
  firstBurstHold: { label: 'First-burst hold', group: 'Aim', min: 0, max: 1.2, step: 0.01, unit: 's' },
  convergeRate: { label: 'Converge rate', group: 'Aim', min: 0.2, max: 16, step: 0.1, unit: '/s' },
  jitterPeriod: { label: 'Jitter period', group: 'Aim', min: 0.05, max: 1, step: 0.01, unit: 's' },
  leadFraction: { label: 'Lead fraction', group: 'Aim', min: 0, max: 1.5, step: 0.01, unit: 'x' },
  trackingErrorDeg: { label: 'Tracking error', group: 'Aim', min: 0, max: 2, step: 0.01, unit: '°' },
  rangeErrorStart: { label: 'Range error from', group: 'Aim', min: 0, max: 60, step: 0.5, unit: 'm' },
  rangeErrorPerTenM: { label: 'Range error /10m', group: 'Aim', min: 0, max: 8, step: 0.05, unit: '°' },
  turnRateDeg: { label: 'Turn rate', group: 'Aim', min: 60, max: 900, step: 10, unit: '°/s' },

  burstMin: { label: 'Burst min', group: 'Trigger', min: 1, max: 30, step: 1, unit: '' },
  burstMax: { label: 'Burst max', group: 'Trigger', min: 1, max: 30, step: 1, unit: '' },
  burstPauseMin: { label: 'Pause min', group: 'Trigger', min: 0.05, max: 2, step: 0.01, unit: 's' },
  burstPauseMax: { label: 'Pause max', group: 'Trigger', min: 0.05, max: 3, step: 0.01, unit: 's' },
  engageRange: { label: 'Engage range', group: 'Trigger', min: 5, max: 80, step: 1, unit: 'm' },
  adsRange: { label: 'ADS beyond', group: 'Trigger', min: 0, max: 60, step: 0.5, unit: 'm' },

  pushAggression: { label: 'Push', group: 'Tactics', min: 0, max: 1, step: 0.01, unit: 'x' },
  peekRate: { label: 'Peek rate', group: 'Tactics', min: 0, max: 3, step: 0.05, unit: '/s' },
  peekDuration: { label: 'Peek length', group: 'Tactics', min: 0.1, max: 3, step: 0.05, unit: 's' },
  flankChance: { label: 'Flank', group: 'Tactics', min: 0, max: 1, step: 0.01, unit: 'x' },
  strafeBias: { label: 'Strafe bias', group: 'Tactics', min: 0, max: 1, step: 0.01, unit: 'x' },
  strafePeriod: { label: 'Strafe period', group: 'Tactics', min: 0.2, max: 3, step: 0.05, unit: 's' },
  coverHealthFraction: { label: 'Break at HP', group: 'Tactics', min: 0, max: 1, step: 0.01, unit: 'x' },
  memorySeconds: { label: 'Memory', group: 'Tactics', min: 0.5, max: 15, step: 0.1, unit: 's' },

  grenadeChance: { label: 'Throw chance', group: 'Grenades', min: 0, max: 1, step: 0.01, unit: 'x' },
  grenadeCooldown: { label: 'Throw cooldown', group: 'Grenades', min: 2, max: 60, step: 0.5, unit: 's' },
  grenadeSafeRadius: { label: 'Self-safe radius', group: 'Grenades', min: 3, max: 20, step: 0.1, unit: 'm' },
  grenadeRange: { label: 'Throw range', group: 'Grenades', min: 4, max: 45, step: 0.5, unit: 'm' },
};

export const TIER_CONFIG_KEYS = Object.keys(DEFAULT_TIERS.REGULAR) as Array<keyof TierConfig>;

export function cloneTierTable(src: TierTable): TierTable {
  return {
    RECRUIT: { ...src.RECRUIT },
    REGULAR: { ...src.REGULAR },
    HARDENED: { ...src.HARDENED },
    VETERAN: { ...src.VETERAN },
  };
}

/** Serialise the whole table back out as pasteable source (COPY CONFIG). */
export function tierTableToSource(table: TierTable): string {
  const lines: string[] = ['export const DEFAULT_TIERS: TierTable = {'];
  for (const tier of BOT_TIERS) {
    lines.push(`  ${tier}: {`);
    let lastGroup = '';
    for (const key of TIER_CONFIG_KEYS) {
      const meta = TIER_TUNABLES[key];
      if (meta.group !== lastGroup) {
        if (lastGroup !== '') lines.push('');
        lastGroup = meta.group;
      }
      lines.push(`    ${key}: ${Math.round(table[tier][key] * 1e4) / 1e4},`);
    }
    lines.push('  },');
  }
  lines.push('};');
  return lines.join('\n');
}

/**
 * Perception, and everything else that is the same for every bot.
 *
 * Tiered values live above; these are properties of the *world*, not of skill, so a
 * Veteran and a Recruit share them. S6.3 fixes the vision cone and both hearing radii.
 */
export interface PerceptionConfig {
  /** Total field of view, degrees. S6.3 fixes this at 110. */
  visionConeDeg: number;
  /** Maximum sight range, metres. */
  visionRange: number;
  /** A target this close is noticed regardless of the cone — you feel someone behind you. */
  proximityRadius: number;
  /** Unsuppressed gunfire is heard this far, metres (S6.3). */
  gunfireHearing: number;
  /** Non-crouch footsteps are heard this far, metres (S6.3). */
  footstepHearing: number;
  /** Seconds a heard noise stays in the blackboard as an investigate target. */
  noiseMemory: number;
  /** Confidence decay per second once line of sight is lost, 0..1 per second. */
  confidenceDecay: number;
}

export const DEFAULT_PERCEPTION: PerceptionConfig = {
  visionConeDeg: 110,
  visionRange: 60,
  proximityRadius: 3.2,
  gunfireHearing: 40,
  footstepHearing: 12,
  noiseMemory: 6,
  confidenceDecay: 0.55,
};

export const PERCEPTION_TUNABLES: Readonly<Record<keyof PerceptionConfig, TunableMeta>> = {
  visionConeDeg: { label: 'Vision cone', group: 'Vision', min: 30, max: 360, step: 1, unit: '°' },
  visionRange: { label: 'Vision range', group: 'Vision', min: 5, max: 120, step: 1, unit: 'm' },
  proximityRadius: { label: 'Proximity', group: 'Vision', min: 0, max: 10, step: 0.1, unit: 'm' },
  gunfireHearing: { label: 'Gunfire', group: 'Hearing', min: 0, max: 90, step: 1, unit: 'm' },
  footstepHearing: { label: 'Footsteps', group: 'Hearing', min: 0, max: 40, step: 0.5, unit: 'm' },
  noiseMemory: { label: 'Noise memory', group: 'Hearing', min: 0.5, max: 20, step: 0.5, unit: 's' },
  confidenceDecay: { label: 'Confidence decay', group: 'Hearing', min: 0.05, max: 3, step: 0.05, unit: '/s' },
};

export const PERCEPTION_CONFIG_KEYS = Object.keys(DEFAULT_PERCEPTION) as Array<keyof PerceptionConfig>;

export function perceptionConfigToSource(cfg: PerceptionConfig): string {
  const lines = ['export const DEFAULT_PERCEPTION: PerceptionConfig = {'];
  for (const key of PERCEPTION_CONFIG_KEYS) {
    lines.push(`  ${key}: ${Math.round(cfg[key] * 1e4) / 1e4},`);
  }
  lines.push('};');
  return lines.join('\n');
}
