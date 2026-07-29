import { clamp01, DEG2RAD } from '../core/MathUtil';
import type { HitZone } from '../combat/HitboxRig';

/**
 * The in-match HUD (brief S6.5). Crosshair, hitmarker, ammo. Nothing else — S9 puts the
 * rest of the HUD in later milestones and this one stays honest about that.
 *
 * DOM and CSS over the canvas (S2). Every per-frame write here is a `transform` or an
 * `opacity` on an element that is already composited, and text is only written when the
 * string actually changed, so the HUD cannot show up in the frame budget it is sitting
 * next to.
 *
 * The hitmarker is the single most important piece of feedback in the game (S6.5), so it
 * is measured: `lastHitLatencyMs` is the time from the damage being applied in the sim to
 * this class making the marker visible.
 */

const DAMAGE_NUMBER_POOL = 14;
const HITMARKER_SECONDS = 0.26;
const KILLMARKER_SECONDS = 0.4;
const DAMAGE_NUMBER_SECONDS = 0.8;

/** Crosshair line length in px; must match `--hud-cross-len` in hud.css. */
const LINE_LENGTH = 7;
const MIN_GAP = 3;

export interface HudState {
  mag: number;
  reserve: number;
  magSize: number;
  /** Current cone half-angle, degrees. */
  spreadDeg: number;
  adsFraction: number;
  /** World FOV in degrees and viewport height in CSS pixels, to size the crosshair. */
  fovDeg: number;
  viewportHeight: number;
  reloading: boolean;
  reloadFraction: number;
}

export function makeHudState(): HudState {
  return {
    mag: 0,
    reserve: 0,
    magSize: 30,
    spreadDeg: 0,
    adsFraction: 0,
    fovDeg: 90,
    viewportHeight: 1080,
    reloading: false,
    reloadFraction: 0,
  };
}

interface DamageNumber {
  el: HTMLElement;
  life: number;
  x: number;
  y: number;
  active: boolean;
}

export class Hud {
  /** Hit-to-visual latency for the last hitmarker, ms. Reported in the debug overlay. */
  lastHitLatencyMs = -1;
  /** Damage numbers are off by default (S6.5). */
  damageNumbersEnabled = false;

  private readonly root: HTMLElement;
  private readonly crosshair: HTMLElement;
  private readonly lines: HTMLElement[] = [];
  private readonly hitmarker: HTMLElement;
  private readonly ammoMag: HTMLElement;
  private readonly ammoReserve: HTMLElement;
  private readonly ammoBox: HTMLElement;
  private readonly reloadBar: HTMLElement;
  private readonly numbers: DamageNumber[] = [];

  private hitTimer = 0;
  private hitDuration = HITMARKER_SECONDS;
  private pendingHitAtMs = -1;
  private pendingKill = false;
  private markerVisible = false;

  private lastMagText = '';
  private lastReserveText = '';
  private lastGap = -1;
  private lastCrossOpacity = -1;
  private lowAmmo = false;
  private reloadShown = false;

  constructor(host: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.hidden = true;

    this.crosshair = document.createElement('div');
    this.crosshair.className = 'hud-cross';
    for (const side of ['t', 'b', 'l', 'r'] as const) {
      const line = document.createElement('i');
      line.className = `hud-cross__line hud-cross__line--${side}`;
      this.crosshair.appendChild(line);
      this.lines.push(line);
    }
    const dot = document.createElement('i');
    dot.className = 'hud-cross__dot';
    this.crosshair.appendChild(dot);
    this.root.appendChild(this.crosshair);

    this.hitmarker = document.createElement('div');
    this.hitmarker.className = 'hud-hit';
    for (let i = 0; i < 4; i++) this.hitmarker.appendChild(document.createElement('i'));
    this.root.appendChild(this.hitmarker);

    this.ammoBox = document.createElement('div');
    this.ammoBox.className = 'hud-ammo';
    this.ammoMag = document.createElement('span');
    this.ammoMag.className = 'hud-ammo__mag op-num';
    const sep = document.createElement('span');
    sep.className = 'hud-ammo__sep';
    sep.textContent = '/';
    this.ammoReserve = document.createElement('span');
    this.ammoReserve.className = 'hud-ammo__reserve op-num';
    this.ammoBox.append(this.ammoMag, sep, this.ammoReserve);
    this.root.appendChild(this.ammoBox);

    this.reloadBar = document.createElement('div');
    this.reloadBar.className = 'hud-reload';
    this.reloadBar.appendChild(document.createElement('i'));
    this.root.appendChild(this.reloadBar);

    const numberLayer = document.createElement('div');
    numberLayer.className = 'hud-numbers';
    for (let i = 0; i < DAMAGE_NUMBER_POOL; i++) {
      const el = document.createElement('span');
      el.className = 'hud-number op-num';
      el.style.opacity = '0';
      numberLayer.appendChild(el);
      this.numbers.push({ el, life: 0, x: 0, y: 0, active: false });
    }
    this.root.appendChild(numberLayer);

    host.appendChild(this.root);
  }

  setVisible(on: boolean): void {
    this.root.hidden = !on;
    if (!on) this.clearMarkers();
  }

  /**
   * Request a hitmarker. `atMs` is when the damage landed in the sim; the marker becomes
   * visible in the next `update`, which is this frame's render, and the delta between
   * the two is what gets reported.
   */
  showHitmarker(kill: boolean, atMs: number): void {
    // A kill outranks a pending hit on the same frame: red wins.
    if (this.pendingHitAtMs >= 0 && this.pendingKill && !kill) return;
    this.pendingHitAtMs = atMs;
    this.pendingKill = kill;
  }

