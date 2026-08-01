import { clamp01, RAD2DEG } from '../core/MathUtil';

/**
 * The M5 half of the HUD: equipment, the grenade indicator, the flash white-out, and the
 * scope (brief S6.1, S6.3).
 *
 * A separate class composed by `Hud` for the same reason `HudBanner`, `Killfeed` and
 * `Minimap` are — `Hud.ts` is already at S3's size limit and this is five more independent
 * widgets. Everything here follows the same rule as the rest of the HUD: per-frame writes
 * are `transform` and `opacity` only, and text is written only when the string changed.
 */

/**
 * ADS fraction at which the scope tube starts closing in around the picture.
 *
 * The transition is deliberately non-linear: the weapon is visibly up before the vignette
 * arrives, so scoping reads as raising a rifle rather than as a screen effect.
 */
export const SCOPE_OVERLAY_START = 0.55;

/**
 * ADS fraction past which the *weapon* stops being drawn (M7).
 *
 * A scoped weapon's tube is a solid cylinder standing exactly on the sight line, 0.17 m from
 * the eye — measured, not assumed. Below this fraction the player is looking *at* a rifle and
 * should see it; above it they are looking *through* an optic, and the honest picture is the
 * one the overlay draws. Without the hand-off the scope's clear centre is filled by the
 * weapon's own objective bell, which is the same defect the M6 playtest reported on the SMG's
 * red dot. Set above `SCOPE_OVERLAY_START` so the tube is already closing before the gun goes.
 */
export const SCOPE_VIEWMODEL_HIDDEN = 0.8;

export interface TacticalState {
  /** Active weapon name and which slot it came from, for the weapon plate. */
  weaponName: string;
  slotIndex: number;
  /** The other slot's name, dimmed under the active one. */
  otherName: string;

  lethalId: string;
  lethalCount: number;
  tacticalId: string;
  tacticalCount: number;
  /** Seconds of fuse left on a cooked grenade, or 0. */
  cookRemaining: number;
  cookTotal: number;

  /** 0..1 white-out. */
  flash: number;

  /** Live enemy lethal near the player. */
  threatActive: boolean;
  threatX: number;
  threatY: number;
  threatZ: number;

  /** 0 = irons, 1 = fully scoped. Draws the scope overlay. */
  scopeFraction: number;
  /** 0..1 breath remaining, and whether it is being held. */
  breath: number;
  breathHeld: boolean;
  hasScope: boolean;

  // -- M6 --------------------------------------------------------------------
  /** The equipped field upgrade's short name, and 0..1 of its charge. */
  fieldUpgradeName: string;
  fieldUpgradeCharge: number;
}

export function makeTacticalState(): TacticalState {
  return {
    weaponName: '',
    slotIndex: 0,
    otherName: '',
    lethalId: 'frag',
    lethalCount: 0,
    tacticalId: 'flashbang',
    tacticalCount: 0,
    cookRemaining: 0,
    cookTotal: 1,
    flash: 0,
    threatActive: false,
    threatX: 0,
    threatY: 0,
    threatZ: 0,
    scopeFraction: 0,
    breath: 1,
    breathHeld: false,
    hasScope: false,
    fieldUpgradeName: '',
    fieldUpgradeCharge: 0,
  };
}

/** Short labels. The HUD has no room for "FLASHBANG" next to a count. */
const EQUIPMENT_LABELS: Readonly<Record<string, string>> = {
  frag: 'FRAG',
  semtex: 'SEMTEX',
  flashbang: 'FLASH',
  smoke: 'SMOKE',
  claymore: 'CLAY',
};

export class HudTactical {
  readonly element: HTMLElement;
  readonly flashElement: HTMLElement;
  readonly scopeElement: HTMLElement;
  readonly threatElement: HTMLElement;

  private readonly weaponPrimary: HTMLElement;
  private readonly weaponSecondary: HTMLElement;
  private readonly lethalLabel: HTMLElement;
  private readonly lethalCount: HTMLElement;
  private readonly tacticalLabel: HTMLElement;
  private readonly tacticalCount: HTMLElement;
  private readonly cookBar: HTMLElement;
  private readonly cookFill: HTMLElement;
  private readonly breathBar: HTMLElement;
  private readonly breathFill: HTMLElement;
  private readonly upgradeSlot: HTMLElement;
  private readonly upgradeLabel: HTMLElement;
  private readonly upgradeFill: HTMLElement;

