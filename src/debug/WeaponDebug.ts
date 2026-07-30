import { EV, type GameBus } from '../core/Events';
import type { ProceduralAudio } from '../engine/ProceduralAudio';
import type { Match } from '../Match';
import {
  DEFAULT_HEALTH_CONFIG,
  HEALTH_CONFIG_KEYS,
  HEALTH_TUNABLES,
  healthConfigToSource,
  type HealthConfig,
} from '../player/Health';
import {
  cloneViewmodelConfig,
  DEFAULT_VIEWMODEL_CONFIG,
  VIEWMODEL_CONFIG_KEYS,
  VIEWMODEL_TUNABLES,
  viewmodelConfigToSource,
  type ViewmodelConfig,
} from '../weapons/ViewmodelConfig';
import { AR_DEFAULT, type WeaponDef } from '../weapons/WeaponDefs';
import {
  readWeaponNumber,
  WEAPON_NUMBER_KEYS,
  WEAPON_TUNABLES,
  weaponDefToSource,
  writeWeaponNumber,
} from '../weapons/WeaponTuning';
import type { DebugOverlay } from './DebugOverlay';
import type { HitboxDebug } from './HitboxDebug';
import { LatencyProbe } from './LatencyProbe';
import { makeAccessorGroup, makeTuningGroup } from './TuningPanel';
import { PLOT_HEIGHT, PLOT_WIDTH, RING_HEIGHT, RING_WIDTH, WeaponPlots } from './WeaponPlots';

/**
 * The M2 half of the debug overlay (brief S7).
 *
 * Extends the M1 overlay rather than building a second one: sections go in the left
 * column, generated slider sets go in the right, and both refresh on the overlay's own
 * 15 Hz / 5 Hz hooks. The two canvas plots live in `WeaponPlots.ts`; this file is the
 * read-outs, the controls and the generated slider sets.
 */

const LATENCY_W = 300;
const LATENCY_H = 70;

export class WeaponDebug {
  private readonly latencyCanvas: CanvasRenderingContext2D;
  private readonly plots: WeaponPlots;
  private readonly unsubscribe: Array<() => void> = [];

  private readonly fAmmo: Field;
  private readonly fState: Field;
  private readonly fAds: Field;
  private readonly fSpread: Field;
  private readonly fRate: Field;
  private readonly fHealth: Field;
  private readonly fHitTarget: Field;
  private readonly fHitDamage: Field;
  private readonly fHitLoss: Field;
  private readonly fMarker: Field;
  private readonly fLatency: Field;
  private readonly fPools: Field;
  private readonly fBurst: Field;

  private shotTimes: number[] = [];

