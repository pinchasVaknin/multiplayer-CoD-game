import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp01, lerp } from '../../shared/core/MathUtil';
import { HUMANOID_RIG, type HitZone } from '../../shared/combat/HitboxRig';
import {
  AMPLITUDE_RESPONSE,
  ARM_PITCH,
  advanceGaitPhase,
  gaitAmplitude,
  gaitAt,
  LEG_PIVOT_Y,
} from '../../shared/ai/Gait';
import { palette } from '../ui/Palette';
import type { BotTeam } from '../../shared/ai/Combatant';
import { DEATH_VARIANTS, type ActorAnimationInput } from '../../shared/ai/BotVisualState';
import type { ActorAvatar, TeamVisualTint } from '../characters/ActorAvatar';

/**
 * A bot's body, and the way it dies (brief S6.8; playtest round 5, F4).
 *
 * ## The mesh was the rig, and now it is the rig plus an animation
 *
 * Until round 5 this file could say *"the mesh IS the rig: the boxes drawn here are the boxes
 * a round is tested against, so what you can hit is what you can see"*, and that sentence is
 * rewritten rather than left standing, because F4 required breaking it in one direction.
 *
 * **The head and the torso are still exactly the rig.** They are the two boxes a fight is
 * decided by, and nothing here moves them by a millimetre.
 *
 * **The arms and the legs are not, and that is the decision.** The legs swing about their hips
 * and the arms are pitched forward onto the weapon, while `HitboxRig` keeps both boxes upright
 * where it always had them. F4 states the rule plainly — *"if the legs move and the hitbox does
 * not, that is correct"* — and the reason it is correct is that a hitbox that followed a
 * cosmetic animation would be a cosmetic deciding gameplay, which is the §4.15 line. The rig
 * takes yaw and a stance scale and nothing else, deliberately, and that has not changed.
 *
 * The cost is a real one and it is published rather than described: `npm run readability`
 * prints how far each drawn limb gets from its box over a whole gait cycle. It lands on the
 * arm and leg zones, which `HitboxRig`'s own comment calls *"the silhouette edges where a
 * sloppy spray lands"* — the two zones with the lowest multipliers in the game.
 *
 * ## What the report was, and what it turned out to be
 *
 * F4 read *"a torso box and a head. No arms, no legs, no walk cycle, no weapon in the hands."*
 * Two thirds of that was already false in the tree: `HUMANOID_RIG` has had `armL`, `armR`,
 * `legL` and `legR` since M2 and this file has drawn all four since M3 — welded into **one
 * static mesh** with the torso, with the two leg boxes four centimetres apart, which is
 * 1.1 px at twenty metres. Limbs that cannot move and cannot be told apart are limbs nobody
 * sees. They are separate nodes now, and the legs are driven by `shared/ai/Gait.ts`.
 *
 * The weapon was real and was worse than absent: five hand-typed boxes, identical on every
 * bot no matter what `drawBotWeapon` dealt them — the third description of what a rifle looks
 * like, after the one round 4's F15 deleted. It comes from `buildHeldWeaponGeometry` now,
 * through the same `WeaponModelSpec` the viewmodel and the killfeed glyph are built from.
 *
 * The one piece of geometry here that is still not a hitbox and never was is the chest rig and
 * the visor plate, which exist so a silhouette is not a bare stack of boxes and so you can
 * tell at a glance which way a bot is facing.
 *
 * **Ragdoll-lite death.** S6.8 asks for an impulse-driven fall taken from the killing hit,
 * in three or four variants, with no physics library — so it is a scripted fall with
 * damped rotation about the feet. Pivoting at the feet is what makes it work without a
 * solver: a body rotated 90 degrees about its own feet is already lying on the floor, so
 * there is nothing to resolve against the ground and nothing to sink through it. The
 * damping term is a decaying sine, which is the whole reason it does not look like a door
 * closing — the body arrives, settles past, and comes back.
 *
 * Flinch is the same trick at 1/20th the scale on a 0.18 s decay.
 */

/** Seconds the fall takes to settle. The body stays put afterwards until respawn. */
const FALL_SECONDS = 1.05;