  private lastUpgrade = '';
  private lastCharge = -1;
  private lastWeapon = '';
  private lastOther = '';
  private lastLethal = '';
  private lastTactical = '';
  private lastFlash = -1;
  private lastScope = -1;
  private lastThreatAngle = 999;
  private threatShown = false;
  private cookShown = false;
  private breathShown = false;

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'hud-tac';

    const weapons = document.createElement('div');
    weapons.className = 'hud-tac__weapons';
    this.weaponPrimary = document.createElement('span');
    this.weaponPrimary.className = 'hud-tac__weapon op-label';
    this.weaponSecondary = document.createElement('span');
    this.weaponSecondary.className = 'hud-tac__weapon hud-tac__weapon--alt op-label';
    weapons.append(this.weaponPrimary, this.weaponSecondary);

    const gear = document.createElement('div');
    gear.className = 'hud-tac__gear';
    const lethal = document.createElement('div');
    lethal.className = 'hud-tac__slot';
    this.lethalLabel = document.createElement('span');
    this.lethalLabel.className = 'hud-tac__slot-label op-label';
    this.lethalCount = document.createElement('span');
    this.lethalCount.className = 'hud-tac__slot-count op-num';
    lethal.append(this.lethalLabel, this.lethalCount);

    const tactical = document.createElement('div');
    tactical.className = 'hud-tac__slot';
    this.tacticalLabel = document.createElement('span');
    this.tacticalLabel.className = 'hud-tac__slot-label op-label';
    this.tacticalCount = document.createElement('span');
    this.tacticalCount.className = 'hud-tac__slot-count op-num';
    tactical.append(this.tacticalLabel, this.tacticalCount);

    // The field upgrade is a slot like the other two, with its charge drawn as a fill
    // behind the label rather than as a separate bar — it is the same kind of thing as a
    // grenade count and belongs in the same row (M6, S6.3).
    this.upgradeSlot = document.createElement('div');
    this.upgradeSlot.className = 'hud-tac__slot hud-tac__slot--upgrade';
    this.upgradeFill = document.createElement('i');
    this.upgradeFill.className = 'hud-tac__charge';
    this.upgradeLabel = document.createElement('span');
    this.upgradeLabel.className = 'hud-tac__slot-label op-label';
    this.upgradeSlot.append(this.upgradeFill, this.upgradeLabel);

    gear.append(lethal, tactical, this.upgradeSlot);

    this.element.append(weapons, gear);

    // The cook bar sits under the crosshair rather than with the gear: it is a timer you
    // are watching while aiming, and a player looking at the corner of the screen with a
    // live grenade in their hand has already lost.
    this.cookBar = document.createElement('div');
    this.cookBar.className = 'hud-cook';
    this.cookFill = document.createElement('i');
    this.cookBar.appendChild(this.cookFill);

    this.breathBar = document.createElement('div');
    this.breathBar.className = 'hud-breath';
    this.breathFill = document.createElement('i');
    this.breathBar.appendChild(this.breathFill);

    this.threatElement = document.createElement('div');
    this.threatElement.className = 'hud-threat';
    this.threatElement.appendChild(document.createElement('i'));
    this.threatElement.style.opacity = '0';

    this.flashElement = document.createElement('div');
    this.flashElement.className = 'hud-flash';
    this.flashElement.style.opacity = '0';

