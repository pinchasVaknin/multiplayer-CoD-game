import { EV, type GameBus, type ReloadStep } from '../core/Events';
import { DT } from '../core/Loop';
import { clamp01, moveTowards } from '../core/MathUtil';
import { shotInterval, type WeaponDef } from './WeaponDefs';

/**
 * The weapon runtime: ammo, fire timing, ADS, reload, sprint-to-fire (brief S6.1/S6.6).
 *
 * One rule shapes this whole file: **`raise` is the single authority for whether the
 * weapon can fire, and it is also the value the viewmodel poses against.** There is no
 * separate "animation finished" flag to fall out of step with a "can fire" flag, because
 * S8.1 asks for no state where the animation and the fireable state disagree, and the
 * only reliable way to get that is to have one number and no second opinion.
 *
 * Everything advances on sim ticks with the constant `DT`. Allocation free.
 */

export interface WeaponInput {
  fireHeld: boolean;
  firePressed: boolean;
  adsHeld: boolean;
  reloadPressed: boolean;
  /** Sprint, tactical sprint, slide and mantle all lower the weapon. */
  lowering: boolean;
}

export function makeWeaponInput(): WeaponInput {
  return { fireHeld: false, firePressed: false, adsHeld: false, reloadPressed: false, lowering: false };
}

/** Keyframe positions as a fraction of the reload's duration. */
interface ReloadTrack {
  readonly steps: readonly ReloadStep[];
  readonly times: readonly number[];
}

const TACTICAL_TRACK: ReloadTrack = {
  steps: ['down', 'magOut', 'magIn', 'raise'],
  times: [0.0, 0.17, 0.5, 0.78],
};

/** The empty reload is longer and has to work the charging handle (S6.6). */
const EMPTY_TRACK: ReloadTrack = {
  steps: ['down', 'magOut', 'magIn', 'charge', 'raise'],
  times: [0.0, 0.15, 0.42, 0.68, 0.86],
};

/** How much faster the weapon drops than it comes back up. */
const LOWER_SPEED_SCALE = 1.7;

/** Safety valve: no weapon in this project fires faster than four rounds a tick. */
const MAX_SHOTS_PER_TICK = 4;

const evReloadStart = { weaponId: '', sourceId: 0, empty: false, duration: 0 };
const evReloadStep = { weaponId: '', sourceId: 0, step: 'down' as ReloadStep };
const evReloadDone = { weaponId: '', sourceId: 0, mag: 0, reserve: 0 };
const evAds = { weaponId: '', sourceId: 0, aiming: false };
const evAmmo = { weaponId: '', sourceId: 0, mag: 0, reserve: 0 };
const evDry = { weaponId: '', sourceId: 0 };

export class Weapon {
  mag: number;
  reserve: number;

  /** Seconds until the next round may leave the barrel. */
  fireTimer = 0;

  /** 0 = fully lowered (sprinting), 1 = up and able to fire. */
  raise = 1;
  /** 0 = hip, 1 = fully aimed. Linear in time, so `adsTime` is exactly what it says. */
  adsFraction = 0;

  reloading = false;
  reloadElapsed = 0;
  reloadDuration = 0;
  reloadEmpty = false;

  /** Shots owed to the caller this tick. */
  pendingShots = 0;

  /**
   * Overrides the raise/lower rate while non-zero, in seconds (M5).
   *
   * A swap's put-away and take-out are authored as durations rather than as a rate, and
   * `Inventory` owns them. Zero means "use `sprintOutTime`", which is every other case.
   */
  handlingSeconds = 0;

  /** True on the tick the trigger was pulled with an empty magazine. */
  dryFiredThisTick = false;
  /** True on the tick a reload completed; the caller resets the recoil pattern. */
  reloadFinishedThisTick = false;

  private reloadStepIndex = 0;
  private aimingLastTick = false;
  /**
   * Set once the trigger has been reported empty for the current pull, and cleared when
   * the trigger is released. Without it, running the magazine dry *while holding* the
   * trigger produces neither a click nor the automatic reload, because there is no press
   * edge on the tick the last round leaves — which is exactly the case a player hits.
   */
  private dryFiredThisPull = false;

  /**
   * `sourceId` stamps every event this weapon emits. It defaults to the local player (0)
   * because M2 only ever had one weapon; from M3 each bot carries one, and the id is how
   * a subscriber tells "I reloaded" from "something reloaded over there" — which matters,
   * because the two sounds belong at completely different places in the room.
   */
  constructor(
    private def: WeaponDef,
    private readonly bus: GameBus,
    readonly sourceId: number = 0,
  ) {
    this.mag = def.magSize;
    this.reserve = def.reserveAmmo;
  }