/** How far a killing hit can shove a body along its own direction, metres. */
const MAX_SHOVE = 0.55;

const FLINCH_SECONDS = 0.18;
const FLINCH_ANGLE = 0.075;

/**
 * Where the weapon sits, in rig-local metres, and it is authored against the arm pose above.
 *
 * The hands end up near (0, 0.94, -0.32) at `ARM_PITCH`; the weapon's origin is the centre of
 * its receiver, so it sits a little above and behind them. Held **level** rather than dipped
 * into a low ready: a bot spends much of a match shooting, `WeaponSystem` gives this file no
 * firing pose to switch to, and a muzzle pointing at the floor during a firefight is a worse
 * lie than one pointing where the body is facing.
 */
const WEAPON_OFFSET = { x: 0.04, y: 1.02, z: -0.3 } as const;

/**
 * Everything every body on the map shares: four materials and four geometries.
 *
 * The geometries are new in round 5 and they are the answer to F4's cost note. Before it,
 * `BotMesh`'s constructor called `buildZoneGeometry` twice and `buildGearGeometry` once **per
 * bot** — ten bodies merging and uploading ten identical copies of the same boxes. Splitting
 * the legs out would have made that thirty. They are built once here and referenced by every
 * mesh, which is what pays for the extra nodes: the draw calls go from three per body to six,
 * and the geometry uploads go from thirty to four for the whole roster.
 *
 * Instancing was considered and refused. One `InstancedMesh` per team would fold the legs into
 * two draw calls, but every limb's world matrix would then have to be composed on the CPU and
 * re-uploaded each frame — and the scene graph is already composing the death fall, the flinch
 * lean, the stance scale and the gait correctly, for free, in the right order. Trading that for
 * draw calls nobody has shown to be the bottleneck is the wrong trade until a frame report says
 * otherwise. It is written down here so the next person has the argument rather than the guess.
 */
export interface BotAssets {
  readonly bodyA: THREE.Material;
  readonly bodyB: THREE.Material;
  readonly headA: THREE.Material;
  readonly headB: THREE.Material;
  /**
   * The everybody-is-an-enemy set (post-M8).
   *
   * Free-for-All has no teams, so the two-silhouette scheme below is not merely unhelpful
   * there — it is a lie: half the lobby was drawn in the colour the player's own side wears,
   * and playtesting reported exactly that as "bot colours are mixed". In FFA every bot wears
   * this instead, so "not me" and "shoot it" are the same reading.
   */
  readonly bodyHostile: THREE.Material;
  readonly headHostile: THREE.Material;
  readonly gear: THREE.Material;

  /** Torso and arms, merged. The arms carry `ARM_PITCH` baked in; the torso is the rig. */
  readonly bodyGeometry: THREE.BufferGeometry;
  readonly headGeometry: THREE.BufferGeometry;
  /** Chest rig and visor. The only geometry here that is not a hitbox. */
  readonly gearGeometry: THREE.BufferGeometry;
  /** One leg, built with the hip pivot at its own origin so both legs share it. */
  readonly legGeometry: THREE.BufferGeometry;

  dispose(): void;
}

