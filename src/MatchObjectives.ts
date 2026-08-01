import * as THREE from 'three';
import type { BotTeam } from './ai/Combatant';
import type { GameBus } from './core/Events';
import type { GameMode } from './modes/GameMode';
import { Domination } from './modes/Domination';
import { KillConfirmed } from './modes/KillConfirmed';
import { SearchAndDestroy } from './modes/SearchAndDestroy';
import type { ObjectiveZone } from './modes/ObjectiveZone';

/**
 * The objectives, as things you can see in the world (M7, brief S6.3).
 *
 * The brief asks for "objective capture progress rings, flag ownership indicators, dog tag
 * markers, bomb site indicators". Every one of those is a *world* object rather than a HUD
 * element, and that is a deliberate reading: a capture ring drawn on the HUD tells you a
 * number, and a capture ring drawn on the floor tells you **where to stand**. Domination is
 * decided by standing in the right circle, so the circle belongs on the ground.
 *
 * ## Cost
 *
 * Everything here is built once at construction and only ever *transformed* or recoloured
 * afterwards. Three flags is three poles, three banners and three rings — nine meshes with
 * shared geometry, updated by writing a scale and a colour. Dog tags come from a pool sized
 * to the roster, because a tag is dropped and collected several times a minute and allocating
 * a mesh per death is the kind of thing that shows up as a sawtooth in the heap harness.
 *
 * ## Why it reads the mode directly
 *
 * `MatchFeedback` and `MatchEquipment` are event-driven because what they present is
 * *momentary* — a hit, a flash, an explosion. Objective state is continuous: a flag is 40%
 * captured for a second and a half, and reconstructing that from events would mean mirroring
 * the mode's state machine here and keeping the two in step. So this asks the mode what is
 * true each frame, which is one source of truth rather than two.
 */

/** Neutral, friendly and enemy. The same three the minimap uses. */
const COLOR_NEUTRAL = 0xffb340;
const COLOR_FRIENDLY = 0x6fd08c;
const COLOR_ENEMY = 0xe8604c;

/** Height of a flag pole, metres. Tall enough to see over a container. */
const POLE_HEIGHT = 3.4;

export interface MatchObjectivesDeps {
  readonly bus: GameBus;
  readonly scene: THREE.Scene;
  readonly mode: GameMode;
  readonly localTeam: BotTeam;
}

interface FlagVisual {
  readonly zone: ObjectiveZone;
  readonly group: THREE.Group;
  readonly banner: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  readonly ring: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  readonly progressRing: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
}

interface TagVisual {
  readonly group: THREE.Group;
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  tagId: number;
  active: boolean;
}

export class MatchObjectives {
  readonly group = new THREE.Group();

  private readonly deps: MatchObjectivesDeps;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly flags: FlagVisual[] = [];
  private readonly tags: TagVisual[] = [];
  private readonly sites: FlagVisual[] = [];
  /** The planted bomb, shown only while one is down. */
  private readonly bomb: THREE.Group = new THREE.Group();
  private readonly bombLight: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private readonly unsubscribe: Array<() => void> = [];
  private spin = 0;

  constructor(deps: MatchObjectivesDeps) {
    this.deps = deps;
    this.group.name = 'objectives';

    const mode = deps.mode;
    if (mode instanceof Domination) {
      for (const zone of mode.zones) this.flags.push(this.buildFlag(zone, true));
    }
    if (mode instanceof SearchAndDestroy) {
      for (const site of mode.sites) this.sites.push(this.buildFlag(site, false));
      this.buildBomb();
    }
    if (mode instanceof KillConfirmed) this.buildTagPool();

    this.bombLight = this.bomb.children.find(isBasicMesh) ?? this.buildFallbackLight();
    deps.scene.add(this.group);
  }

