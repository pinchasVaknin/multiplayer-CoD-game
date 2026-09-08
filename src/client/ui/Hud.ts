import type { HitZone } from '../../shared/combat/HitboxRig';
import type { GameEvents } from '../../shared/core/Events';
import { clamp01, RAD2DEG } from '../../shared/core/MathUtil';
import type { HeaderSlot } from '../../shared/modes/GameMode';
import {
  relationClass,
  relationTo,
  type RelationClass,
  type ViewerContext,
} from '../../shared/ui/TeamColour';
import { CROSSHAIR_LINE_LENGTH, crosshairGapPx, crosshairOpacity } from '../../shared/ui/Crosshair';
import type { MapDef } from '../../shared/world/maps/types';
import { HudBanner, makeBannerState, type BannerState } from './HudBanner';
import { HudTactical, makeTacticalState, type TacticalState } from './HudTactical';
import { KillfeedView } from './Killfeed';
import { Minimap } from './Minimap';

/**
 * The in-match HUD (brief S6.4).
 *
 * M2 built the crosshair, the hitmarker and the ammo counter; M3 added health, the hurt
 * vignette and the directional indicators. M4 completes it: score banner, round timer,
 * killfeed, minimap, and the low-health state. The four pieces that are big enough to own
 * themselves — banner, killfeed, minimap — are separate classes this one composes, so no
 * single file owns the whole screen and `dispose` is still one call.
 *
 * DOM and CSS over the canvas (S2). Every per-frame write here is a `transform` or an
 * `opacity` on an element that is already composited, and text is only written when the
 * string actually changed, so the HUD cannot show up in the frame budget it is sitting next
 * to. `lastUpdateMs` measures exactly that and is reported in F1 (S7).
 *
 * The hitmarker is the single most important piece of feedback in the game (S6.5), so it is
 * measured: `lastHitLatencyMs` is the time from the damage being applied in the sim to this
 * class making the marker visible.
 */

const DAMAGE_NUMBER_POOL = 14;
const HITMARKER_SECONDS = 0.26;
const KILLMARKER_SECONDS = 0.4;
const DAMAGE_NUMBER_SECONDS = 0.8;

/** Directional hit indicators alive at once. Four is enough to read a crossfire. */
const HIT_DIRECTION_POOL = 4;
const HIT_DIRECTION_SECONDS = 1.1;
/** How long the full-screen hurt flash lasts. */
const HURT_FLASH_SECONDS = 0.42;


/**
 * Health at which the low-health state begins (brief S6.4).
 *
 * Below this the rim goes red and stays red, the world goes behind a low-pass and a heartbeat
 * starts. It is deliberately a hard threshold rather than a ramp from full health: the whole
 * value of the state is that crossing it is a *fact* the player can act on.
 */
export const LOW_HEALTH_THRESHOLD = 35;

/**
 * What the death screen tells the player about the fight they just lost (round 5, F9).
 *
 * F9 asks for what a player *can act on next time*, which is a shorter list than everything
 * known about a kill: who, with what, from how far, and what they had left. The last one is the
 * one that changes behaviour — "he had 8 health" is a different lesson from "he had 100" — and
 * it is the only one that could not be derived on the client, which is why it is on the wire
 * from protocol v15 rather than sampled off a stale snapshot.
 */
export interface DeathReport {
  readonly killerName: string;
  /** The weapon's display name, or `''` when it was not a weapon anybody carries. */
  readonly weaponName: string;
  /**
   * Metres between the two bodies, or -1 when the killer's position is unknown.
   *
   * Derived on the client rather than replicated: the killer's interpolated position is up to a
   * snapshot old, which at a walking pace is well under a metre on a figure printed as a whole
   * number. That is the opposite conclusion to `killerHealth` on the same event, and the
   * difference is that health can change by 100 in the time position changes by half a metre.
   */
  readonly distanceM: number;
  /** The killer's health at the instant of the kill, or 0 when there was no person to ask. */
  readonly killerHealth: number;
  readonly headshot: boolean;
}