export function buildBotAssets(): BotAssets {
  // Two silhouettes that separate at a glance in grey-box lighting without either team
  // reading as "the enemy" by colour alone: cool slate versus warm sand.
  const bodyA = new THREE.MeshLambertMaterial({ color: 0x4a5a72 });
  const bodyB = new THREE.MeshLambertMaterial({ color: 0x6e5a44 });
  const headA = new THREE.MeshLambertMaterial({ color: 0x8a6a3c });
  const headB = new THREE.MeshLambertMaterial({ color: 0x8a6a3c });
  /**
   * Hostile orange, taken from the live palette rather than written here.
   *
   * That is what makes it move with colourblind mode: the minimap dot, the killfeed row and
   * the body in front of you are then all the same colour by construction, which is the whole
   * argument in `ui/Palette.ts`. Darkened toward the body's own value rather than used raw —
   * a fully saturated HUD orange on a Lambert surface under Depot's mast lights reads as a
   * light source rather than as a person.
   */
  const bodyHostile = new THREE.MeshLambertMaterial({ color: hostileBody() });
  const headHostile = new THREE.MeshLambertMaterial({ color: hostileHead() });
  const gear = new THREE.MeshLambertMaterial({ color: 0x1d2026 });

  const bodyGeometry = buildBodyGeometry();
  const headGeometry = buildZoneGeometry(['head']);
  const gearGeometry = buildGearGeometry();
  const legGeometry = buildLegGeometry();

  const repaint = palette.onChange(() => {
    bodyHostile.color.setHex(hostileBody());
    headHostile.color.setHex(hostileHead());
  });

  return {
    bodyA,
    bodyB,
    headA,
    headB,
    bodyHostile,
    headHostile,
    gear,
    bodyGeometry,
    headGeometry,
    gearGeometry,
    legGeometry,
    dispose(): void {
      repaint();
      bodyA.dispose();
      bodyB.dispose();
      headA.dispose();
      headB.dispose();
      bodyHostile.dispose();
      headHostile.dispose();
      gear.dispose();
      bodyGeometry.dispose();
      headGeometry.dispose();
      gearGeometry.dispose();
      legGeometry.dispose();
    },
  };
}

/** The palette's hostile colour, pulled down so a body is lit rather than glowing. */
function hostileBody(): number {
  return mixToward(palette.current.hostile, 0x14171c, 0.42);
}

/** A shade brighter than the body, so the head still reads as the head. */
function hostileHead(): number {
  return mixToward(palette.current.hostile, 0x14171c, 0.24);
}

function mixToward(colour: number, target: number, amount: number): number {
  const r = Math.round((((colour >> 16) & 0xff) * (1 - amount)) + (((target >> 16) & 0xff) * amount));
  const g = Math.round((((colour >> 8) & 0xff) * (1 - amount)) + (((target >> 8) & 0xff) * amount));
  const b = Math.round(((colour & 0xff) * (1 - amount)) + ((target & 0xff) * amount));
  return (r << 16) | (g << 8) | b;
}

export class BotMesh implements ActorAvatar {
  readonly group = new THREE.Group();

  private readonly body: THREE.Mesh;
  private readonly head: THREE.Mesh;
  private readonly gear: THREE.Mesh;
  /** Hip nodes. The geometry hangs below each one, so a rotation here is a hip rotation. */
  private readonly legL = new THREE.Group();
  private readonly legR = new THREE.Group();
  /** The weapon in the hands. Null until the renderer knows which one this body carries. */
  private weapon: THREE.Mesh | null = null;
  private weaponId: string | null = null;

  private readonly quat = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3();
  private readonly spinQuat = new THREE.Quaternion();
  private static readonly upAxis = new THREE.Vector3(0, 1, 0);

  private dying = false;
  private deathTime = 0;
  private variant = 0;
  private fallX = 0;
  private fallZ = 1;
  private shove = 0;
  private flinchTime = 0;
  private flinchX = 0;
  private flinchZ = 0;

  /**
   * The gait, integrated from the ground this body was drawn to cover.
   *
   * `seeded` is what keeps a respawn from being read as a sprint: the first frame after a
   * teleport has no meaningful previous position, so the delta is dropped rather than divided
   * by `dt`. `endDeath` clears it, which is the same signal the renderer already uses.
   */
  private phase = 0;
  private amplitude = 0;
  private lastX = 0;
  private lastZ = 0;
  private seeded = false;

