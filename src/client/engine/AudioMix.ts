/**
 * The mix (brief S6.4): how loud every source is, and how fast it falls off with distance.
 *
 * ## The problem this file solves
 *
 * S6.4 asks for a firefight that is *legible*, and names the failure: **"the enemy's gunfire
 * must be audible over your own"**. That is not a volume slider, it is a geometry problem.
 * Your own rifle is at the listener position, so it arrives at whatever level it was
 * authored at. An enemy thirty metres away is attenuated by the panner's distance model,
 * and with M2's curve — `inverse`, `refDistance` 1.6, `rolloff` 1.1 — that works out to
 *
 *     1.6 / (1.6 + 1.1 * 28.4) = 0.049
 *
 * five per cent. Against your own shot at 100%, an enemy rifle across Foundry is
 * *inaudible*, and on Dunes, where a lane is seventy metres, it is silent. The mix that
 * shipped through M7 was a mix for one shooter standing still.
 *
 * ## The two levers, and why both are needed
 *
 * **1. A flatter curve for the things that carry.** A rifle is a loud source and a real one
 * is audible across a village; a footstep is not. So distance falloff is a property of the
 * *category* rather than a global. Gunfire gets `refDistance` 6 and `rolloff` 0.72, which
 * puts an enemy at 30 m at 0.28 and one at 60 m at 0.16 — quiet, directional, and
 * unmistakably there. Footsteps keep a tight curve, because a footstep you can hear from
 * forty metres is a footstep that tells you nothing.
 *
 * **2. Your own weapon sits below everyone else's.** `OWN_WEAPON` is 0.62. You already know
 * you are firing — the recoil, the flash and the ammo counter all said so — and the only
 * information your own gunshot carries is the information you already have. Ducking it is
 * what buys the headroom the enemy's shot needs. This is standard practice in the genre and
 * it is the single change that makes a five-on-five legible.
 *
 * Everything here is a number in one table, per S3: no level in this project is written
 * inline at a call site.
 */

/**
 * How a category of sound falls off with distance.
 *
 * Applied to the pooled voice's `PannerNode` per sound. The model is always `inverse` —
 * the physical one — and these are its three parameters.
 */
export interface DistanceProfile {
  /** Distance at which the source is at full level, metres. Bigger reads as a larger source. */
  readonly refDistance: number;
  /** How fast it falls off past `refDistance`. Below 1 is flatter than physical. */
  readonly rolloff: number;
  /** Beyond this the level stops falling. Must clear the map's diagonal or far sound cuts out. */
  readonly maxDistance: number;
}

/**
 * The five curves.
 *
 * `maxDistance` is 150 on the loud ones because Dunes is 64 x 76 m and its diagonal is 99 m;
 * at M2's 90 the far end of a lane fell off a cliff rather than fading. Checked against all
 * three maps — Foundry 62 m diagonal, Depot 71 m, Dunes 99 m.
 */
export const DISTANCE_PROFILES = {
  /** Gunfire, explosions, the chopper. The things a map-wide fight is made of. */
  loud: { refDistance: 6, rolloff: 0.72, maxDistance: 150 },
  /** Impacts and ricochets: they should place a shot, not carry across the map. */
  impact: { refDistance: 3, rolloff: 1.0, maxDistance: 90 },
  /** Mechanical noise — reloads, ADS rustle, equipment. Close-quarters information. */
  handling: { refDistance: 2.2, rolloff: 1.25, maxDistance: 45 },
  /** Footsteps. Deliberately the tightest curve on the map. */
  footstep: { refDistance: 1.6, rolloff: 1.6, maxDistance: 26 },
  /** Bodies, doors, objects. Between handling and impact. */
  world: { refDistance: 2.6, rolloff: 1.1, maxDistance: 70 },
} as const satisfies Record<string, DistanceProfile>;

export type DistanceProfileName = keyof typeof DISTANCE_PROFILES;

/**
 * Per-source level trims, applied on top of whatever a voice authored.
 *
 * These are *relative* numbers: 1.0 means "as M2-M7 shipped it". Anything that is not 1.0
 * is a deliberate change and carries its reason.
 */
export const MIX = {
  /**
   * The local player's own weapon. The headroom every other change depends on.
   *
   * 0.62 was chosen by ear against a ten-bot Depot firefight: at 0.8 an enemy at 25 m is
   * still masked by your own third round, and at 0.5 your own rifle stops feeling like it
   * has weight, which Hard Rule 3 says is a bug rather than a mix decision.
   */
  ownWeapon: 0.62,
  /** Everyone else's. Left at authored level; the curve does the work. */
  otherWeapon: 1.0,
  /**
   * The local player's own footsteps.
   *
   * Halved for the same reason as the weapon and with more force: your own steps are
   * constant, they carry no information, and they are the single most effective mask for
   * the one sound in the game you most need to hear.
   */
  ownFootstep: 0.5,
  otherFootstep: 1.0,
  /** Your own reload and ADS rustle. Close and constant; ducked, not removed. */
  ownHandling: 0.75,
  otherHandling: 1.0,
  /** Bullet impacts near the listener are how you learn you are being shot at. */
  impact: 1.15,
  /** Explosions keep their authored level: they are supposed to dominate. */
  explosion: 1.0,
  /** Announcer stings and UI. They ride their own bus and duck the world (S6.4). */
  announcer: 1.0,
} as const;

/**
 * Seconds the world is ducked under an announcer sting.
 *
 * Long enough to cover a two-syllable cue and its tail, short enough that two cues in a
 * busy round do not leave the world quiet between them — `AudioGraph.duckWorld` extends an
 * existing duck rather than restarting it, so overlapping cues are one duck.
 */
export const ANNOUNCER_DUCK_SECONDS = 0.85;
