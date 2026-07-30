import * as THREE from 'three';
import type { Match } from '../Match';
import { DEG2RAD } from '../core/MathUtil';
import { makeMoveOutput, type MoveOutput } from '../world/CollisionWorld';
import type { EquipmentConfig } from '../equipment/EquipmentConfig';
import { EQUIPMENT_TUNABLES, EQUIPMENT_CONFIG_KEYS, equipmentConfigToSource } from '../equipment/EquipmentConfig';
import { ALL_EQUIPMENT, equipmentDef, type EquipmentId } from '../equipment/EquipmentDefs';
import { previewTrajectory } from '../equipment/Projectile';
import type { DebugOverlay, DebugSection } from './DebugOverlay';
import { makeTuningGroup } from './TuningPanel';

/**
 * The M5 equipment panel (brief S7).
 *
 * Three visualisations the brief asks for by name, plus the sliders:
 *
 *  - **Grenade trajectory preview.** A polyline through the *real* integrator against the
 *    *real* collision world, drawn from the player's eye along their aim. It is the same
 *    function the bots' safety check uses, so what the line shows and where a grenade goes
 *    cannot disagree.
 *  - **Smoke-volume occlusion, with the affected LOS rays highlighted.** Every live sight
 *    line between opposing combatants is drawn, green when it is clear and red when the
 *    smoke field rejected it — which is acceptance criterion 6, visible rather than
 *    asserted.
 *  - **The flash angle report.** The effect magnitude at 0, 45, 90 and 180 degrees, read
 *    out of the same `intensityFor` the flash itself uses.
 *
 * The geometry is preallocated and rewritten in place, the way `CollisionDebug` and
 * `AiDebug` are: toggling a visualiser on must not change the allocation behaviour of the
 * frame it is measuring.
 */

const PREVIEW_POINTS = 220;
const MAX_LOS_RAYS = 96;

export class EquipmentPanel {
  readonly group = new THREE.Group();

  private readonly section: DebugSection;
  private readonly flashLine: HTMLElement;
  private readonly smokeLine: HTMLElement;
  private readonly poolLine: HTMLElement;
  private readonly botLine: HTMLElement;

  private readonly trajectory: THREE.Line;
  private readonly trajectoryPositions: Float32Array;
  private readonly losSegments: THREE.LineSegments;
  private readonly losPositions: Float32Array;
  private readonly losColours: Float32Array;
  private readonly smokeShells: THREE.LineSegments;
  private readonly smokePositions: Float32Array;

  private readonly preview = new Float32Array(PREVIEW_POINTS * 3);
  private readonly move: MoveOutput = makeMoveOutput();
  private readonly disposables: Array<{ dispose(): void }> = [];

  private showTrajectory = false;
  private showOcclusion = false;
  private previewId: EquipmentId = 'frag';