export interface HudState {
  mag: number;
  reserve: number;
  magSize: number;
  /**
   * Draw the reserve as an infinity glyph instead of a count (round 2).
   *
   * The Chopper Gunner's belt has a size and a feed but no pool behind it, and writing some
   * large number in the reserve slot would be inventing a fact. A flag rather than a
   * sentinel value in `reserve`, because a `-1` that means "infinite" is a number every
   * arithmetic comparison in this file would get wrong.
   */
  reserveInfinite: boolean;
  /** Current cone half-angle, degrees. */
  spreadDeg: number;
  adsFraction: number;
  /** World FOV in degrees and viewport height in CSS pixels, to size the crosshair. */
  fovDeg: number;
  viewportHeight: number;
  reloading: boolean;
  reloadFraction: number;
  /** M3: damage flows both ways now, so the player needs to see their own health. */
  health: number;
  healthMax: number;
  dead: boolean;
  respawnSeconds: number;
  /**
   * True while the player is dead and will *not* be coming back this round (M7 playtest).
   *
   * Search & Destroy gives one life, so counting a respawn timer down to zero and then sitting
   * at zero is a lie the HUD tells for the rest of the round. This replaces the number with
   * what is actually happening.
   */
  awaitingRound: boolean;
  /**
   * What killed the player, or null when they are alive or nobody knows (round 5, F9).
   *
   * The death screen said `YOU WERE KILLED` and counted down, and everything a player could act
   * on was in the killfeed, in the corner, for a few seconds — while they were reading the
   * middle of the screen. This is the same facts put where they are already looking.
   */
  deathReport: DeathReport | null;

  /** M4: where the player is, so the minimap can rotate around them. */
  playerX: number;
  playerZ: number;
  playerYaw: number;
  /** M4: the score banner and the round clock. */
  banner: BannerState;
  /** M5: weapons, equipment, the flash, the grenade indicator and the scope. */
  tactical: TacticalState;
}

/**
 * One line of death report, or `''` for nothing to say (playtest round 5, F9).
 *
 * A pure function so the sentence is testable without a DOM, which is what `MatchXpAudit` and
 * `CapabilityAudit` established as the shape for this kind of rule — and because "what does the
 * panel say when the killer was a mortar" is a question with an answer, not a rendering
 * accident.
 *
 * Every field is dropped when it has nothing to contribute rather than printed as a zero: a
 * killstreak has no health to report, a fall has no killer, and `HEALTH 0 LEFT` about a sentry
 * gun would be worse than silence. The order is fixed so the eye lands in the same place every
 * time — this is read in a second and a half, three or four times a minute.
 */
export function describeDeath(report: DeathReport | null): string {
  if (report === null || report.killerName === '') return '';
  const parts: string[] = [report.killerName.toUpperCase()];
  if (report.weaponName !== '') parts.push(report.weaponName.toUpperCase());
  if (report.distanceM >= 0) parts.push(`${Math.round(report.distanceM)}M`);
  if (report.headshot) parts.push('HEADSHOT');
  // The one that changes behaviour, and it goes last because it is the one worth pausing on.
  if (report.killerHealth > 0) parts.push(`${Math.round(report.killerHealth)} HP LEFT`);
  return parts.join(' · ');
}

export function makeHudState(): HudState {
  return {
    mag: 0,
    reserve: 0,
    magSize: 30,
    reserveInfinite: false,
    spreadDeg: 0,
    adsFraction: 0,
    fovDeg: 90,
    viewportHeight: 1080,
    reloading: false,
    reloadFraction: 0,
    health: 100,
    healthMax: 100,
    dead: false,
    respawnSeconds: 0,
    awaitingRound: false,
    deathReport: null,
    playerX: 0,
    playerZ: 0,
    playerYaw: 0,
    banner: makeBannerState(),
    tactical: makeTacticalState(),
  };
}

interface DamageNumber {
  el: HTMLElement;
  life: number;
  x: number;
  y: number;
  active: boolean;
}

interface HitDirection {
  el: HTMLElement;
  life: number;
  active: boolean;
}

export interface HudDeps {
  readonly host: HTMLElement;
  /** The minimap is drawn from this, never from an image (S6.4). */
  readonly mapDef: MapDef;
  /** Teammate markers to preallocate on the minimap. */
  readonly maxFriendlies: number;
}

export class Hud {
  /** Hit-to-visual latency for the last hitmarker, ms. Reported in the debug overlay. */
  lastHitLatencyMs = -1;
  /** Damage numbers are off by default (S6.5). */
  damageNumbersEnabled = false;
  /** Wall time spent inside the last `update`, ms. Reported in F1 (S7). */
  lastUpdateMs = 0;

