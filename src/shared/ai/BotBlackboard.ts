import { DT } from '../core/Loop';
import { clamp01 } from '../core/MathUtil';

/**
 * What one bot believes (brief S6.3).
 *
 * This is the only thing the brain is allowed to read about an enemy. `Perception` writes
 * it, at 10 Hz, from cone tests and raycasts; the brain and the aim controller read it,
 * every tick. Nothing in `ai/` may reach into a `PlayerSim` or another bot's transform to
 * find out where a target *actually* is, because the moment anything does, the bot stops
 * being beatable by breaking line of sight — which is the whole game.
 *
 * The staleness fields are what make that concrete: `lastKnownX/Y/Z` is where the target
 * was when it was last *seen*, `sinceLos` is how long ago that was, and `confidence`
 * decays from there. A bot shooting at a doorway you left two seconds ago is not a bug.
 */
export class BotBlackboard {
  /** Entity id of the enemy currently believed to be in play, or -1. */
  targetId = -1;
  /** True on the most recent perception sample. */
  hasLos = false;
  /** Seconds since line of sight was last held. Large means "not seen". */
  sinceLos = 999;
  /** Seconds of continuous line of sight. Resets the moment it breaks. */
  losHeld = 0;

  /** Where the target was last seen. Eye-height, so it can be aimed at directly. */
  lastKnownX = 0;
  lastKnownY = 0;
  lastKnownZ = 0;
  /** Feet height of the last sighting, for pathing toward it. */
  lastKnownFeetY = 0;
  /** Velocity estimate from consecutive sightings, m/s. Used for lead. */
  lastKnownVx = 0;
  lastKnownVz = 0;
  /** Straight-line distance at the last sighting, metres. */
  lastKnownRange = 0;

  /** 1 = seen right now, decaying toward 0 once sight is lost. */
  confidence = 0;

  /** A heard noise or a reported hit worth walking toward. */
  investigateValid = false;
  investigateX = 0;
  investigateY = 0;
  investigateZ = 0;
  investigateAge = 0;

  /** Counts down from the tier's reaction delay before the first shot is permitted. */
  reactionTimer = 0;
  /** True once the reaction delay for the current contact has been paid. */
  reactionPaid = false;

  /** Direction the last damage came from, normalised in XZ. Drives a flinch turn. */
  threatDirX = 0;
  threatDirZ = 0;
  sinceDamage = 999;
  /** Damage taken since this contact began, HP. Feeds the break-for-cover decision. */
  damageThisContact = 0;

  /** Highest noise serial this bot has already considered. */
  noiseCursor = 0;

  /** How many enemies were visible on the last perception sample. */
  visibleEnemies = 0;

  /** Sightings so far, so the velocity estimate can be skipped on the first one. */
  private sightings = 0;

  reset(): void {
    this.targetId = -1;
    this.hasLos = false;
    this.sinceLos = 999;
    this.losHeld = 0;
    this.lastKnownX = 0;
    this.lastKnownY = 0;
    this.lastKnownZ = 0;
    this.lastKnownFeetY = 0;
    this.lastKnownVx = 0;
    this.lastKnownVz = 0;
    this.lastKnownRange = 0;
    this.confidence = 0;
    this.investigateValid = false;
    this.investigateAge = 0;
    this.reactionTimer = 0;
    this.reactionPaid = false;
    this.threatDirX = 0;
    this.threatDirZ = 0;
    this.sinceDamage = 999;
    this.damageThisContact = 0;
    this.visibleEnemies = 0;
    this.sightings = 0;
  }

  /** One sim tick of ageing. Runs every tick even though sensing is at 10 Hz. */
  age(confidenceDecay: number, noiseMemory: number): void {
    this.sinceLos += DT;
    this.sinceDamage += DT;
    if (this.reactionTimer > 0) {
      this.reactionTimer -= DT;
      if (this.reactionTimer <= 0) {
        this.reactionTimer = 0;
        this.reactionPaid = true;
      }
    }
    if (!this.hasLos) {
      this.losHeld = 0;
      this.confidence = clamp01(this.confidence - confidenceDecay * DT);
    } else {
      this.losHeld += DT;
    }
    if (this.investigateValid) {
      this.investigateAge += DT;
      if (this.investigateAge > noiseMemory) this.investigateValid = false;
    }
  }

  /**
   * Record a sighting. `x/y/z` is the aim point (eye height), `feetY` the ground pose.
   *
   * The velocity estimate comes from the change between sightings rather than from the
   * target's real velocity, which matters: a target that jinks between two perception
   * samples is a target the bot mis-leads, and that is the correct outcome.
   */
  noteSighting(
    targetId: number,
    x: number,
    y: number,
    z: number,
    feetY: number,
    range: number,
    interval: number,
  ): void {
    const sameTarget = this.targetId === targetId;
    if (sameTarget && this.sightings > 0 && interval > 1e-4) {
      const inv = 1 / interval;
      this.lastKnownVx = (x - this.lastKnownX) * inv;
      this.lastKnownVz = (z - this.lastKnownZ) * inv;
    } else {
      this.lastKnownVx = 0;
      this.lastKnownVz = 0;
    }
    if (!sameTarget) {
      this.sightings = 0;
      this.damageThisContact = 0;
    }
    this.targetId = targetId;
    this.lastKnownX = x;
    this.lastKnownY = y;
    this.lastKnownZ = z;
    this.lastKnownFeetY = feetY;
    this.lastKnownRange = range;
    this.hasLos = true;
    this.sinceLos = 0;
    this.confidence = 1;
    this.sightings++;
  }

  /** Perception ran and saw nothing. Keeps the memory, drops the sight flag. */
  noteNoSighting(): void {
    this.hasLos = false;
    this.visibleEnemies = 0;
  }

  /** A heard noise, or a shot that came out of nowhere. Not perfect knowledge (S6.3). */
  noteInvestigate(x: number, y: number, z: number): void {
    this.investigateValid = true;
    this.investigateX = x;
    this.investigateY = y;
    this.investigateZ = z;
    this.investigateAge = 0;
  }

  noteDamage(fromX: number, fromZ: number, atX: number, atZ: number, amount: number): void {
    const dx = fromX - atX;
    const dz = fromZ - atZ;
    const len = Math.hypot(dx, dz);
    if (len > 1e-4) {
      this.threatDirX = dx / len;
      this.threatDirZ = dz / len;
    }
    this.sinceDamage = 0;
    this.damageThisContact += amount;
  }

  /** Start the reaction clock for a fresh contact (S6.3). */
  armReaction(seconds: number): void {
    this.reactionTimer = seconds;
    this.reactionPaid = seconds <= 0;
  }

  /** True when the bot has a position worth shooting at, seen or remembered. */
  get hasKnownTarget(): boolean {
    return this.targetId >= 0 && this.confidence > 0.05;
  }
}