  constructor(
    overlay: DebugOverlay,
    private readonly match: Match,
    private readonly weaponDef: WeaponDef,
    viewmodelConfig: ViewmodelConfig,
    private readonly healthConfig: HealthConfig,
    private readonly hitboxes: HitboxDebug,
    private readonly audio: ProceduralAudio,
    bus: GameBus,
    private readonly onWeaponChanged: () => void,
  ) {
    const left = overlay.leftColumn;

    const weapons = overlay.section('Weapon', left);
    this.fAmmo = weapons.addField('Ammo');
    this.fState = weapons.addField('State');
    this.fAds = weapons.addField('ADS / raise');
    this.fSpread = weapons.addField('Spread');
    this.fRate = weapons.addField('Measured RPM');
    this.fHealth = weapons.addField('Player health');

    const hits = overlay.section('Last hit', left);
    this.fHitTarget = hits.addField('Target / zone');
    this.fHitDamage = hits.addField('Base x mult = final');
    this.fHitLoss = hits.addField('Falloff / pen loss');
    this.fMarker = hits.addField('Hitmarker latency');
    hits.addNode(
      this.toggle('Hitbox rigs (F4)', false, (on) => {
        this.hitboxes.setEnabled(on);
      }),
    );
    hits.addNode(
      this.toggle('Damage numbers', false, (on) => {
        this.match.ui.hud.damageNumbersEnabled = on;
      }),
    );

    const recoil = overlay.section('Recoil pattern', left);
    this.fBurst = recoil.addField('Burst / previous');
    this.plots = new WeaponPlots(
      makeCanvas(PLOT_WIDTH, PLOT_HEIGHT, recoil),
      makeCanvas(RING_WIDTH, RING_HEIGHT, recoil),
      weaponDef,
    );

    const probe = overlay.section('Input latency', left);
    this.fLatency = probe.addField('p50 / p99');
    this.latencyCanvas = makeCanvas(LATENCY_W, LATENCY_H, probe);
    probe.addNode(
      this.button('Reset latency samples', () => {
        this.match.latency.reset();
      }),
    );

    const pools = overlay.section('Pools', left);
    this.fPools = pools.addField('Fx / audio');
    pools.addNode(
      this.button('Reset targets', () => {
        this.match.range?.resetAll();
      }),
    );
    pools.addNode(
      this.button('Refill ammo', () => {
        this.match.weapons.weapon.resetAmmo();
      }),
    );
    pools.addNode(
      this.button('Damage self (40)', () => {
        this.match.applySelfDamage(40);
      }),
    );

    overlay.addTuningGroup(
      makeAccessorGroup(
        `Weapon · ${weaponDef.name}`,
        WEAPON_NUMBER_KEYS,
        (key) => WEAPON_TUNABLES[key as keyof typeof WEAPON_TUNABLES],
        (key) => readWeaponNumber(weaponDef, key as (typeof WEAPON_NUMBER_KEYS)[number]),
        (key, value) => {
          writeWeaponNumber(weaponDef, key as (typeof WEAPON_NUMBER_KEYS)[number], value);
        },
        () => weaponDefToSource(weaponDef),
        () => {
          for (const key of WEAPON_NUMBER_KEYS) writeWeaponNumber(weaponDef, key, readWeaponNumber(AR_DEFAULT, key));
        },
      ),
      () => {
        this.plots.rebuildPattern(this.weaponDef);
        this.onWeaponChanged();
      },
    );

    overlay.addTuningGroup(
      makeTuningGroup(
        'Viewmodel',
        viewmodelConfig,
        VIEWMODEL_TUNABLES,
        VIEWMODEL_CONFIG_KEYS,
        cloneViewmodelConfig(DEFAULT_VIEWMODEL_CONFIG),
        viewmodelConfigToSource,
      ),
      () => this.onWeaponChanged(),
    );

    overlay.addTuningGroup(
      makeTuningGroup(
        'Health',
        healthConfig,
        HEALTH_TUNABLES,
        HEALTH_CONFIG_KEYS,
        { ...DEFAULT_HEALTH_CONFIG },
        healthConfigToSource,
      ),
      () => this.onWeaponChanged(),
    );

    // The unsubscribe is retained from M4: this panel is built and destroyed with each match,
    // and a live subscription would keep it — and through it the whole `Match` — alive for the
    // life of the page. One of the two leaks the multi-match heap run found.
    this.unsubscribe.push(
      bus.on(EV.WeaponFired, (p) => {
        this.plots.record(p.dx, p.dy, p.dz, p.shotIndex);
        this.shotTimes.push(performance.now());
        if (this.shotTimes.length > 24) this.shotTimes.shift();
      }),
    );

    overlay.addTextHook(() => this.refreshText());
    overlay.addGraphHook(() => this.refreshGraphs());

    window.addEventListener('keydown', this.onKeyDown);
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    window.removeEventListener('keydown', this.onKeyDown);
  }

  /**
   * Clear both recorded bursts. A verification script calls this before firing so the
   * plot shows exactly the two magazines the criterion is about, and nothing else.
   */
  resetBursts(): void {
    this.plots.reset();
    this.shotTimes.length = 0;
  }