  /**
   * Per frame. Presentation only: nothing here may change what the mode believes.
   *
   * `dt` is a real frame delta, which is legitimate because every use of it is a spin or a
   * pulse — no gameplay value is integrated here (S4.1).
   */
  update(dt: number): void {
    this.spin = (this.spin + dt * 0.9) % (Math.PI * 2);
    const mode = this.deps.mode;

    for (const flag of this.flags) this.updateZone(flag, dt);
    for (const site of this.sites) this.updateZone(site, dt);

    if (mode instanceof KillConfirmed) this.updateTags(mode);
    if (mode instanceof SearchAndDestroy) this.updateBomb(mode);
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.deps.scene.remove(this.group);
    this.group.clear();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  // -- flags and bomb sites ---------------------------------------------------

  /**
   * A pole, a banner and two rings on the floor.
   *
   * The outer ring is the capture radius — it is exactly `zone.def.radius`, so what you see is
   * what the occupancy test uses and the two cannot drift. The inner one is the progress arc,
   * grown by scaling rather than by rebuilding geometry every frame.
   */
  private buildFlag(zone: ObjectiveZone, withPole: boolean): FlagVisual {
    const group = new THREE.Group();
    const p = zone.def.position;
    group.position.set(p.x, p.y, p.z);

    const bannerMat = new THREE.MeshStandardMaterial({
      color: COLOR_NEUTRAL,
      roughness: 0.85,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    const ringMat = new THREE.MeshBasicMaterial({
      color: COLOR_NEUTRAL,
      transparent: true,
      opacity: 0.5,
      // Flat on the floor: writing depth would make it z-fight with the slab it sits on.
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const progressMat = new THREE.MeshBasicMaterial({
      color: COLOR_NEUTRAL,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.disposables.push(bannerMat, ringMat, progressMat);

    if (withPole) {
      const poleGeo = new THREE.CylinderGeometry(0.045, 0.055, POLE_HEIGHT, 6);
      const poleMat = new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.7, metalness: 0.3 });
      this.disposables.push(poleGeo, poleMat);
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.y = POLE_HEIGHT * 0.5;
      pole.castShadow = true;
      group.add(pole);
    }

    const bannerGeo = new THREE.PlaneGeometry(0.95, 0.62);
    this.disposables.push(bannerGeo);
    const banner = new THREE.Mesh(bannerGeo, bannerMat);
    banner.position.set(0.5, withPole ? POLE_HEIGHT - 0.55 : 1.6, 0);
    group.add(banner);

    // 1 cm off the floor, never coplanar with it — the same rule M1 used for lane markers.
    const ringGeo = new THREE.RingGeometry(zone.def.radius - 0.12, zone.def.radius, 40);
    this.disposables.push(ringGeo);
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.01;
    group.add(ring);

    const progressGeo = new THREE.RingGeometry(0.35, zone.def.radius - 0.25, 40);
    this.disposables.push(progressGeo);
    const progressRing = new THREE.Mesh(progressGeo, progressMat);
    progressRing.rotation.x = -Math.PI / 2;
    progressRing.position.y = 0.02;
    progressRing.visible = false;
    group.add(progressRing);

    this.group.add(group);
    return { zone, group, banner, ring, progressRing };
  }

  private updateZone(flag: FlagVisual, dt: number): void {
    const zone = flag.zone;
    const colour = this.colourFor(zone.owner);
    flag.banner.material.color.setHex(colour);
    flag.ring.material.color.setHex(colour);

    // A contested zone pulses, which is the one state worth noticing from across the map.
    const pulse = zone.contested ? 0.5 + Math.sin(this.spin * 6) * 0.3 : 0.5;
    flag.ring.material.opacity = pulse;

    const active = zone.progress > 0.001 && zone.capturingTeam !== 'NONE';
    flag.progressRing.visible = active;
    if (active) {
      flag.progressRing.material.color.setHex(this.colourFor(zone.capturingTeam));
      // Grown by scale rather than rebuilt: a new RingGeometry every frame would allocate
      // and upload, which is the exact opposite of what a progress ring should cost.
      const s = 0.2 + zone.progress * 0.8;
      flag.progressRing.scale.set(s, s, 1);
      flag.progressRing.material.opacity = 0.85;
    }
    // A held flag flies its banner; a neutral one droops. Cheap, and it reads at a glance.
    const target = zone.owner === 'NONE' ? -0.5 : 0;
    flag.banner.rotation.z += (target - flag.banner.rotation.z) * Math.min(1, dt * 6);
  }

  private colourFor(team: BotTeam | 'NONE'): number {
    if (team === 'NONE') return COLOR_NEUTRAL;
    return team === this.deps.localTeam ? COLOR_FRIENDLY : COLOR_ENEMY;
  }

  // -- dog tags ---------------------------------------------------------------

  /**
   * A pool of tags, sized generously and reused.
   *
   * Kill Confirmed drops one per death and a busy match kills several times a second, so a
   * mesh per tag would be a steady allocation in the middle of a firefight.
   */
  private buildTagPool(): void {
    const geo = new THREE.BoxGeometry(0.16, 0.24, 0.02);
    const chainGeo = new THREE.TorusGeometry(0.07, 0.008, 4, 10);
    this.disposables.push(geo, chainGeo);
    for (let i = 0; i < 24; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: COLOR_ENEMY, toneMapped: false });
      this.disposables.push(mat);
      const group = new THREE.Group();
      const mesh = new THREE.Mesh(geo, mat);
      group.add(mesh);
      const chain = new THREE.Mesh(chainGeo, mat);
      chain.position.y = 0.19;
      chain.rotation.x = Math.PI / 2;
      group.add(chain);
      group.visible = false;
      this.group.add(group);
      this.tags.push({ group, mesh, tagId: -1, active: false });
    }
  }

  /**
   * Show one visual per live tag.
   *
   * Matched by id rather than by index so a tag collected out of order does not make every
   * later tag jump position for a frame.
   */
  private updateTags(mode: KillConfirmed): void {
    for (const visual of this.tags) visual.active = false;

    for (const tag of mode.tags) {
      let visual = this.tags.find((v) => v.tagId === tag.id);
      if (visual === undefined) visual = this.tags.find((v) => !v.active && v.tagId < 0);
      if (visual === undefined) visual = this.tags.find((v) => !v.active);
      if (visual === undefined) continue;

      visual.tagId = tag.id;
      visual.active = true;
      visual.group.visible = true;
      // Bob and spin: a tag lying flat on a grey floor is invisible, and the whole mode is
      // built on noticing them.
      visual.group.position.set(tag.x, tag.y + 0.12 + Math.sin(this.spin * 2.2 + tag.id) * 0.07, tag.z);
      visual.group.rotation.y = this.spin * 1.6 + tag.id;
      // Friendly tags deny, enemy tags score — so they must be told apart instantly.
      visual.mesh.material.color.setHex(
        tag.team === this.deps.localTeam ? COLOR_FRIENDLY : COLOR_ENEMY,
      );
      // The last three seconds blink, which is the only warning it is about to evaporate.
      visual.group.visible = tag.life > 3 || Math.sin(this.spin * 14) > -0.2;
    }

    for (const visual of this.tags) {
      if (visual.active) continue;
      visual.group.visible = false;
      visual.tagId = -1;
    }
  }

  // -- the bomb ---------------------------------------------------------------

  private buildBomb(): void {
    const bodyGeo = new THREE.BoxGeometry(0.42, 0.26, 0.3);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x23282f, roughness: 0.7, metalness: 0.25 });
    const lightGeo = new THREE.SphereGeometry(0.05, 8, 6);
    const lightMat = new THREE.MeshBasicMaterial({ color: COLOR_ENEMY, toneMapped: false });
    this.disposables.push(bodyGeo, bodyMat, lightGeo, lightMat);

    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 0.13;
    body.castShadow = true;
    this.bomb.add(body);
    const light = new THREE.Mesh(lightGeo, lightMat);
    light.position.set(0, 0.3, 0);
    this.bomb.add(light);
    this.bomb.visible = false;
    this.group.add(this.bomb);
  }

  private buildFallbackLight(): THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> {
    const geo = new THREE.SphereGeometry(0.01, 4, 3);
    const mat = new THREE.MeshBasicMaterial({ color: COLOR_ENEMY });
    this.disposables.push(geo, mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    this.group.add(mesh);
    return mesh;
  }

  /**
   * The planted bomb, and the light that tells you how long is left.
   *
   * Blink rate accelerates as the timer runs down — the same trick a real fuse uses, and the
   * only information the player has from across a site without looking at the HUD.
   */
  private updateBomb(mode: SearchAndDestroy): void {
    const site = mode.plantedSite;
    const planted = mode.bomb === 'PLANTED' && site !== null;
    this.bomb.visible = planted;
    if (!planted || site === null) return;

    const p = site.def.position;
    this.bomb.position.set(p.x, p.y, p.z);
    const fraction = mode.bombSecondsLeft / Math.max(1, mode.config.bombTimerSeconds);
    const rate = 3 + (1 - fraction) * 18;
    this.bombLight.visible = Math.sin(this.spin * rate) > -0.1;
  }
}

function isBasicMesh(o: THREE.Object3D): o is THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> {
  return o instanceof THREE.Mesh && o.material instanceof THREE.MeshBasicMaterial;
}
