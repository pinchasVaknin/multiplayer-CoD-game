import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DT } from '../core/Loop';
import { clamp01, smoothstep } from '../core/MathUtil';
import { Health, type HealthConfig } from '../player/Health';
import type { Damageable } from './DamageSystem';
import { HitboxRig, HUMANOID_RIG, type HitZone } from './HitboxRig';

/**
 * Range dummies (brief S6.8): a static target, one that pops up on a timer, and one that
 * strafes a fixed path.
 *
 * Each one carries the **real** hitbox rig — the same `HUMANOID_RIG` M3's bots will
 * attach — and its mesh is built directly from the rig boxes. That is deliberate: on a
 * grey-box target, what you see should be exactly what you can hit, because the whole
 * point of shooting these is to verify the multipliers against printed damage.
 *
 * The printed read-out lives on a `CanvasTexture` above the target rather than in the
 * console, so it is legible while you are still holding the trigger.
 */

/**
 * M7 adds two, from the M6 playtest notes.
 *
 * `infinite` never dies, so a magazine can be emptied into it and the read-out becomes a DPS
 * meter rather than a kill counter. `faller` drops flat when killed and stands back up, which
 * is the target that tells you at a glance whether a burst was lethal — a popup on a timer
 * cannot, because it was going down anyway.
 */
export type DummyBehaviour = 'static' | 'popup' | 'strafe' | 'infinite' | 'faller';

export interface DummySpec {
  readonly id: number;
  readonly name: string;
  readonly behaviour: DummyBehaviour;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  /** Strafe half-travel along the local X axis, metres. */
  readonly travel?: number;
  readonly speed?: number;
  /** Pop-up cycle, seconds: time up, then time down. */
  readonly upTime?: number;
  readonly downTime?: number;
  /** Seconds a `faller` stays down before it stands back up. */
  readonly standTime?: number;
}

/** Seconds a downed dummy stays down before it resets. */
const RESPAWN_SECONDS = 2.5;
/** How far a popup target sinks, metres. Below the rig height, so it fully hides. */
const POPUP_DEPTH = 2.0;
const POPUP_TRANSITION = 0.32;

/** Seconds without a hit before the infinite dummy's DPS window restarts. */
const DPS_IDLE_RESET = 1.5;

const LABEL_W = 256;
const LABEL_H = 96;

export class TargetDummy implements Damageable {
  readonly entityId: number;
  readonly displayName: string;
  readonly health: Health;
  readonly rig = new HitboxRig(HUMANOID_RIG);
  readonly group = new THREE.Group();

  /** Total damage taken since the last reset, for the printed read-out. */
  totalDamage = 0;
  /**
   * Sustained damage per second, for the infinite dummy (M7).
   *
   * Measured from the first round of the current burst rather than from the dummy's whole
   * life: a DPS figure that includes the ten seconds you spent walking up to it is not a DPS
   * figure. The window resets after `DPS_IDLE_RESET` of not being shot.
   */
  dps = 0;
  private dpsDamage = 0;
  private dpsSeconds = 0;
  private sinceHit = 0;
  lastDamage = 0;
  lastZone: HitZone = 'torso';
  lastDistance = 0;

  /**
   * Time-to-kill, measured on the dummy rather than calculated (M5, S7).
   *
   * The brief asks for a range where the balance table "can be measured rather than
   * calculated", and this is the measuring instrument: ticks from the first round that
   * lands on a full-health target to the one that drops it, plus how many rounds that
   * took. It counts sim ticks, so the figure cannot vary with frame rate.
   *
   * `lastTtkSeconds` is -1 until a kill has been recorded, and survives the respawn so the
   * board still shows what you did after the target comes back.
   */
  lastTtkSeconds = -1;
  lastShotsToKill = 0;
  private ttkTicks = 0;
  private ttkShots = 0;
  private ttkRunning = false;

  private readonly spec: DummySpec;
  private readonly body: THREE.Mesh;
  private readonly head: THREE.Mesh;
  private readonly label: THREE.Mesh;
  private readonly labelCanvas: HTMLCanvasElement;
  private readonly labelCtx: CanvasRenderingContext2D;
  private readonly labelTexture: THREE.CanvasTexture;
  private readonly disposables: Array<{ dispose(): void }> = [];

  /**
   * The dummy's base position.
   *
   * Seeded from the spec and mutable from M5, because `ArsenalHarness` measures the same
   * target at four ranges and a spec-fixed position meant every cell of the balance table
   * was measured at whatever distance the spec happened to put it — which is exactly the
   * bug the first run of the table produced.
   */
  private baseX: number;
  private baseY: number;
  private baseZ: number;