  /**
   * `hostile` forces the everybody-is-an-enemy look regardless of substrate side (post-M8).
   *
   * Decided at construction rather than per frame because it cannot change during a match:
   * a mode is Free-for-All or it is not. `BotDirector` passes its own `freeForAll`, which
   * `Match` has already set from the registry entry by the time the roster is populated.
   */
  constructor(team: BotTeam, assets: BotAssets, hostile = false) {
    const skin = hostile ? assets.bodyHostile : team === 'A' ? assets.bodyA : assets.bodyB;
    this.body = new THREE.Mesh(assets.bodyGeometry, skin);
    this.head = new THREE.Mesh(
      assets.headGeometry,
      hostile ? assets.headHostile : team === 'A' ? assets.headA : assets.headB,
    );
    this.gear = new THREE.Mesh(assets.gearGeometry, assets.gear);

    /**
     * The hips, at the top face of each leg box.
     *
     * `LEG_PIVOT_Y` comes from `Gait`, which reads it off `HUMANOID_RIG` — so the node the leg
     * turns about and the box a shot is tested against are the same number, and a change to
     * the rig's proportions moves both. The x offsets are the boxes' own, which is what keeps
     * the legs where the hitboxes are while the swing takes them away from it.
     */
    for (const [node, sign] of [
      [this.legL, -1],
      [this.legR, 1],
    ] as const) {
      const mesh = new THREE.Mesh(assets.legGeometry, skin);
      mesh.castShadow = true;
      node.position.set(sign * LEG_OFFSET_X, LEG_PIVOT_Y, 0);
      node.add(mesh);
    }

    this.body.castShadow = true;
    this.head.castShadow = true;
    this.gear.castShadow = true;
    this.group.add(this.body, this.head, this.gear, this.legL, this.legR);
  }

  /**
   * Put a weapon in this body's hands, or take it away.
   *
   * The geometry is owned and cached by `BotRenderer` — ten bots carrying four distinct
   * weapons build four of them — so this only ever swaps the reference. A null id draws
   * nothing, which is the right answer for a body whose weapon index did not resolve: an
   * unarmed silhouette is honest and a wrong silhouette is misinformation, and F4's own
   * argument for this feature is that the silhouette tells you what you are about to be shot
   * with.
   */
  setWeapon(weaponId: string | null, geometry: THREE.BufferGeometry | null, material: THREE.Material): void {
    if (weaponId === this.weaponId) return;
    this.weaponId = weaponId;
    if (this.weapon !== null) {
      this.group.remove(this.weapon);
      this.weapon = null;
    }
    if (geometry === null) return;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.position.set(WEAPON_OFFSET.x, WEAPON_OFFSET.y, WEAPON_OFFSET.z);
    this.weapon = mesh;
    this.group.add(mesh);
  }

  get isDying(): boolean {
    return this.dying;
  }

  /** Start the fall. `dx/dz` is the direction the killing round was travelling. */
  beginDeath(dx: number, dz: number, variant: number, _animation: ActorAnimationInput): void {
    const len = Math.hypot(dx, dz);
    this.fallX = len > 1e-4 ? dx / len : 0;
    this.fallZ = len > 1e-4 ? dz / len : 1;
    this.variant = ((variant % DEATH_VARIANTS) + DEATH_VARIANTS) % DEATH_VARIANTS;
    // Variant 1 pitches forward instead of back: shot in the back, dropped on the face.
    if (this.variant === 1) {
      this.fallX = -this.fallX;
      this.fallZ = -this.fallZ;
    }
    this.dying = true;
    this.deathTime = 0;
    this.shove = this.variant === 3 ? MAX_SHOVE : MAX_SHOVE * 0.55;
    this.flinchTime = 0;
  }

  endDeath(): void {
    this.dying = false;
    this.deathTime = 0;
    this.group.quaternion.identity();
    this.group.scale.set(1, 1, 1);
    // A respawn is a cut, not a run across the map. Dropping the seed makes the next frame's
    // position delta the start of a new integration rather than a fifty-metre stride.
    this.seeded = false;
  }

  /** A non-fatal hit: a short jolt away from the impact. */
  flinch(dx: number, dz: number): void {
    if (this.dying) return;
    const len = Math.hypot(dx, dz);
    this.flinchX = len > 1e-4 ? dx / len : 0;
    this.flinchZ = len > 1e-4 ? dz / len : 1;
    this.flinchTime = FLINCH_SECONDS;
  }

  setVisible(on: boolean): void {
    if (this.group.visible === on) return;
    this.group.visible = on;
  }

  /** The procedural fallback already bakes team material selection at construction. */
  setTeamTint(_tint: TeamVisualTint): void {}

  /** `ActorAvatar` bridge: preserve the existing procedural gait/death implementation. */
  update(
    _animation: ActorAnimationInput,
    x: number,
    y: number,
    z: number,
    yaw: number,
    heightScale: number,
    dt: number,
  ): void {
    this.advance(dt);
    this.apply(x, y, z, yaw, heightScale, dt);
  }