  readonly banner = new HudBanner();
  readonly feed = new KillfeedView();
  readonly minimap: Minimap;
  readonly tactical = new HudTactical();

  private readonly root: HTMLElement;
  private readonly crosshair: HTMLElement;
  private readonly lines: HTMLElement[] = [];
  private readonly hitmarker: HTMLElement;
  private readonly ammoMag: HTMLElement;
  private readonly ammoReserve: HTMLElement;
  private readonly ammoBox: HTMLElement;
  private readonly reloadBar: HTMLElement;
  private readonly numbers: DamageNumber[] = [];
  private readonly hurtVignette: HTMLElement;
  private readonly directions: HitDirection[] = [];
  private readonly healthBar: HTMLElement;
  private readonly healthFill: HTMLElement;
  private readonly deadOverlay: HTMLElement;
  private readonly deadCount: HTMLElement;
  private readonly deadDetail: HTMLElement;
  private lastDeadDetail = '';
  private readonly lowVignette: HTMLElement;
  /** F14's tag, and the last text written to it. See `setCheatTag`. */
  private readonly cheatTag: HTMLElement;
  private lastCheatTag = '';

  /** B8's aim warning, and the last text written to it. See `setAimWarning`. */
  private readonly aimWarning: HTMLElement;
  private lastAimWarning = '';

  /** F8's mode header strip, its cells, and the last state written to them. */
  private readonly headerStrip: HTMLElement;
  private readonly headerCells: Array<{ root: HTMLElement; fill: HTMLElement }> = [];
  private lastHeader = '';

  private hurtTimer = 0;
  private hurtPeak = 0;
  private lastVignette = -1;
  private lastLowVignette = -1;
  /** 0 when healthy, rising to 1 at zero health. Read by Match for audio. */
  private lowHealth = 0;
  private lastHealthScale = -1;
  private healthShown = false;
  private deadShown = false;
  private lastDeadText = '';

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

  // ---- M5: pushed from the sim rather than pulled through `HudState` -------
  private flashIntensity = 0;
  private threatActive = false;
  private objectiveActive = false;
  private objectiveX = 0;
  private objectiveZ = 0;
  private threatX = 0;
  private threatY = 0;
  private threatZ = 0;