  private phase = 0;
  private respawnTimer = 0;
  private fallAmount = 0;
  private strafeDir = 1;
  private strafeOffset = 0;
  private labelDirty = true;
  /**
   * Health as it is currently printed. Regeneration changes `health.current` every tick;
   * repainting a canvas and re-uploading a texture sixty times a second to move a number
   * that has not visibly changed is exactly the kind of cost that hides in a soak test.
   */
  private shownHealth = -1;
  private shownAlive = true;

  /** Interpolation snapshots: dummies move in the sim and render between ticks. */
  private prevX = 0;
  private prevY = 0;
  private prevZ = 0;
  private currX = 0;
  private currY = 0;
  private currZ = 0;

  constructor(spec: DummySpec, healthConfig: HealthConfig, materials: DummyMaterials) {
    this.spec = spec;
    this.entityId = spec.id;
    this.displayName = spec.name;
    this.health = new Health(healthConfig);
    this.baseX = spec.x;
    this.baseY = spec.y;
    this.baseZ = spec.z;

    this.body = new THREE.Mesh(buildZoneGeometry(['torso', 'arm', 'leg']), materials.body);
    this.head = new THREE.Mesh(buildZoneGeometry(['head']), materials.head);
    this.body.castShadow = true;
    this.head.castShadow = true;
    this.disposables.push(this.body.geometry, this.head.geometry);

    this.labelCanvas = document.createElement('canvas');
    this.labelCanvas.width = LABEL_W;
    this.labelCanvas.height = LABEL_H;
    const ctx = this.labelCanvas.getContext('2d');
    if (ctx === null) throw new Error('2D canvas context unavailable; cannot build target read-outs.');
    this.labelCtx = ctx;
    this.labelTexture = new THREE.CanvasTexture(this.labelCanvas);
    this.labelTexture.colorSpace = THREE.SRGBColorSpace;
    const labelMaterial = new THREE.MeshBasicMaterial({
      map: this.labelTexture,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.disposables.push(this.labelTexture, labelMaterial);
    const labelGeometry = new THREE.PlaneGeometry(0.9, 0.34);
    this.disposables.push(labelGeometry);
    this.label = new THREE.Mesh(labelGeometry, labelMaterial);
    this.label.position.set(0, HUMANOID_RIG.height + 0.34, 0);

    this.group.name = `dummy:${spec.name}`;
    this.group.add(this.body, this.head, this.label);
    this.group.position.set(spec.x, spec.y, spec.z);
    this.group.rotation.y = spec.yaw;

    this.currX = spec.x;
    this.currY = spec.y;
    this.currZ = spec.z;
    this.prevX = spec.x;
    this.prevY = spec.y;
    this.prevZ = spec.z;
    this.rig.setTransform(spec.x, spec.y, spec.z, spec.yaw);
    this.drawLabel();
  }

  /** True for a dummy that must never die. Read by the damage read-out and by `step`. */
  get isInfinite(): boolean {
    return this.spec.behaviour === 'infinite';
  }

  get behaviour(): DummyBehaviour {
    return this.spec.behaviour;
  }

  /**
   * Move the target. Snaps: there is no interpolation across a teleport, and pretending
   * otherwise would draw a dummy sliding across the map between balance-table cells.
   */
  setPosition(x: number, y: number, z: number): void {
    this.baseX = x;
    this.baseY = y;
    this.baseZ = z;
    this.strafeOffset = 0;
    this.currX = x;
    this.currY = y;
    this.currZ = z;
    this.prevX = x;
    this.prevY = y;
    this.prevZ = z;
    this.group.position.set(x, y, z);
    this.rig.setTransform(x, y, z, this.spec.yaw);
  }

  /** True when the target is standing and shootable. */
  get exposed(): boolean {
    return this.health.alive && this.currY > this.baseY - POPUP_DEPTH * 0.75;
  }

  /**
   * Record a hit for the printed read-out. The damage itself came from `DamageSystem`.
   *
   * The TTK clock starts on the first round that lands while the target is at full health,
   * which is the definition every balance table in this genre uses: shots into a target
   * that is already regenerating are a different measurement.
   */
  noteHit(amount: number, zone: HitZone, distance: number): void {
    this.sinceHit = 0;
    this.dpsDamage += amount;
    this.lastDamage = amount;
    this.lastZone = zone;
    this.lastDistance = distance;
    this.totalDamage += amount;

    if (!this.ttkRunning) {
      this.ttkRunning = true;
      this.ttkTicks = 0;
      this.ttkShots = 0;
    }
    this.ttkShots++;
    if (!this.health.alive) {
      this.ttkRunning = false;
      this.lastTtkSeconds = this.ttkTicks * DT;
      this.lastShotsToKill = this.ttkShots;
    }
    this.labelDirty = true;
  }

  reset(): void {
    this.health.reset();
    this.totalDamage = 0;
    this.lastDamage = 0;
    this.respawnTimer = 0;
    // The clock resets with the target, but the *result* is kept: the board's whole job is
    // to still be showing what you did after the dummy stands back up.
    this.ttkRunning = false;
    this.ttkTicks = 0;
    this.ttkShots = 0;
    this.labelDirty = true;
  }

  /** One sim tick. Movement is gameplay: it decides whether your shot connects. */
  step(): void {
    this.prevX = this.currX;
    this.prevY = this.currY;
    this.prevZ = this.currZ;

    // An infinite dummy is topped up before anything else looks at it, so it can never
    // enter the death path and the read-out stays a damage meter (M7).
    if (this.isInfinite) {
      this.health.reset();
      this.sinceHit += DT;
      if (this.sinceHit > DPS_IDLE_RESET) {
        this.dpsDamage = 0;
        this.dpsSeconds = 0;
        this.dps = 0;
      } else if (this.dpsSeconds > 0) {
        this.dps = this.dpsDamage / this.dpsSeconds;
      }
      if (this.dpsDamage > 0) this.dpsSeconds += DT;
      if (this.sinceHit < DPS_IDLE_RESET) this.labelDirty = true;
    }
    this.health.step();

    // The TTK clock counts sim ticks, so the figure cannot vary with frame rate (S4.1).
    if (this.ttkRunning) {
      this.ttkTicks++;
      // Health back to full without a kill means the burst failed; stop the clock rather
      // than letting the next shot inherit a stale start time.
      if (this.health.current >= this.health.max) this.ttkRunning = false;
    }

    if (!this.health.alive) {
      this.respawnTimer += DT;
      if (this.respawnTimer >= RESPAWN_SECONDS) this.reset();
    }

    const hp = Math.round(this.health.current);
    if (hp !== this.shownHealth || this.health.alive !== this.shownAlive) {
      this.shownHealth = hp;
      this.shownAlive = this.health.alive;
      this.labelDirty = true;
    }

    const spec = this.spec;
    let x = this.baseX;
    let y = this.baseY;
    let z = this.baseZ;

    switch (spec.behaviour) {
      case 'static':
      // An infinite dummy never moves: it exists to stand still and absorb a magazine.
      case 'infinite':
        break;
      case 'faller': {
        // Flat on its face while dead, upright otherwise. `RESPAWN_SECONDS` already stands
        // it back up, so this only has to express *falling* rather than own a timer.
        const down = this.health.alive ? 0 : 1;
        this.fallAmount += (down - this.fallAmount) * Math.min(1, DT * 7);
        this.group.rotation.x = -this.fallAmount * (Math.PI / 2);
        y = this.baseY - this.fallAmount * 0.05;
        break;
      }
      case 'popup': {
        const up = spec.upTime ?? 3;
        const down = spec.downTime ?? 2;
        const cycle = up + down;
        this.phase = (this.phase + DT) % cycle;
        // Rise, hold, drop. Downed targets stay down until they respawn.
        const raised = this.health.alive
          ? this.phase < up
            ? smoothstep(0, POPUP_TRANSITION, this.phase)
            : 1 - smoothstep(up, up + POPUP_TRANSITION, this.phase)
          : 0;
        y = this.baseY - POPUP_DEPTH * (1 - clamp01(raised));
        break;
      }
      case 'strafe': {
        const travel = spec.travel ?? 3;
        const speed = spec.speed ?? 2.6;
        this.strafeOffset += this.strafeDir * speed * DT;
        if (this.strafeOffset > travel) {
          this.strafeOffset = travel;
          this.strafeDir = -1;
        } else if (this.strafeOffset < -travel) {
          this.strafeOffset = -travel;
          this.strafeDir = 1;
        }
        // The path is fixed in world space along the target's own right vector.
        x = this.baseX + Math.cos(spec.yaw) * this.strafeOffset;
        z = this.baseZ - Math.sin(spec.yaw) * this.strafeOffset;
        break;
      }
    }

    this.currX = x;
    this.currY = y;
    this.currZ = z;
    // The rig tracks the *simulation* pose, not the interpolated render pose: a shot is
    // resolved on a tick, so it must be resolved against where the target is on that tick.
    this.rig.setTransform(x, y, z, this.spec.yaw);
  }

  /** Render pass: interpolate the pose and billboard the read-out. */
  updateVisual(alpha: number, cameraX: number, cameraY: number, cameraZ: number): void {
    this.group.position.set(
      this.prevX + (this.currX - this.prevX) * alpha,
      this.prevY + (this.currY - this.prevY) * alpha,
      this.prevZ + (this.currZ - this.prevZ) * alpha,
    );
    const visible = this.health.alive;
    if (this.body.visible !== visible) {
      this.body.visible = visible;
      this.head.visible = visible;
    }

    // The label lives inside the rotated group, so undo that rotation before facing the
    // camera; otherwise the dummy's own yaw fights the billboard.
    const dx = cameraX - this.group.position.x;
    const dz = cameraZ - this.group.position.z;
    this.label.rotation.y = Math.atan2(dx, dz) - this.spec.yaw;
    const dy = cameraY - (this.group.position.y + this.label.position.y);
    this.label.rotation.x = Math.atan2(dy, Math.hypot(dx, dz));

    if (this.labelDirty) {
      this.labelDirty = false;
      this.drawLabel();
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.group.clear();
  }

  private drawLabel(): void {
    const ctx = this.labelCtx;
    ctx.clearRect(0, 0, LABEL_W, LABEL_H);
    ctx.fillStyle = 'rgba(7,8,10,0.82)';
    ctx.fillRect(0, 0, LABEL_W, LABEL_H);
    ctx.strokeStyle = this.health.alive ? 'rgba(38,43,51,1)' : 'rgba(232,96,76,0.9)';
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, LABEL_W - 3, LABEL_H - 3);

    const family = 'ui-sans-serif, system-ui, Segoe UI, Roboto, Arial, sans-serif';

    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#626a77';
    ctx.font = `800 15px ${family}`;
    ctx.fillText(this.displayName.toUpperCase(), 12, 18);

    if (!this.health.alive) {
      ctx.fillStyle = '#e8604c';
      ctx.font = `800 34px ${family}`;
      ctx.fillText('DOWN', 12, 56);
      ctx.fillStyle = '#9aa1ad';
      ctx.font = `500 15px ${family}`;
      ctx.fillText(`TOTAL ${this.totalDamage.toFixed(1)}`, 12, 82);
      if (this.lastTtkSeconds >= 0) {
        ctx.fillStyle = '#ffb340';
        ctx.font = `800 15px ${family}`;
        ctx.fillText(`TTK ${this.lastTtkSeconds.toFixed(3)}s / ${this.lastShotsToKill}`, 108, 82);
      }
    } else {
      ctx.fillStyle = this.lastZone === 'head' ? '#ffb340' : '#e8eaee';
      ctx.font = `800 34px ${family}`;
      ctx.fillText(this.lastDamage > 0 ? this.lastDamage.toFixed(1) : '—', 12, 54);

      ctx.fillStyle = '#9aa1ad';
      ctx.font = `800 14px ${family}`;
      const zoneText = this.lastDamage > 0 ? this.lastZone.toUpperCase() : 'NO HITS';
      ctx.fillText(zoneText, 108, 48);
      ctx.fillStyle = '#626a77';
      ctx.font = `500 13px ${family}`;
      if (this.lastDamage > 0) ctx.fillText(`${this.lastDistance.toFixed(1)} m`, 108, 66);

      ctx.fillStyle = '#6fd08c';
      ctx.font = `800 15px ${family}`;
      // The infinite dummy reports sustained damage instead of a health bar it can never
      // lose — that is the whole reason it exists (M7).
      if (this.isInfinite) ctx.fillText(`DPS ${this.dps.toFixed(0)}`, 12, 82);
      else ctx.fillText(`HP ${Math.round(this.health.current)}`, 12, 82);
      ctx.fillStyle = '#626a77';
      ctx.font = `500 13px ${family}`;
      if (this.lastTtkSeconds >= 0) {
        ctx.fillText(`TTK ${this.lastTtkSeconds.toFixed(3)}s / ${this.lastShotsToKill}`, 92, 82);
      } else {
        ctx.fillText(`TOTAL ${this.totalDamage.toFixed(1)}`, 92, 82);
      }
    }

    this.labelTexture.needsUpdate = true;
  }

  /** Called by the range when health changed without a hit (regeneration). */
  markLabelDirty(): void {
    this.labelDirty = true;
  }
}

export interface DummyMaterials {
  readonly body: THREE.Material;
  readonly head: THREE.Material;
}

export function buildDummyMaterials(): DummyMaterials & { dispose(): void } {
  const body = new THREE.MeshLambertMaterial({ color: 0x59616e });
  const head = new THREE.MeshLambertMaterial({ color: 0x8a6a3c });
  return {
    body,
    head,
    dispose(): void {
      body.dispose();
      head.dispose();
    },
  };
}

/** The mesh IS the rig: same boxes, same offsets, no separate art to drift out of sync. */
function buildZoneGeometry(zones: readonly HitZone[]): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const box of HUMANOID_RIG.boxes) {
    if (!zones.includes(box.zone)) continue;
    const g = new THREE.BoxGeometry(box.sx, box.sy, box.sz);
    g.translate(box.ox, box.oy, box.oz);
    parts.push(g);
  }
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (merged === null) throw new Error('Failed to merge dummy geometry');
  merged.computeBoundingSphere();
  return merged;
}