  constructor(
    overlay: DebugOverlay,
    private readonly match: Match,
    private readonly cfg: EquipmentConfig,
  ) {
    this.group.name = 'debug:equipment';
    this.group.visible = false;

    this.section = overlay.section('Equipment');
    this.flashLine = this.note();
    this.smokeLine = this.note();
    this.poolLine = this.note();
    this.botLine = this.note();

    this.section.element.appendChild(this.buildControls());

    // ---- world-space geometry ---------------------------------------------
    this.trajectoryPositions = new Float32Array(PREVIEW_POINTS * 3);
    const trajectoryGeometry = new THREE.BufferGeometry();
    trajectoryGeometry.setAttribute('position', new THREE.BufferAttribute(this.trajectoryPositions, 3));
    trajectoryGeometry.setDrawRange(0, 0);
    const trajectoryMaterial = new THREE.LineBasicMaterial({ color: 0xffb340, depthTest: false });
    this.trajectory = new THREE.Line(trajectoryGeometry, trajectoryMaterial);
    this.trajectory.renderOrder = 998;
    this.trajectory.frustumCulled = false;
    this.group.add(this.trajectory);
    this.disposables.push(trajectoryGeometry, trajectoryMaterial);

    this.losPositions = new Float32Array(MAX_LOS_RAYS * 6);
    this.losColours = new Float32Array(MAX_LOS_RAYS * 6);
    const losGeometry = new THREE.BufferGeometry();
    losGeometry.setAttribute('position', new THREE.BufferAttribute(this.losPositions, 3));
    losGeometry.setAttribute('color', new THREE.BufferAttribute(this.losColours, 3));
    losGeometry.setDrawRange(0, 0);
    const losMaterial = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false });
    this.losSegments = new THREE.LineSegments(losGeometry, losMaterial);
    this.losSegments.renderOrder = 998;
    this.losSegments.frustumCulled = false;
    this.group.add(this.losSegments);
    this.disposables.push(losGeometry, losMaterial);

    // One wire ring per smoke volume, so the density boundary the occluder integrates
    // against is visible rather than inferred from the billboards.
    this.smokePositions = new Float32Array(8 * 64 * 6);
    const shellGeometry = new THREE.BufferGeometry();
    shellGeometry.setAttribute('position', new THREE.BufferAttribute(this.smokePositions, 3));
    shellGeometry.setDrawRange(0, 0);
    const shellMaterial = new THREE.LineBasicMaterial({ color: 0x5aa2e8, depthTest: false });
    this.smokeShells = new THREE.LineSegments(shellGeometry, shellMaterial);
    this.smokeShells.renderOrder = 997;
    this.smokeShells.frustumCulled = false;
    this.group.add(this.smokeShells);
    this.disposables.push(shellGeometry, shellMaterial);

    // Live sliders for every equipment constant, with COPY CONFIG writing them back out
    // as source (S7). Same generated panel every other config in the project uses.
    overlay.addTuningGroup(
      makeTuningGroup(
        'Equipment',
        this.cfg,
        EQUIPMENT_TUNABLES,
        EQUIPMENT_CONFIG_KEYS,
        { ...this.cfg },
        equipmentConfigToSource,
      ),
      () => undefined,
    );

    overlay.addTextHook(() => this.refresh());
  }

  /** Per-frame. Cheap when both visualisations are off: one branch and a return. */
  update(): void {
    this.group.visible = this.showTrajectory || this.showOcclusion;
    if (!this.group.visible) return;
    this.updateTrajectory();
    this.updateOcclusion();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.group.clear();
    this.section.element.replaceChildren();
  }

  // -- internals -------------------------------------------------------------

  private note(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'dbg-note';
    this.section.element.appendChild(el);
    return el;
  }

  private buildControls(): HTMLElement {
    const wrap = document.createElement('div');

    const toggles = document.createElement('div');
    toggles.className = 'dbg-chips';
    toggles.appendChild(
      this.toggle('Trajectory preview', () => {
        this.showTrajectory = !this.showTrajectory;
        return this.showTrajectory;
      }),
    );
    toggles.appendChild(
      this.toggle('Smoke occlusion', () => {
        this.showOcclusion = !this.showOcclusion;
        return this.showOcclusion;
      }),
    );
    wrap.appendChild(toggles);

    const picker = document.createElement('div');
    picker.className = 'dbg-chips dbg-chips--wrap';
    for (const def of ALL_EQUIPMENT) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'dbg-chip';
      chip.textContent = def.name;
      chip.dataset['equipment'] = def.id;
      chip.addEventListener('click', () => {
        this.previewId = def.id;
        // Equipping the picked item is the useful behaviour: the preview is for aiming a
        // throw, and a preview of something you are not holding is a diagram.
        const inv = this.match.equipment.inventory;
        if (def.slot === 'lethal') inv.lethal = def.id;
        else inv.tactical = def.id;
        for (const other of Array.from(picker.children)) {
          if (other instanceof HTMLElement) {
            other.classList.toggle('is-on', other.dataset['equipment'] === def.id);
          }
        }
      });
      chip.classList.toggle('is-on', def.id === this.previewId);
      picker.appendChild(chip);
    }
    wrap.appendChild(picker);

    return wrap;
  }

  private toggle(label: string, onClick: () => boolean): HTMLElement {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'dbg-chip';
    chip.textContent = label;
    chip.addEventListener('click', () => {
      chip.classList.toggle('is-on', onClick());
    });
    return chip;
  }

  /**
   * The arc a throw would take from where the player is standing and looking, right now.
   *
   * `previewTrajectory` is the same function `BotThrower` uses to decide whether a throw is
   * safe, and it steps the same integration `Projectile.step` does — so this line is not an
   * approximation of the grenade, it is the grenade.
   */
  private updateTrajectory(): void {
    const geometry = this.trajectory.geometry;
    if (!this.showTrajectory) {
      geometry.setDrawRange(0, 0);
      return;
    }
    const sim = this.match.playerSim;
    const def = equipmentDef(this.previewId);
    const yaw = sim.yaw;
    const pitch = sim.pitch;
    const loft = pitch + def.throwLoftDeg * DEG2RAD;
    const cp = Math.cos(loft);
    const sp = Math.sin(loft);
    const dx = -Math.sin(yaw) * cp;
    const dy = sp;
    const dz = -Math.cos(yaw) * cp;
    const speed = def.throwSpeed;
    const cfg = this.cfg;

    const count = previewTrajectory(
      def,
      cfg,
      this.match.world,
      sim.x + dx * cfg.throwOffsetForward,
      sim.y + sim.eyeHeight + cfg.throwOffsetUp + dy * cfg.throwOffsetForward,
      sim.z + dz * cfg.throwOffsetForward,
      dx * speed,
      dy * speed,
      dz * speed,
      4.5,
      this.preview,
      this.move,
    );

    for (let i = 0; i < count * 3; i++) this.trajectoryPositions[i] = this.preview[i] ?? 0;
    geometry.setDrawRange(0, count);
    markDirty(geometry, 'position');
  }

  /**
   * Every live sight line between opposing combatants, coloured by whether smoke stopped
   * it. Red segments are acceptance criterion 6 happening.
   */
  private updateOcclusion(): void {
    const geometry = this.losSegments.geometry;
    const shellGeometry = this.smokeShells.geometry;
    if (!this.showOcclusion) {
      geometry.setDrawRange(0, 0);
      shellGeometry.setDrawRange(0, 0);
      return;
    }

    const smoke = this.match.equipment.system.smoke;
    const roster = this.match.bots.roster;
    let v = 0;

    for (const a of roster) {
      if (!a.participating) continue;
      for (const b of roster) {
        if (b === a || b.team === a.team || !b.participating) continue;
        if (v + 6 > this.losPositions.length) break;
        const ax = a.px;
        const ay = a.py + a.eyeHeight;
        const az = a.pz;
        const bx = b.px;
        const by = b.py + b.aimHeight;
        const bz = b.pz;
        const depth = smoke.opticalDepth(ax, ay, az, bx, by, bz);
        const blocked = depth >= this.cfg.smokeBlockDepth;
        // Brightness carries the optical depth, so a line that is *nearly* blocked reads
        // differently from one in clear air — which is the whole argument for a
        // density-based occluder over a sphere test.
        const t = Math.min(1, depth / Math.max(this.cfg.smokeBlockDepth, 1e-3));
        const r = blocked ? 0.95 : 0.25 + t * 0.6;
        const g = blocked ? 0.2 : 0.85 - t * 0.5;
        const bl = blocked ? 0.18 : 0.3;

        this.losPositions[v] = ax;
        this.losPositions[v + 1] = ay;
        this.losPositions[v + 2] = az;
        this.losColours[v] = r;
        this.losColours[v + 1] = g;
        this.losColours[v + 2] = bl;
        this.losPositions[v + 3] = bx;
        this.losPositions[v + 4] = by;
        this.losPositions[v + 5] = bz;
        this.losColours[v + 3] = r;
        this.losColours[v + 4] = g;
        this.losColours[v + 5] = bl;
        v += 6;
      }
    }

    geometry.setDrawRange(0, v / 3);
    markDirty(geometry, 'position');
    markDirty(geometry, 'color');

    // Smoke shells: one horizontal ring per live volume, at its current radius.
    let s = 0;
    const SEGMENTS = 32;
    for (const volume of smoke.volumes) {
      if (!volume.active) continue;
      const radius = smoke.currentRadius(volume);
      for (let i = 0; i < SEGMENTS; i++) {
        if (s + 6 > this.smokePositions.length) break;
        const a0 = (i / SEGMENTS) * Math.PI * 2;
        const a1 = ((i + 1) / SEGMENTS) * Math.PI * 2;
        this.smokePositions[s] = volume.x + Math.cos(a0) * radius;
        this.smokePositions[s + 1] = volume.y;
        this.smokePositions[s + 2] = volume.z + Math.sin(a0) * radius;
        this.smokePositions[s + 3] = volume.x + Math.cos(a1) * radius;
        this.smokePositions[s + 4] = volume.y;
        this.smokePositions[s + 5] = volume.z + Math.sin(a1) * radius;
        s += 6;
      }
    }
    shellGeometry.setDrawRange(0, s / 3);
    markDirty(shellGeometry, 'position');
  }

  private refresh(): void {
    const equipment = this.match.equipment;
    const system = equipment.system;
    const flash = system.flash;

    // Criterion 7, evaluated rather than described: the same curve the flash applies.
    const radius = equipmentDef('flashbang').effectRadius;
    const at = (deg: number): string => flash.intensityFor(deg, 0, radius, true).toFixed(3);
    this.flashLine.textContent =
      `FLASH by angle (point blank, LOS)  0°=${at(0)}  45°=${at(45)}  90°=${at(90)}  180°=${at(180)}\n` +
      `  no LOS at 0° = ${flash.intensityFor(0, 0, radius, false).toFixed(3)}` +
      `  ·  half range at 0° = ${flash.intensityFor(0, radius * 0.5, radius, true).toFixed(3)}` +
      `  ·  affected now = ${flash.affectedCount}`;

    const smoke = system.smoke;
    this.smokeLine.textContent =
      `SMOKE volumes ${smoke.liveCount}  ·  sight queries ${smoke.totalQueries}  ` +
      `·  blocked ${smoke.blockedQueries}  ·  perception rejections ${this.match.bots.perception.smokeBlocked}`;

    this.poolLine.textContent =
      `PROJECTILES live ${system.projectiles.liveCount}/${system.projectiles.items.length}  ` +
      `·  thrown ${system.thrownTotal}  ·  detonated ${system.detonatedTotal}  ` +
      `·  equipment ms ${equipment.lastMs.toFixed(3)}`;

    const bot = equipment.botThrower;
    this.botLine.textContent =
      `BOT THROWS ${bot.throws}  ·  rejected as unsafe ${bot.rejectedUnsafe}  ` +
      `·  player lethal ${equipment.inventory.lethalCount} / tactical ${equipment.inventory.tacticalCount}`;
  }
}

function markDirty(geometry: THREE.BufferGeometry, name: string): void {
  const attribute = geometry.getAttribute(name);
  if (attribute !== undefined) attribute.needsUpdate = true;
}