    this.scopeElement = document.createElement('div');
    this.scopeElement.className = 'hud-scope';
    this.scopeElement.style.opacity = '0';
    const reticle = document.createElement('i');
    reticle.className = 'hud-scope__reticle';
    this.scopeElement.appendChild(reticle);
  }

  /** Every element this owns, in the order `Hud` should append them. */
  get layers(): readonly HTMLElement[] {
    return [this.scopeElement, this.element, this.cookBar, this.breathBar, this.threatElement, this.flashElement];
  }

  /**
   * One frame. `playerYaw` turns the threat's world position into a screen-relative
   * bearing, which is the same maths the directional hit indicator uses.
   */
  update(state: TacticalState, playerX: number, playerZ: number, playerYaw: number): void {
    if (state.weaponName !== this.lastWeapon) {
      this.lastWeapon = state.weaponName;
      this.weaponPrimary.textContent = state.weaponName;
    }
    if (state.otherName !== this.lastOther) {
      this.lastOther = state.otherName;
      this.weaponSecondary.textContent = state.otherName;
    }

    const lethalText = `${label(state.lethalId)} ${state.lethalCount}`;
    if (lethalText !== this.lastLethal) {
      this.lastLethal = lethalText;
      this.lethalLabel.textContent = label(state.lethalId);
      this.lethalCount.textContent = state.lethalCount.toString();
      this.lethalCount.classList.toggle('is-empty', state.lethalCount <= 0);
    }
    const tacticalText = `${label(state.tacticalId)} ${state.tacticalCount}`;
    if (tacticalText !== this.lastTactical) {
      this.lastTactical = tacticalText;
      this.tacticalLabel.textContent = label(state.tacticalId);
      this.tacticalCount.textContent = state.tacticalCount.toString();
      this.tacticalCount.classList.toggle('is-empty', state.tacticalCount <= 0);
    }

    if (state.fieldUpgradeName !== this.lastUpgrade) {
      this.lastUpgrade = state.fieldUpgradeName;
      this.upgradeLabel.textContent = state.fieldUpgradeName;
    }
    // Quantised to a hundredth: the charge changes every tick and a `style` write per
    // frame for a bar that moves 1% a second is a DOM write nobody can see.
    const charge = Math.round(clamp01(state.fieldUpgradeCharge) * 100) / 100;
    if (charge !== this.lastCharge) {
      this.lastCharge = charge;
      this.upgradeFill.style.transform = `scaleX(${charge.toFixed(2)})`;
      this.upgradeSlot.classList.toggle('is-ready', charge >= 1);
    }

    this.updateCook(state);
    this.updateBreath(state);
    this.updateThreat(state, playerX, playerZ, playerYaw);
    this.updateFlash(state.flash);
    this.updateScope(state.scopeFraction);
  }

  reset(): void {
    this.lastFlash = -1;
    this.lastScope = -1;
    this.flashElement.style.opacity = '0';
    this.scopeElement.style.opacity = '0';
    this.threatElement.style.opacity = '0';
    this.cookBar.style.opacity = '0';
    this.breathBar.style.opacity = '0';
    this.threatShown = false;
    this.cookShown = false;
    this.breathShown = false;
  }

  // -- internals -------------------------------------------------------------

  private updateCook(state: TacticalState): void {
    const cooking = state.cookRemaining > 0;
    if (cooking !== this.cookShown) {
      this.cookShown = cooking;
      this.cookBar.style.opacity = cooking ? '1' : '0';
    }
    if (!cooking) return;
    const fraction = clamp01(state.cookRemaining / Math.max(state.cookTotal, 1e-3));
    this.cookFill.style.transform = `scaleX(${fraction.toFixed(3)})`;
    // Red once there is less than a second left, which is the only warning there is.
    this.cookFill.classList.toggle('is-critical', state.cookRemaining < 1);
  }

  private updateBreath(state: TacticalState): void {
    const show = state.hasScope && state.scopeFraction > 0.4;
    if (show !== this.breathShown) {
      this.breathShown = show;
      this.breathBar.style.opacity = show ? '1' : '0';
    }
    if (!show) return;
    this.breathFill.style.transform = `scaleX(${clamp01(state.breath).toFixed(3)})`;
    this.breathFill.classList.toggle('is-held', state.breathHeld);
  }

  private updateThreat(
    state: TacticalState,
    playerX: number,
    playerZ: number,
    playerYaw: number,
  ): void {
    if (state.threatActive !== this.threatShown) {
      this.threatShown = state.threatActive;
      this.threatElement.style.opacity = state.threatActive ? '1' : '0';
    }
    if (!state.threatActive) return;

    // World bearing to the grenade, minus where the player is looking. Positive is to the
    // right of the crosshair, which is the same convention `showHitDirection` uses.
    const worldAngle = Math.atan2(state.threatX - playerX, -(state.threatZ - playerZ));
    const relative = worldAngle - playerYaw;
    const deg = Math.round(relative * RAD2DEG);
    if (deg === this.lastThreatAngle) return;
    this.lastThreatAngle = deg;
    this.threatElement.style.transform = `rotate(${deg}deg)`;
  }

  private updateFlash(flash: number): void {
    const value = clamp01(flash);
    if (Math.abs(value - this.lastFlash) < 0.01) return;
    this.lastFlash = value;
    this.flashElement.style.opacity = value.toFixed(3);
  }

  private updateScope(fraction: number): void {
    const value = clamp01(fraction);
    if (Math.abs(value - this.lastScope) < 0.01) return;
    this.lastScope = value;
    // Deliberately non-linear: the tube arrives late in the transition so the weapon is
    // visibly coming up before the picture closes in around it.
    const opacity = value < SCOPE_OVERLAY_START ? 0 : (value - SCOPE_OVERLAY_START) / (1 - SCOPE_OVERLAY_START);
    this.scopeElement.style.opacity = opacity.toFixed(3);
  }
}

function label(id: string): string {
  return EQUIPMENT_LABELS[id] ?? id.toUpperCase();
}