  showDamageNumber(screenX: number, screenY: number, amount: number, zone: HitZone): void {
    if (!this.damageNumbersEnabled) return;
    let slot: DamageNumber | undefined;
    for (const n of this.numbers) {
      if (!n.active) {
        slot = n;
        break;
      }
    }
    if (slot === undefined) return;
    slot.active = true;
    slot.life = DAMAGE_NUMBER_SECONDS;
    slot.x = screenX;
    slot.y = screenY;
    slot.el.textContent = Math.round(amount).toString();
    slot.el.classList.toggle('hud-number--head', zone === 'head');
    slot.el.style.opacity = '1';
  }

  /** Called once per rendered frame, after the sim has advanced. */
  update(state: HudState, dt: number): void {
    this.updateCrosshair(state);
    this.updateAmmo(state);
    this.updateMarkers(dt);
    this.updateNumbers(dt);
  }

  dispose(): void {
    this.root.remove();
  }

  // -- internals -------------------------------------------------------------

  private updateCrosshair(state: HudState): void {
    // The gap is the spread cone projected onto the screen, so what the crosshair shows
    // is literally where the rounds can go — not a decorative animation of it.
    const halfHeight = state.viewportHeight * 0.5;
    const tanHalfFov = Math.tan(state.fovDeg * 0.5 * DEG2RAD);
    const projected = tanHalfFov > 1e-4 ? (Math.tan(state.spreadDeg * DEG2RAD) / tanHalfFov) * halfHeight : 0;
    const gap = Math.round(Math.min(220, Math.max(MIN_GAP, projected)));

    if (gap !== this.lastGap) {
      this.lastGap = gap;
      const offset = gap + LINE_LENGTH * 0.5;
      const t = this.lines[0];
      const b = this.lines[1];
      const l = this.lines[2];
      const r = this.lines[3];
      if (t !== undefined) t.style.transform = `translate(-50%, -50%) translateY(${-offset}px)`;
      if (b !== undefined) b.style.transform = `translate(-50%, -50%) translateY(${offset}px)`;
      if (l !== undefined) l.style.transform = `translate(-50%, -50%) translateX(${-offset}px)`;
      if (r !== undefined) r.style.transform = `translate(-50%, -50%) translateX(${offset}px)`;
    }

    // Hidden on ADS (S6.5): the sights are the aiming reference, not an overlay.
    const opacity = Math.round((1 - clamp01(state.adsFraction * 1.35)) * 100) / 100;
    if (opacity !== this.lastCrossOpacity) {
      this.lastCrossOpacity = opacity;
      this.crosshair.style.opacity = String(opacity);
    }
  }

  private updateAmmo(state: HudState): void {
    const magText = String(state.mag);
    if (magText !== this.lastMagText) {
      this.lastMagText = magText;
      this.ammoMag.textContent = magText;
    }
    const reserveText = String(state.reserve);
    if (reserveText !== this.lastReserveText) {
      this.lastReserveText = reserveText;
      this.ammoReserve.textContent = reserveText;
    }

    const low = state.mag <= Math.max(1, Math.ceil(state.magSize * 0.25));
    if (low !== this.lowAmmo) {
      this.lowAmmo = low;
      this.ammoBox.classList.toggle('hud-ammo--low', low);
    }

    if (state.reloading !== this.reloadShown) {
      this.reloadShown = state.reloading;
      this.reloadBar.classList.toggle('hud-reload--on', state.reloading);
    }
    if (state.reloading) {
      const fill = this.reloadBar.firstElementChild;
      if (fill instanceof HTMLElement) {
        fill.style.transform = `scaleX(${clamp01(state.reloadFraction).toFixed(3)})`;
      }
    }
  }

  private updateMarkers(dt: number): void {
    if (this.pendingHitAtMs >= 0) {
      const kill = this.pendingKill;
      this.hitDuration = kill ? KILLMARKER_SECONDS : HITMARKER_SECONDS;
      this.hitTimer = this.hitDuration;
      this.hitmarker.classList.toggle('hud-hit--kill', kill);
      this.hitmarker.style.opacity = '1';
      this.markerVisible = true;
      this.lastHitLatencyMs = performance.now() - this.pendingHitAtMs;
      this.pendingHitAtMs = -1;
      this.pendingKill = false;
      return;
    }

    if (!this.markerVisible) return;
    this.hitTimer -= dt;
    if (this.hitTimer <= 0) {
      this.hitmarker.style.opacity = '0';
      this.markerVisible = false;
      return;
    }
    // Hold at full for the first third, then fall away. A linear fade reads as a smear.
    const t = this.hitTimer / this.hitDuration;
    const alpha = t > 0.66 ? 1 : t / 0.66;
    this.hitmarker.style.opacity = alpha.toFixed(2);
    this.hitmarker.style.transform = `translate(-50%, -50%) scale(${(1 + (1 - t) * 0.35).toFixed(3)})`;
  }

  private updateNumbers(dt: number): void {
    for (const n of this.numbers) {
      if (!n.active) continue;
      n.life -= dt;
      if (n.life <= 0) {
        n.active = false;
        n.el.style.opacity = '0';
        continue;
      }
      const t = 1 - n.life / DAMAGE_NUMBER_SECONDS;
      n.el.style.transform = `translate(-50%, -50%) translateY(${(-28 * t).toFixed(1)}px)`;
      n.el.style.opacity = (1 - t * t).toFixed(2);
      n.el.style.left = `${n.x.toFixed(0)}px`;
      n.el.style.top = `${n.y.toFixed(0)}px`;
    }
  }

  private clearMarkers(): void {
    this.hitTimer = 0;
    this.markerVisible = false;
    this.pendingHitAtMs = -1;
    this.hitmarker.style.opacity = '0';
    for (const n of this.numbers) {
      n.active = false;
      n.el.style.opacity = '0';
    }
  }
}