  get definition(): WeaponDef {
    return this.def;
  }

  /** Live retune from the debug panel. Ammo is clamped, never silently topped up. */
  setDefinition(def: WeaponDef): void {
    this.def = def;
    if (this.mag > def.magSize) this.mag = def.magSize;
    if (this.reserve > def.reserveAmmo) this.reserve = def.reserveAmmo;
  }

  /** The one authority: the weapon can fire exactly when it is fully raised. */
  get canFire(): boolean {
    return this.raise >= 1 && !this.reloading;
  }

  get aiming(): boolean {
    return this.adsFraction > 0.999;
  }

  get isEmpty(): boolean {
    return this.mag <= 0;
  }

  get reloadFraction(): number {
    return this.reloadDuration > 0 ? clamp01(this.reloadElapsed / this.reloadDuration) : 0;
  }

  /** Which keyframe segment the reload is in. The viewmodel poses against this. */
  get reloadStep(): ReloadStep {
    const track = this.reloadEmpty ? EMPTY_TRACK : TACTICAL_TRACK;
    const index = Math.min(this.reloadStepIndex, track.steps.length - 1);
    return track.steps[index] ?? 'down';
  }

  resetAmmo(): void {
    this.mag = this.def.magSize;
    this.reserve = this.def.reserveAmmo;
    this.cancelReload();
    this.fireTimer = 0;
    this.pendingShots = 0;
    this.emitAmmo();
  }

  /** One simulation tick. */
  step(input: WeaponInput): void {
    this.pendingShots = 0;
    this.dryFiredThisTick = false;
    this.reloadFinishedThisTick = false;

    this.stepRaise(input.lowering);
    this.stepReload(input.lowering);
    this.stepAds(input);
    this.stepTrigger(input);
  }

  /**
   * One tick for a weapon that is in the holster (M5).
   *
   * It still runs — a holstered weapon is not frozen, it is simply not being aimed — but
   * it takes no trigger and no reload input, and its `raise` is driven to zero by the
   * `lowering` flag the caller passes. Without this the secondary's ADS fraction would
   * still be whatever it was when you swapped off it, and the swap back would start from a
   * pose the player never left it in.
   */
  stepHolstered(input: WeaponInput): void {
    this.pendingShots = 0;
    this.dryFiredThisTick = false;
    this.reloadFinishedThisTick = false;
    this.stepRaise(true);
    this.stepAds(input);
  }

  /**
   * Take one owed shot. Returns false once the tick's shots are spent, so the caller's
   * loop terminates on the weapon's authority rather than its own bookkeeping.
   */
  consumeShot(): boolean {
    if (this.pendingShots <= 0 || this.mag <= 0) return false;
    this.pendingShots--;
    this.mag--;
    this.emitAmmo();
    return true;
  }

  beginReload(): void {
    if (this.reloading) return;
    const def = this.def;
    if (this.mag >= def.magSize || this.reserve <= 0) return;
    this.reloading = true;
    this.reloadEmpty = this.mag <= 0;
    this.reloadDuration = this.reloadEmpty ? def.reloadEmptyTime : def.reloadTime;
    this.reloadElapsed = 0;
    this.reloadStepIndex = 0;
    evReloadStart.weaponId = def.id;
    evReloadStart.sourceId = this.sourceId;
    evReloadStart.empty = this.reloadEmpty;
    evReloadStart.duration = this.reloadDuration;
    this.bus.emit(EV.WeaponReloadStarted, evReloadStart);
    this.emitReloadStep();
  }

  cancelReload(): void {
    this.reloading = false;
    this.reloadElapsed = 0;
    this.reloadStepIndex = 0;
  }

  // -- internals -----------------------------------------------------------

  private stepRaise(lowering: boolean): void {
    const swap = this.handlingSeconds > 0;
    const seconds = swap ? this.handlingSeconds : this.def.sprintOutTime;
    const perSecond = 1 / Math.max(seconds, 1e-3);
    if (lowering) {
      // A sprint drops the weapon faster than it brings it back; a swap's put-away is an
      // authored duration and must land on it exactly.
      const scale = swap ? 1 : LOWER_SPEED_SCALE;
      this.raise = moveTowards(this.raise, 0, perSecond * scale * DT);
    } else {
      this.raise = moveTowards(this.raise, 1, perSecond * DT);
    }
  }