  /** Advance the death and flinch animations. Render-rate: these are visuals only. */
  advance(dt: number): void {
    if (this.dying && this.deathTime < FALL_SECONDS) this.deathTime += dt;
    if (this.flinchTime > 0) this.flinchTime = Math.max(0, this.flinchTime - dt);
  }

  /**
   * Place the body for this frame. `x/y/z` is the interpolated feet pose, `yaw` the facing
   * and `heightScale` the stance compression that the hitbox rig is also using.
   */
  apply(x: number, y: number, z: number, yaw: number, heightScale: number, dt: number): void {
    this.group.rotation.set(0, 0, 0);
    this.group.scale.set(1, this.dying ? 1 : heightScale, 1);
    this.stepGait(x, z, dt);

    if (!this.dying) {
      this.group.position.set(x, y, z);
      this.group.quaternion.setFromAxisAngle(BotMesh.upAxis, yaw);
      if (this.flinchTime > 0) this.applyFlinch();
      return;
    }

    const t = clamp01(this.deathTime / FALL_SECONDS);
    // Rise toward the target angle, then a decaying wobble past it. No solver, no library.
    const ease = 1 - Math.exp(-5.5 * t);
    const wobble = Math.exp(-7 * t) * Math.sin(t * 21) * 0.13;
    const target = this.variant === 2 ? Math.PI * 0.42 : Math.PI * 0.5;
    const angle = target * ease + wobble;

    const travel = this.shove * (1 - Math.exp(-4 * t));
    // Variant 2 crumples: less rotation, more sink.
    const sink = this.variant === 2 ? lerp(0, -0.28, ease) : -0.04 * ease;

    this.group.position.set(x + this.fallX * travel, y + sink, z + this.fallZ * travel);

    this.quat.setFromAxisAngle(BotMesh.upAxis, yaw + (this.variant === 3 ? ease * 1.1 : 0));
    // Axis perpendicular to the fall direction, so +Y tips toward it (see the header).
    this.axis.set(this.fallZ, 0, -this.fallX).normalize();
    this.spinQuat.setFromAxisAngle(this.axis, angle);
    this.group.quaternion.copy(this.spinQuat).multiply(this.quat);
  }

  /**
   * Nothing here owns geometry any more.
   *
   * Every mesh on this body references one of `BotAssets`' four shared geometries or one of
   * `BotRenderer`'s cached weapons, all of which outlive the body and are released by their
   * owners. Disposing them from here would tear the geometry out from under the other nine
   * bots on the map — which is exactly what the per-bot `disposables` list would have done the
   * moment the geometries were shared.
   */
  dispose(): void {
    this.group.clear();
  }

  /**
   * Advance the walk cycle from the ground this body was drawn to cover.
   *
   * Distance rather than time (see `shared/ai/Gait.ts`): the phase is the integral of movement,
   * so a body held against a wall stops walking and a body that is not moving eases back to a
   * standing pose through the amplitude rather than freezing mid-stride.
   *
   * The two legs are the only things this touches. The rig is not consulted and cannot be
   * written: `HitboxRig` takes a yaw and a stance scale, and this is neither.
   */
  private stepGait(x: number, z: number, dt: number): void {
    if (!this.seeded) {
      this.lastX = x;
      this.lastZ = z;
      this.seeded = true;
    }
    const distance = Math.hypot(x - this.lastX, z - this.lastZ);
    this.lastX = x;
    this.lastZ = z;

    this.phase = advanceGaitPhase(this.phase, distance);
    const target = this.dying ? 0 : gaitAmplitude(dt > 1e-5 ? distance / dt : 0);
    // Exponential rather than linear, so the response is the same at 30 fps and at 144.
    this.amplitude += (target - this.amplitude) * (1 - Math.exp(-AMPLITUDE_RESPONSE * Math.max(0, dt)));

    const pose = gaitAt(this.phase, this.amplitude);
    this.legL.rotation.x = pose.left.swing;
    this.legR.rotation.x = pose.right.swing;
  }