  constructor(deps: HudDeps) {
    this.minimap = new Minimap(deps.mapDef, deps.maxFriendlies);

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

    // ---- M3: taking damage ------------------------------------------------
    //
    // Two rims, deliberately. The hurt flash is a *moment* — it spikes on a hit and decays
    // — and the low-health rim is a *state* that stays until you heal. One element doing
    // both would either flash weakly or hold at full brightness, and neither reads.
    this.lowVignette = document.createElement('div');
    this.lowVignette.className = 'hud-low';
    this.root.appendChild(this.lowVignette);

    this.hurtVignette = document.createElement('div');
    this.hurtVignette.className = 'hud-hurt';
    this.root.appendChild(this.hurtVignette);

    const directionLayer = document.createElement('div');
    directionLayer.className = 'hud-dirs';
    for (let i = 0; i < HIT_DIRECTION_POOL; i++) {
      const el = document.createElement('div');
      el.className = 'hud-dir';
      el.style.opacity = '0';
      el.appendChild(document.createElement('i'));
      directionLayer.appendChild(el);
      this.directions.push({ el, life: 0, active: false });
    }
    this.root.appendChild(directionLayer);

    this.healthBar = document.createElement('div');
    this.healthBar.className = 'hud-health';
    this.healthFill = document.createElement('i');
    this.healthBar.appendChild(this.healthFill);
    this.root.appendChild(this.healthBar);

    this.deadOverlay = document.createElement('div');
    this.deadOverlay.className = 'hud-dead';
    const deadLabel = document.createElement('span');
    deadLabel.className = 'hud-dead__label op-label';
    deadLabel.textContent = 'You were killed';
    this.deadCount = document.createElement('span');
    this.deadCount.className = 'hud-dead__count op-num';
    /**
     * F9's detail line, under the countdown.
     *
     * One element rewritten on change rather than four, because the four facts are one sentence
     * and are only ever set together — a death report arrives whole or not at all.
     */
    this.deadDetail = document.createElement('span');
    this.deadDetail.className = 'hud-dead__detail op-label';
    this.deadOverlay.append(deadLabel, this.deadCount, this.deadDetail);
    this.root.appendChild(this.deadOverlay);

    /**
     * The cheat tag (playtest round 4, F14).
     *
     * Bottom centre, under everything a player is actually reading, because it is a state
     * warning rather than information: it has to be *findable in a screenshot* and must not sit
     * where the ammo count or the objective banner does.
     *
     * Hidden through a `--on` class rather than the `hidden` attribute, and that is B13's lesson
     * applied on the way in rather than after somebody reported it: `[hidden]` only hides an
     * element because the UA stylesheet says so at the lowest specificity there is, so any
     * author-level `display` outranks it. `.hud-phase` beside it already uses the class.
     */
    this.cheatTag = document.createElement('div');
    this.cheatTag.className = 'hud-cheat';
    this.cheatTag.appendChild(document.createElement('span'));
    this.root.appendChild(this.cheatTag);

    /**
     * The aim warning (playtest round 5, B8).
     *
     * Its own element rather than a second use of the cheat tag, because the two can be up at
     * once and they mean opposite things — one says a rule has been relaxed for you, the other
     * says the game is not listening to your mouse. Above centre rather than below it, so it
     * does not sit on top of `.hud-cheat` at `bottom: 12%`.
     *
     * A `--on` class and not `[hidden]`, which is B13's lesson and is why `.hud-cheat` next to
     * it uses one: `[hidden] { display: none }` sits at the lowest specificity there is, and any
     * author-level `display` here would silently outrank it.
     */
    this.aimWarning = document.createElement('div');
    this.aimWarning.className = 'hud-aim';
    this.aimWarning.appendChild(document.createElement('span'));
    this.root.appendChild(this.aimWarning);

    /**
     * The mode header strip (playtest round 5, F8).
     *
     * Empty at construction and grown to whatever the mode hands over — the HUD knows the name
     * of no mode, which is the whole point of `GameMode.headerSlots`. Under the score banner,
     * so the two answers to "how is this going" are in one place rather than one on screen and
     * one on the minimap.
     */
    this.headerStrip = document.createElement('div');
    this.headerStrip.className = 'hud-header';
    this.root.appendChild(this.headerStrip);

    // ---- M4 ---------------------------------------------------------------
    this.root.append(
      this.banner.element,
      this.banner.phaseElement,
      this.feed.element,
      this.minimap.element,
    );

    // ---- M5. The scope tube goes in first so everything else draws over it, and the
    // flash white-out goes in last so it covers the lot — being flashed hides the HUD.
    this.root.append(...this.tactical.layers);

    deps.host.appendChild(this.root);
  }

  setVisible(on: boolean): void {
    this.root.hidden = !on;
    if (!on) this.clearMarkers();
  }

  /**
   * The cheat tag's text, or `''` to take it down (playtest round 4, F14).
   *
   * Called every frame from `Game.updateHudSurfaces` through `Match.setCheatTag`, and guarded on
   * the text so sixty DOM writes a second become one write per change — the same shape as
   * `HudBanner.updatePhase`.
   */
  setCheatTag(text: string): void {
    if (text === this.lastCheatTag) return;
    this.lastCheatTag = text;
    this.cheatTag.classList.toggle('hud-cheat--on', text !== '');
    const span = this.cheatTag.firstElementChild;
    if (span instanceof HTMLElement) span.textContent = text;
  }

  /**
   * The aim warning's text, or `''` to take it down (playtest round 5, B8).
   *
   * Called every frame from `Game.updateHudSurfaces` through `Match.setAimWarning`, and guarded
   * on the text so sixty DOM writes a second become one write per change — the same shape as
   * `setCheatTag` above it.
   */
  setAimWarning(text: string): void {
    if (text === this.lastAimWarning) return;
    this.lastAimWarning = text;
    this.aimWarning.classList.toggle('hud-aim--on', text !== '');
    const span = this.aimWarning.firstElementChild;
    if (span instanceof HTMLElement) span.textContent = text;
  }