  private stepReload(lowering: boolean): void {
    if (!this.reloading) return;

    // Sprinting out of a reload is legal and costs you the reload. The ammo only lands
    // on completion, so there is no half-reload state to reason about.
    if (lowering) {
      this.cancelReload();
      return;
    }

    this.reloadElapsed += DT;

    const track = this.reloadEmpty ? EMPTY_TRACK : TACTICAL_TRACK;
    const fraction = this.reloadFraction;
    while (this.reloadStepIndex + 1 < track.steps.length) {
      const nextTime = track.times[this.reloadStepIndex + 1] ?? 1;
      if (fraction < nextTime) break;
      this.reloadStepIndex++;
      this.emitReloadStep();
    }

    if (this.reloadElapsed < this.reloadDuration) return;

    const def = this.def;
    const wanted = def.magSize - this.mag;
    const taken = Math.min(wanted, this.reserve);
    this.mag += taken;
    this.reserve -= taken;
    this.reloading = false;
    this.reloadElapsed = 0;
    this.reloadStepIndex = 0;
    this.reloadFinishedThisTick = true;
    // A fresh magazine ends the dry pull, so holding the trigger through a reload
    // resumes firing rather than clicking at a full weapon.
    this.dryFiredThisPull = false;
    evReloadDone.weaponId = def.id;
    evReloadDone.sourceId = this.sourceId;
    evReloadDone.mag = this.mag;
    evReloadDone.reserve = this.reserve;
    this.bus.emit(EV.WeaponReloadFinished, evReloadDone);
    this.emitAmmo();
  }

  private stepAds(input: WeaponInput): void {
    // A reload takes the sights away: the viewmodel cannot be at the eye and working the
    // magazine at the same time, and pretending otherwise is exactly the animation lie
    // S8.1 rules out.
    const want = input.adsHeld && !input.lowering && !this.reloading;
    const rate = DT / Math.max(this.def.adsTime, 1e-3);
    this.adsFraction = moveTowards(this.adsFraction, want ? 1 : 0, rate);

    const aimingNow = this.aiming;
    if (aimingNow !== this.aimingLastTick) {
      this.aimingLastTick = aimingNow;
      evAds.weaponId = this.def.id;
      evAds.sourceId = this.sourceId;
      evAds.aiming = aimingNow;
      this.bus.emit(EV.WeaponAdsChanged, evAds);
    }
  }

  private stepTrigger(input: WeaponInput): void {
    if (input.reloadPressed) this.beginReload();

    this.fireTimer -= DT;

    if (!input.fireHeld) this.dryFiredThisPull = false;

    if (!input.fireHeld || !this.canFire) {
      if (this.fireTimer < 0) this.fireTimer = 0;
      return;
    }

    if (this.mag <= 0) {
      // Click, once per trigger pull, then reload for the player the way CoD does.
      if (!this.dryFiredThisPull) {
        this.dryFiredThisPull = true;
        this.dryFiredThisTick = true;
        evDry.weaponId = this.def.id;
        evDry.sourceId = this.sourceId;
        this.bus.emit(EV.WeaponDryFired, evDry);
        if (this.reserve > 0) this.beginReload();
      }
      if (this.fireTimer < 0) this.fireTimer = 0;
      return;
    }

    // Fractional accumulator, not a whole number of ticks: 700 RPM is 5.14 ticks per
    // shot, and rounding that to 5 or 6 would put the real rate at 720 or 600.
    const interval = shotInterval(this.def);
    let queued = 0;
    while (this.fireTimer <= 0 && queued < MAX_SHOTS_PER_TICK && queued < this.mag) {
      queued++;
      this.fireTimer += interval;
    }
    this.pendingShots = queued;
    if (this.fireTimer < 0) this.fireTimer = 0;
  }

  private emitReloadStep(): void {
    evReloadStep.weaponId = this.def.id;
    evReloadStep.sourceId = this.sourceId;
    evReloadStep.step = this.reloadStep;
    this.bus.emit(EV.WeaponReloadStep, evReloadStep);
  }

  private emitAmmo(): void {
    evAmmo.weaponId = this.def.id;
    evAmmo.sourceId = this.sourceId;
    evAmmo.mag = this.mag;
    evAmmo.reserve = this.reserve;
    this.bus.emit(EV.WeaponAmmoChanged, evAmmo);
  }
}