  private applyFlinch(): void {
    const t = this.flinchTime / FLINCH_SECONDS;
    const angle = Math.sin(t * Math.PI) * FLINCH_ANGLE;
    this.axis.set(this.flinchZ, 0, -this.flinchX).normalize();
    this.spinQuat.setFromAxisAngle(this.axis, angle);
    this.group.quaternion.premultiply(this.spinQuat);
  }
}

/**
 * The x offset of a leg box, so the hip nodes sit where the hitboxes do.
 *
 * Read off the rig rather than typed, for the same reason `LEG_PIVOT_Y` is: two numbers
 * describing one hip is one number too many.
 */
const LEG_OFFSET_X = Math.abs(HUMANOID_RIG.boxes.find((b) => b.name === 'legL')?.ox ?? 0.11);

/** Boxes straight off the rig: same offsets, same extents, nothing to drift out of sync. */
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
  if (merged === null) throw new Error('Failed to merge bot body geometry');
  merged.computeBoundingSphere();
  return merged;
}

/**
 * The torso, plus the two arms pitched forward onto the weapon.
 *
 * One mesh because neither half moves: `ARM_PITCH` is a pose rather than a joint, so baking it
 * into the geometry costs nothing and a node holding a constant rotation would be a draw call
 * with no animation behind it.
 *
 * The arms are rotated about the **top face of their own hitbox** — the shoulder — so the
 * divergence from the box grows from zero there down to its worst at the hand. That is the
 * cheapest place for it to be: it is the end of a limb, on the zone with the lowest multiplier
 * in the game, and it is measured by `npm run readability` rather than described here.
 */
function buildBodyGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const box of HUMANOID_RIG.boxes) {
    if (box.zone !== 'torso' && box.zone !== 'arm') continue;
    const g = new THREE.BoxGeometry(box.sx, box.sy, box.sz);
    if (box.zone === 'arm') {
      const shoulder = box.oy + box.sy * 0.5;
      // Pivot to the origin, turn, and hang it back off the shoulder.
      g.translate(0, -box.sy * 0.5, 0);
      g.rotateX(ARM_PITCH);
      g.translate(box.ox, shoulder, box.oz);
    } else {
      g.translate(box.ox, box.oy, box.oz);
    }
    parts.push(g);
  }
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (merged === null) throw new Error('Failed to merge bot body geometry');
  merged.computeBoundingSphere();
  return merged;
}

/**
 * One leg, built with its hip at the local origin so a node rotation is a hip rotation.
 *
 * Both legs share it. The box is the rig's own `legL` — same extents — hung below the pivot
 * rather than centred on `oy`, which is the only difference between this and what
 * `buildZoneGeometry` would produce, and the whole reason the leg can turn.
 */
function buildLegGeometry(): THREE.BufferGeometry {
  const box = HUMANOID_RIG.boxes.find((b) => b.name === 'legL');
  if (box === undefined) throw new Error('HUMANOID_RIG has no "legL" box to build a leg from.');
  const g = new THREE.BoxGeometry(box.sx, box.sy, box.sz);
  g.translate(0, -box.sy * 0.5, box.oz);
  g.computeBoundingSphere();
  return g;
}

/**
 * The parts that are not hitboxes and never were: a chest rig and a visor plate.
 *
 * The rifle used to be here — five hand-typed boxes, the same on every bot regardless of what
 * `drawBotWeapon` dealt it, and the third description in the client of what a rifle looks like
 * after the one round 4's F15 deleted. It is `buildHeldWeaponGeometry` now, off the same
 * `WeaponModelSpec` the viewmodel is built from. Rig-local -Z is forward, matching `HitboxRig`.
 */
function buildGearGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const put = (sx: number, sy: number, sz: number, ox: number, oy: number, oz: number): void => {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(ox, oy, oz);
    parts.push(g);
  };
  put(0.4, 0.24, 0.06, 0, 1.24, -0.15);
  put(0.15, 0.09, 0.03, 0, 1.68, -0.12);

  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (merged === null) throw new Error('Failed to merge bot gear geometry');
  merged.computeBoundingSphere();
  return merged;
}