  /**
   * The mode's header cells (playtest round 5, F8).
   *
   * Called every frame from `Game.updateHudSurfaces` through `Match.setHeaderSlots`, and guarded
   * on a signature so sixty DOM writes a second become one write per change — the same shape as
   * `setCheatTag` and `setAimWarning`. The signature includes the fill because a capture in
   * progress is the one thing on this strip that moves, and quantising it to whole percent is
   * what keeps a moving flag from writing every frame.
   *
   * Cells are created once per slot count and then reused. A mode's slot list is fixed for the
   * life of a match — it comes off the map's authored objectives — so the rebuild path exists
   * for the world being replaced under the HUD, not for a mode changing its mind.
   */
  setHeaderSlots(viewer: ViewerContext, slots: readonly HeaderSlot[]): void {
    /**
     * The signature carries the **relation**, not the team.
     *
     * That is not an optimisation detail: a cell is coloured by what its owner is *to this
     * viewer*, so two clients on opposite sides see opposite colours for the same flag. Keying
     * the guard on the raw team would be correct today and wrong the moment a viewer's own team
     * changes under it — which is what a side swap at half-time does.
     */
    const own = (s: HeaderSlot): RelationClass => relationClass(relationTo(viewer, s.owner));
    const cap = (s: HeaderSlot): RelationClass => relationClass(relationTo(viewer, s.capturing));
    const signature = slots
      .map((s) => `${s.label}${own(s)}${cap(s)}${Math.round(s.progress * 100)}`)
      .join('|');
    if (signature === this.lastHeader) return;
    this.lastHeader = signature;

    if (this.headerCells.length !== slots.length) this.rebuildHeader(slots.length);
    this.headerStrip.classList.toggle('hud-header--on', slots.length > 0);

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const cell = this.headerCells[i];
      if (slot === undefined || cell === undefined) continue;
      /*
       * Relative colour, through the one door (round 4, B12).
       *
       * B12 was three surfaces picking out of the right palette with the wrong index, and
       * `relationClass` is the door that was built so there is only one way from a team to a
       * colour. A header painted `--a` and `--b` would have been the fourth surface.
       */
      cell.root.className = `hud-header__cell hud-header__cell--${own(slot)}`;
      const label = cell.root.firstElementChild;
      if (label instanceof HTMLElement) label.textContent = slot.label;
      // The fill belongs to whoever is taking it, which is not always the owner — a flag being
      // taken off you fills in the *attacker's* colour, which is the warning.
      cell.fill.className = `hud-header__fill hud-header__fill--${cap(slot)}`;
      cell.fill.style.transform = `scaleX(${Math.max(0, Math.min(1, slot.progress)).toFixed(3)})`;
    }
  }

  private rebuildHeader(count: number): void {
    this.headerStrip.replaceChildren();
    this.headerCells.length = 0;
    for (let i = 0; i < count; i++) {
      const root = document.createElement('div');
      root.className = 'hud-header__cell';
      const label = document.createElement('span');
      label.className = 'hud-header__label';
      const fill = document.createElement('i');
      fill.className = 'hud-header__fill';
      root.append(label, fill);
      this.headerStrip.appendChild(root);
      this.headerCells.push({ root, fill });
    }
  }

  /** 0 while healthy, rising to 1 at zero health. Drives the muffle and the heartbeat. */
  get lowHealthIntensity(): number {
    return this.lowHealth;
  }

  /** Add a killfeed line. Called from the `killfeed.entry` subscription. */
  pushKillfeed(entry: GameEvents['killfeed.entry']): void {
    this.feed.push(entry);
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

  /**
   * The player took a hit. `amount` scales the vignette so a graze and a near-death burst
   * do not read the same, which is the only cue the player has for how much trouble they
   * are in before they look at the bar.
   */
  showHurt(amount: number, maxHealth: number): void {
    const severity = clamp01(amount / Math.max(maxHealth * 0.35, 1));
    // Keep whichever is stronger: the decaying flash already on screen, or this one. A
    // burst of five rounds should not restart at the intensity of its weakest hit.
    const remaining = this.hurtPeak * (this.hurtTimer / HURT_FLASH_SECONDS);
    this.hurtPeak = Math.max(remaining, severity);
    this.hurtTimer = HURT_FLASH_SECONDS;
  }

  /**
   * A round came in from `bearingRad`, screen-relative: 0 is straight ahead, positive is
   * to the right. This is what tells the player which way to turn, so it is pooled rather
   * than singular — being shot by two bots at once has to read as two directions.
   */
  showHitDirection(bearingRad: number): void {
    let slot: HitDirection | undefined;
    let oldest = Infinity;
    for (const d of this.directions) {
      if (!d.active) {
        slot = d;
        break;
      }
      if (d.life < oldest) {
        oldest = d.life;
        slot = d;
      }
    }
    if (slot === undefined) return;
    slot.active = true;
    slot.life = HIT_DIRECTION_SECONDS;
    slot.el.style.transform = `rotate(${(bearingRad * RAD2DEG).toFixed(1)}deg)`;
    slot.el.style.opacity = '1';
  }

  /** Called once per rendered frame, after the sim has advanced. */
  update(state: HudState, dt: number): void {
    const t0 = performance.now();
    this.updateCrosshair(state);
    this.updateAmmo(state);
    this.updateMarkers(dt);
    this.updateNumbers(dt);
    this.updateHurt(dt);
    this.updateDirections(dt);
    this.updateHealth(state);
    this.updateLowHealth(state);
    this.updateDead(state);
    this.banner.update(state.banner);
    this.feed.update(dt);
    this.minimap.update(state.playerX, state.playerZ, state.playerYaw, dt);
    this.tactical.update(state.tactical);
    this.lastUpdateMs = performance.now() - t0;
  }

  /**
   * The flashbang white-out, 0..1 (M5, S6.3).
   *
   * Pushed rather than pulled through `HudState` because it is driven from the sim by
   * `MatchEquipment` on the tick the flash lands, and a state field would delay it by a
   * frame — on an effect whose entire job is to be instant.
   */
  setFlash(intensity: number): void {
    this.flashIntensity = intensity;
  }

  /** Where the nearest live enemy grenade is, or nothing (S6.3). */
  setThreat(active: boolean, x: number, y: number, z: number): void {
    this.threatActive = active;
    this.threatX = x;
    this.threatY = y;
    this.threatZ = z;
  }

  /** Read back by `MatchHud` when it composes the tactical state each frame. */
  get pendingFlash(): number {
    return this.flashIntensity;
  }

  readThreat(out: { active: boolean; x: number; y: number; z: number }): void {
    out.active = this.threatActive;
    out.x = this.threatX;
    out.y = this.threatY;
    out.z = this.threatZ;
  }

  /**
   * Where the loose bomb is, for the objective bearing arrow (round 4, F2).
   *
   * The same set/read pair the threat uses, and for the same reason: the fact is decided in the
   * frame's earlier passes and consumed when `MatchHud` composes the tactical state, and one
   * record per frame is what stops two halves of the HUD describing different ticks.
   */
  setObjectiveBearing(active: boolean, x: number, z: number): void {
    this.objectiveActive = active;
    this.objectiveX = x;
    this.objectiveZ = z;
  }

  readObjectiveBearing(out: { active: boolean; x: number; z: number }): void {
    out.active = this.objectiveActive;
    out.x = this.objectiveX;
    out.z = this.objectiveZ;
  }

  /** Wipe every per-match trace. Called on teardown so a second match starts clean. */
  resetForMatch(): void {
    this.clearMarkers();
    this.feed.clear();
    this.minimap.clearPings();
    this.banner.reset();
    this.tactical.reset();
    this.lowHealth = 0;
    this.lastLowVignette = -1;
    this.lowVignette.style.opacity = '0';
    this.lastHitLatencyMs = -1;
    this.flashIntensity = 0;
    this.threatActive = false;
    this.objectiveActive = false;
  }

  dispose(): void {
    this.minimap.dispose();
    this.root.remove();
  }

  // -- internals -------------------------------------------------------------

  private updateCrosshair(state: HudState): void {
    // The projection, the floor and the ADS fade all live in `shared/ui/Crosshair` now, so
    // they can be measured without a browser (round 4, B2). What is left here is the writes.
    const gap = crosshairGapPx(state.spreadDeg, state.fovDeg, state.viewportHeight);

    if (gap !== this.lastGap) {
      this.lastGap = gap;
      const offset = gap + CROSSHAIR_LINE_LENGTH * 0.5;
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
    const opacity = crosshairOpacity(state.adsFraction);
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
    const reserveText = state.reserveInfinite ? '∞' : String(state.reserve);
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

  /**
   * The hurt vignette (S6.8 from the player's side).
   *
   * Squared decay rather than linear: a linear fade holds a red tint on screen long
   * enough to read as "still being shot", which is a lie the moment the shooting stops.
   */
  private updateHurt(dt: number): void {
    if (this.hurtTimer > 0) this.hurtTimer = Math.max(0, this.hurtTimer - dt);
    const t = this.hurtTimer / HURT_FLASH_SECONDS;
    const alpha = Math.round(this.hurtPeak * t * t * 100) / 100;
    if (alpha === this.lastVignette) return;
    this.lastVignette = alpha;
    this.hurtVignette.style.opacity = alpha.toFixed(2);
    if (alpha <= 0) this.hurtPeak = 0;
  }

  private updateDirections(dt: number): void {
    for (const d of this.directions) {
      if (!d.active) continue;
      d.life -= dt;
      if (d.life <= 0) {
        d.active = false;
        d.el.style.opacity = '0';
        continue;
      }
      const t = d.life / HIT_DIRECTION_SECONDS;
      d.el.style.opacity = (t * t).toFixed(2);
    }
  }

  private updateHealth(state: HudState): void {
    const fraction = state.healthMax > 0 ? clamp01(state.health / state.healthMax) : 0;
    const scale = Math.round(fraction * 100) / 100;
    if (scale !== this.lastHealthScale) {
      this.lastHealthScale = scale;
      this.healthFill.style.transform = `scaleX(${scale.toFixed(2)})`;
      this.healthBar.classList.toggle('hud-health--critical', scale <= 0.34);
    }
    // Only on screen while it means something. Full health is the absence of information,
    // and a bar that is always full is a bar the player stops reading.
    const show = !state.dead && fraction < 0.999;
    if (show === this.healthShown) return;
    this.healthShown = show;
    this.healthBar.classList.toggle('hud-health--on', show);
  }

  /**
   * The low-health state (brief S6.4).
   *
   * A hard threshold at 35 HP, then intensity rises the closer to zero the player gets. The
   * rim is here; the muffle and the heartbeat are audio and are driven from the same number
   * in `Match`, so what you see and what you hear cannot disagree about how much trouble you
   * are in.
   */
  private updateLowHealth(state: HudState): void {
    const health = state.dead ? state.healthMax : state.health;
    const intensity =
      health >= LOW_HEALTH_THRESHOLD ? 0 : clamp01((LOW_HEALTH_THRESHOLD - health) / LOW_HEALTH_THRESHOLD);
    this.lowHealth = intensity;

    // Never fully opaque: the centre of the screen has to stay readable at 5 HP, because
    // that is the moment the player most needs to see what is shooting them.
    const alpha = Math.round(intensity * 0.72 * 100) / 100;
    if (alpha === this.lastLowVignette) return;
    this.lastLowVignette = alpha;
    this.lowVignette.style.opacity = alpha.toFixed(2);
  }

  private updateDead(state: HudState): void {
    if (state.dead !== this.deadShown) {
      this.deadShown = state.dead;
      this.deadOverlay.classList.toggle('hud-dead--on', state.dead);
      // The crosshair belongs to a weapon the player is not currently holding.
      this.crosshair.style.visibility = state.dead ? 'hidden' : '';
      if (state.dead) this.clearMarkers();
    }
    if (!state.dead) return;
    const text = state.awaitingRound
      ? 'WAITING FOR NEXT ROUND'
      : state.respawnSeconds > 0
        ? state.respawnSeconds.toFixed(1)
        : 'RESPAWNING';
    if (text !== this.lastDeadText) {
      this.lastDeadText = text;
      this.deadCount.textContent = text;
    }

    const detail = describeDeath(state.deathReport);
    if (detail !== this.lastDeadDetail) {
      this.lastDeadDetail = detail;
      this.deadDetail.textContent = detail;
      this.deadDetail.classList.toggle('hud-dead__detail--on', detail !== '');
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
    for (const d of this.directions) {
      d.active = false;
      d.life = 0;
      d.el.style.opacity = '0';
    }
    this.hurtTimer = 0;
    this.hurtPeak = 0;
  }
}