  private refreshText(): void {
    const match = this.match;
    const weapon = match.weapons.weapon;
    const def = weapon.definition;
    const hit = match.damage.lastHit;
    const latency = match.latency;
    const health = match.playerHealth;

    set(this.fAmmo, `${weapon.mag} / ${weapon.reserve}`);
    set(
      this.fState,
      weapon.reloading
        ? `RELOAD ${weapon.reloadEmpty ? 'empty' : 'tac'} ${weapon.reloadStep} ${(weapon.reloadFraction * 100).toFixed(0)}%`
        : weapon.canFire
          ? 'READY'
          : 'RAISING',
    );
    set(
      this.fAds,
      `${weapon.adsFraction.toFixed(2)} / ${weapon.raise.toFixed(2)}${weapon.canFire ? '' : '  (cannot fire)'}`,
    );
    set(
      this.fSpread,
      `${match.weapons.spreadDeg.toFixed(3)}°  bloom ${match.weapons.recoil.bloom.toFixed(3)}°  shot ${match.weapons.recoil.shotIndex}`,
    );
    set(this.fRate, `${this.measuredRpm().toFixed(0)} (def ${def.rpm})`);
    set(
      this.fHealth,
      `${health.current.toFixed(1)} / ${health.max}` +
        (health.regenerating
          ? '  regen'
          : health.current < health.max
            ? `  in ${(this.healthConfig.regenDelay - health.sinceDamage).toFixed(1)}s`
            : ''),
    );

    if (hit.valid) {
      set(this.fHitTarget, `${hit.targetName} · ${hit.zone} · ${hit.distance.toFixed(2)} m`);
      set(
        this.fHitDamage,
        `${hit.baseDamage.toFixed(1)} x ${hit.zoneMultiplier.toFixed(2)} = ${hit.finalDamage.toFixed(1)}  (hp ${hit.remainingHealth.toFixed(1)})`,
      );
      set(
        this.fHitLoss,
        `${hit.falloffLoss.toFixed(1)} / ${hit.penetrationLoss.toFixed(1)}${hit.lethal ? '  LETHAL' : ''}`,
      );
    } else {
      set(this.fHitTarget, 'no hits yet');
      set(this.fHitDamage, '-');
      set(this.fHitLoss, '-');
    }

    const markerMs = match.ui.hud.lastHitLatencyMs;
    set(this.fMarker, markerMs < 0 ? '-' : `${markerMs.toFixed(1)} ms (budget 30)`);

    latency.recompute();
    set(
      this.fLatency,
      latency.count === 0
        ? 'no samples'
        : `${LatencyProbe.frames(latency.p50).toFixed(2)}f / ${LatencyProbe.frames(latency.p99).toFixed(2)}f` +
          `  (${latency.p50.toFixed(1)} / ${latency.p99.toFixed(1)} ms, n=${latency.count})`,
    );

    const fx = match.fx;
    const audio = this.audio;
    // The audio-node figure is the one acceptance criterion 6 is really about: a pooled
    // graph holds `poolSize` steady no matter how long the trigger is held.
    set(
      this.fPools,
      `tr ${fx.activeTracers} · pt ${fx.activeParticles} · dec ${fx.decals}/${fx.decalCapacity} · ` +
        `voices ${audio.voiceCount}/${audio.poolSize} peak ${audio.poolPeak}`,
    );
    set(this.fBurst, `${this.plots.currentCount} / ${this.plots.previousCount} shots`);
  }

  private refreshGraphs(): void {
    this.plots.draw(this.weaponDef, this.match.weapons.spreadDeg);
    this.match.latency.draw(this.latencyCanvas, LATENCY_W, LATENCY_H, {
      background: '#0c0e11',
      good: '#6fd08c',
      bad: '#e8604c',
      grid: '#39404b',
    });
  }

  private measuredRpm(): number {
    const times = this.shotTimes;
    if (times.length < 3) return 0;
    const first = times[0] ?? 0;
    const last = times[times.length - 1] ?? 0;
    const span = last - first;
    if (span <= 0) return 0;
    // Stale bursts must not be averaged with the current one.
    if (performance.now() - last > 600) return 0;
    return ((times.length - 1) / span) * 60000;
  }

  private button(label: string, onClick: () => void): HTMLElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dbg-btn dbg-btn--block';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  private toggle(label: string, initial: boolean, onChange: (on: boolean) => void): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'dbg-toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = initial;
    const text = document.createElement('span');
    text.textContent = label;
    input.addEventListener('change', () => onChange(input.checked));
    wrap.append(input, text);
    return wrap;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.code !== 'F4') return;
    e.preventDefault();
    this.hitboxes.setEnabled(!this.hitboxes.isEnabled);
  };
}

interface Field {
  el: HTMLElement;
  last: string;
}

function set(field: Field, text: string): void {
  if (field.last === text) return;
  field.last = text;
  field.el.textContent = text;
}

function makeCanvas(
  width: number,
  height: number,
  section: { addNode(node: HTMLElement): void },
): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.className = 'dbg-graph';
  canvas.width = width;
  canvas.height = height;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('Weapon debug needs a 2D context');
  section.addNode(canvas);
  return ctx;
}
