import type { StanceId } from '../player/Stance';
import { STANCES } from '../player/Stance';
import { makePlayerSimState, type PlayerSimState } from '../player/PlayerState';
import { ALL_WEAPONS } from '../weapons/WeaponDefs';
import type { ByteReader, ByteWriter } from './Wire';
import {
  dequantAngle,
  dequantPitch,
  dequantPos,
  dequantVel,
  quantAngle,
  quantPitch,
  quantPos,
  quantVel,
} from './Protocol';

/**
 * What the server replicates, and how it is packed (M10, S4.12 and S4.15).
 *
 * S4.15 draws the authority line and this file is that table made into bytes. Everything in
 * the left-hand column is here; nothing in the right-hand column is. There are no tracers,
 * no decals, no camera shake and no HUD state on the wire — those are *driven by* replicated
 * events on the client, which is a different thing from being replicated.
 *
 * ## Two different jobs, two different encodings
 *
 * **Remote entities** are quantised hard (S4.12: 1 cm positions, 16-bit angles) because they
 * are only ever *rendered*, and a centimetre is well below what anybody can see at the ranges
 * this game is played at. Ten of them at 30 Hz is the bandwidth budget.
 *
 * **The receiving client's own player** is sent at full `f32` precision in a separate block.
 * This looks like an inconsistency and is the opposite: that block is not drawn, it is
 * *compared against a prediction*, and quantisation error in a comparison is indistinguishable
 * from a misprediction. S8.4 requires the misprediction count to be **zero** at zero added
 * latency — with 1 cm quantisation on the owner's own position it could never be, because the
 * client would be correcting rounding forever. One entity's worth of exactness buys that.
 *
 * ## Delta compression
 *
 * Every entity carries a `u16` field mask against the last snapshot this client acked
 * (S4.12). A standing player costs the mask and nothing else; a sprinting one costs position
 * and velocity. The baseline is per-client because acks are per-client — two clients on
 * different links are almost never acking the same snapshot.
 */

/** Entity flags. Presentation reads these; none of them are cosmetic *state*. */
export const EFlag = {
  Alive: 1 << 0,
  Firing: 1 << 1,
  Reloading: 1 << 2,
  Ads: 1 << 3,
  Sprinting: 1 << 4,
  /** A server-side bot rather than a connected human. Drives nothing but the scoreboard. */
  Bot: 1 << 5,
  Grounded: 1 << 6,
  /** Team B when set, team A when clear. */
  TeamB: 1 << 7,
} as const;

/** Which fields a delta carries. One bit per line of `writeEntity`. */
const F = {
  Pos: 1 << 0,
  Yaw: 1 << 1,
  Pitch: 1 << 2,
  Vel: 1 << 3,
  Stance: 1 << 4,
  Height: 1 << 5,
  Health: 1 << 6,
  Weapon: 1 << 7,
  Flags: 1 << 8,
  Death: 1 << 9,
  Spawn: 1 << 10,
  Flinch: 1 << 11,
  Name: 1 << 12,
} as const;

/**
 * One replicated actor.
 *
 * Deliberately flat numbers and one string. It is written by the server from a `Bot` or a
 * connected player's controller, and read by the client into a renderable remote — neither of
 * which this struct knows anything about.
 */
export interface EntitySnapshot {
  entityId: number;
  /** Sent once, on the entity's first appearance, then only if it changes. */
  displayName: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  vx: number;
  vz: number;
  stance: StanceId;
  /** Rig vertical compression, 1 standing. Matches `HitboxRig.heightScale`. */
  heightScale: number;
  /** Current hit points, 0-255. */
  health: number;
  /** Index into `ALL_WEAPONS`. 255 means "no weapon", which a dead body has. */
  weaponIndex: number;
  flags: number;
  /** M3 visual serials (`BotVisualState`). The animation seam, replicated verbatim. */
  deathSerial: number;
  deathAngle: number;
  spawnSerial: number;
  flinchSerial: number;
  flinchAngle: number;
}

export function makeEntitySnapshot(): EntitySnapshot {
  return {
    entityId: 0,
    displayName: '',
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    vx: 0,
    vz: 0,
    stance: 'STAND',
    heightScale: 1,
    health: 100,
    weaponIndex: 255,
    flags: EFlag.Alive,
    deathSerial: 0,
    deathAngle: 0,
    spawnSerial: 0,
    flinchSerial: 0,
    flinchAngle: 0,
  };
}

export function copyEntitySnapshot(src: EntitySnapshot, dst: EntitySnapshot): void {
  dst.entityId = src.entityId;
  dst.displayName = src.displayName;
  dst.x = src.x;
  dst.y = src.y;
  dst.z = src.z;
  dst.yaw = src.yaw;
  dst.pitch = src.pitch;
  dst.vx = src.vx;
  dst.vz = src.vz;
  dst.stance = src.stance;
  dst.heightScale = src.heightScale;
  dst.health = src.health;
  dst.weaponIndex = src.weaponIndex;
  dst.flags = src.flags;
  dst.deathSerial = src.deathSerial;
  dst.deathAngle = src.deathAngle;
  dst.spawnSerial = src.spawnSerial;
  dst.flinchSerial = src.flinchSerial;
  dst.flinchAngle = src.flinchAngle;
}

/** Weapon id to wire index. `ALL_WEAPONS` order is the shared table; -1 becomes 255. */
export function weaponIndexOf(weaponId: string): number {
  for (let i = 0; i < ALL_WEAPONS.length; i++) {
    if (ALL_WEAPONS[i]?.id === weaponId) return i;
  }
  return 255;
}

export function weaponIdAt(index: number): string | null {
  return ALL_WEAPONS[index]?.id ?? null;
}

function stanceIndex(stance: StanceId): number {
  const at = STANCES.indexOf(stance);
  return at < 0 ? 0 : at;
}

function stanceAt(index: number): StanceId {
  return STANCES[index] ?? 'STAND';
}

/**
 * Write one entity as a delta against `base`, or in full when `base` is null.
 *
 * Quantised values are compared *after* quantisation, not before: two positions 2 mm apart
 * encode to the same centimetre, and sending a field whose bytes would be identical is pure
 * waste. This is where most of the compression actually comes from — far more than from the
 * mask itself, because a player standing still still has floating-point noise in their pose.
 */
export function writeEntity(w: ByteWriter, e: EntitySnapshot, base: EntitySnapshot | null): void {
  let mask = 0;

  const qx = quantPos(e.x);
  const qy = quantPos(e.y);
  const qz = quantPos(e.z);
  const qyaw = quantAngle(e.yaw);
  const qpitch = quantPitch(e.pitch);
  const qvx = quantVel(e.vx);
  const qvz = quantVel(e.vz);
  const qh = Math.round(e.heightScale * 255);

  if (base === null) {
    mask =
      F.Pos | F.Yaw | F.Pitch | F.Vel | F.Stance | F.Height | F.Health | F.Weapon | F.Flags | F.Name;
    // Serials only ride a full write when they are non-zero: a fresh entity at zero is the
    // client's own default, so spending three fields to say so is waste on every join.
    if (e.deathSerial !== 0) mask |= F.Death;
    if (e.spawnSerial !== 0) mask |= F.Spawn;
    if (e.flinchSerial !== 0) mask |= F.Flinch;
  } else {
    if (qx !== quantPos(base.x) || qy !== quantPos(base.y) || qz !== quantPos(base.z)) mask |= F.Pos;
    if (qyaw !== quantAngle(base.yaw)) mask |= F.Yaw;
    if (qpitch !== quantPitch(base.pitch)) mask |= F.Pitch;
    if (qvx !== quantVel(base.vx) || qvz !== quantVel(base.vz)) mask |= F.Vel;
    if (e.stance !== base.stance) mask |= F.Stance;
    if (qh !== Math.round(base.heightScale * 255)) mask |= F.Height;
    if (e.health !== base.health) mask |= F.Health;
    if (e.weaponIndex !== base.weaponIndex) mask |= F.Weapon;
    if (e.flags !== base.flags) mask |= F.Flags;
    if (e.deathSerial !== base.deathSerial) mask |= F.Death;
    if (e.spawnSerial !== base.spawnSerial) mask |= F.Spawn;
    if (e.flinchSerial !== base.flinchSerial) mask |= F.Flinch;
    if (e.displayName !== base.displayName) mask |= F.Name;
  }

  w.u8v(e.entityId);
  w.u16(mask);

  if ((mask & F.Pos) !== 0) {
    w.i16(qx);
    w.i16(qy);
    w.i16(qz);
  }
  if ((mask & F.Yaw) !== 0) w.u16(qyaw);
  if ((mask & F.Pitch) !== 0) w.i16(qpitch);
  if ((mask & F.Vel) !== 0) {
    w.i16(qvx);
    w.i16(qvz);
  }
  if ((mask & F.Stance) !== 0) w.u8v(stanceIndex(e.stance));
  if ((mask & F.Height) !== 0) w.u8v(qh);
  if ((mask & F.Health) !== 0) w.u8v(e.health);
  if ((mask & F.Weapon) !== 0) w.u8v(e.weaponIndex);
  if ((mask & F.Flags) !== 0) w.u8v(e.flags);
  if ((mask & F.Death) !== 0) {
    w.u8v(e.deathSerial & 0xff);
    w.u16(quantAngle(e.deathAngle));
  }
  if ((mask & F.Spawn) !== 0) w.u8v(e.spawnSerial & 0xff);
  if ((mask & F.Flinch) !== 0) {
    w.u8v(e.flinchSerial & 0xff);
    w.u16(quantAngle(e.flinchAngle));
  }
  if ((mask & F.Name) !== 0) w.str(e.displayName);
}

/**
 * Read one entity into `out`, which must already hold the baseline for this entity.
 *
 * "Already hold the baseline" is the contract that makes deltas work and the one that breaks
 * loudly if it is violated: an absent field means *unchanged*, so a caller that hands in a
 * zeroed record gets an entity at the origin. The client satisfies this by decoding into its
 * own retained copy.
 */
export function readEntity(r: ByteReader, out: EntitySnapshot): void {
  out.entityId = r.u8v();
  const mask = r.u16();

  if ((mask & F.Pos) !== 0) {
    out.x = dequantPos(r.i16());
    out.y = dequantPos(r.i16());
    out.z = dequantPos(r.i16());
  }
  if ((mask & F.Yaw) !== 0) out.yaw = dequantAngle(r.u16());
  if ((mask & F.Pitch) !== 0) out.pitch = dequantPitch(r.i16());
  if ((mask & F.Vel) !== 0) {
    out.vx = dequantVel(r.i16());
    out.vz = dequantVel(r.i16());
  }
  if ((mask & F.Stance) !== 0) out.stance = stanceAt(r.u8v());
  if ((mask & F.Height) !== 0) out.heightScale = r.u8v() / 255;
  if ((mask & F.Health) !== 0) out.health = r.u8v();
  if ((mask & F.Weapon) !== 0) out.weaponIndex = r.u8v();
  if ((mask & F.Flags) !== 0) out.flags = r.u8v();
  if ((mask & F.Death) !== 0) {
    out.deathSerial = r.u8v();
    out.deathAngle = dequantAngle(r.u16());
  }
  if ((mask & F.Spawn) !== 0) out.spawnSerial = r.u8v();
  if ((mask & F.Flinch) !== 0) {
    out.flinchSerial = r.u8v();
    out.flinchAngle = dequantAngle(r.u16());
  }
  if ((mask & F.Name) !== 0) out.displayName = r.str();
}

// -- the owner's own authoritative state --------------------------------------

/**
 * Optional blocks in the owner state, present only when they carry something.
 *
 * The split is by gameplay subsystem rather than by byte budget, and it earns its keep: a
 * player who is running and not sliding, mantling or on a slope pays for the base block
 * alone. Slide and mantle state is large and almost always inert, and sending it every
 * snapshot would roughly double the owner block for the ninety-odd percent of ticks where
 * every field in it is zero.
 */
const OB = {
  Sprint: 1 << 0,
  Slide: 1 << 1,
  Mantle: 1 << 2,
  /** Ground normal, when the surface underfoot is not flat. */
  Slope: 1 << 3,
} as const;

/** Owner-state boolean flags that do not live in `PlayerSimState` as numbers. */
const OF = {
  Grounded: 1 << 0,
  WasGrounded: 1 << 1,
  SprintActive: 1 << 2,
  TacSprintActive: 1 << 3,
  SlideActive: 1 << 4,
  MantleActive: 1 << 5,
  JumpedThisTick: 1 << 6,
  JustLanded: 1 << 7,
} as const;

/**
 * The authoritative simulation state of the client receiving this snapshot.
 *
 * Full `f32` precision — see the file header for why this one entity is different. It is the
 * exact input to `loadPlayerSim`, so a correction restores every timer and latch the next
 * replayed tick will read, not just a pose (S4.11).
 */
export function writeOwnerState(w: ByteWriter, s: PlayerSimState): void {
  let blocks = 0;
  if (s.sprintHeldTime !== 0 || s.tacSprintElapsed !== 0 || s.tacSprintCooldown !== 0 || s.tacLockout !== 0) {
    blocks |= OB.Sprint;
  }
  if (s.slideActive || s.slideElapsed !== 0 || s.slideCooldown !== 0) blocks |= OB.Slide;
  if (s.mantleActive || s.mantleCooldown !== 0) blocks |= OB.Mantle;
  if (s.groundNy !== 1 || s.groundNx !== 0 || s.groundNz !== 0) blocks |= OB.Slope;

  let flags = 0;
  if (s.grounded) flags |= OF.Grounded;
  if (s.wasGrounded) flags |= OF.WasGrounded;
  if (s.sprintActive) flags |= OF.SprintActive;
  if (s.tacSprintActive) flags |= OF.TacSprintActive;
  if (s.slideActive) flags |= OF.SlideActive;
  if (s.mantleActive) flags |= OF.MantleActive;
  if (s.jumpedThisTick) flags |= OF.JumpedThisTick;
  if (s.justLanded) flags |= OF.JustLanded;

  w.u8v(blocks);
  w.u8v(flags);

  w.f32(s.x);
  w.f32(s.y);
  w.f32(s.z);
  w.f32(s.vx);
  w.f32(s.vy);
  w.f32(s.vz);
  w.f32(s.yaw);
  w.f32(s.pitch);
  w.u8v(stanceIndex(s.stance));
  w.u8v(s.groundMaterial);
  w.f32(s.capsuleHeight);
  w.f32(s.eyeHeight);
  w.f32(s.bobPhase);
  w.f32(s.distanceSinceStep);
  w.f32(s.airSpeedCap);
  w.f32(s.coyote);
  w.f32(s.jumpBuffer);
  w.f32(s.landImpact);
  w.u32(s.prevButtons);
  w.i32(s.tick);

  if ((blocks & OB.Sprint) !== 0) {
    w.f32(s.sprintHeldTime);
    w.f32(s.tacSprintElapsed);
    w.f32(s.tacSprintCooldown);
    w.f32(s.tacLockout);
    w.i32(s.lastSprintPressTick);
  }
  if ((blocks & OB.Slide) !== 0) {
    w.f32(s.slideElapsed);
    w.f32(s.slideCooldown);
    w.f32(s.slideDirX);
    w.f32(s.slideDirZ);
    w.f32(s.slideSpeed);
    w.f32(s.slideAirTime);
  }
  if ((blocks & OB.Mantle) !== 0) {
    w.f32(s.mantleElapsed);
    w.f32(s.mantleCooldown);
    w.f32(s.mantleFromX);
    w.f32(s.mantleFromY);
    w.f32(s.mantleFromZ);
    w.f32(s.mantleToX);
    w.f32(s.mantleToY);
    w.f32(s.mantleToZ);
    w.f32(s.mantleDirX);
    w.f32(s.mantleDirZ);
    w.u8v(stanceIndex(s.mantleEndStance));
  }
  if ((blocks & OB.Slope) !== 0) {
    w.f32(s.groundNx);
    w.f32(s.groundNy);
    w.f32(s.groundNz);
  }
}

/**
 * Read owner state into `out`.
 *
 * Absent blocks are written back to their **inert** values rather than left alone. That is
 * the opposite of the entity delta rule above and it is deliberate: an absent slide block
 * means "not sliding", so leaving a stale `slideElapsed` behind would resume a slide the
 * server has already ended, and the client would slide away from the authoritative position
 * it just snapped to.
 */
export function readOwnerState(r: ByteReader, out: PlayerSimState): void {
  const blocks = r.u8v();
  const flags = r.u8v();

  out.x = r.f32();
  out.y = r.f32();
  out.z = r.f32();
  out.vx = r.f32();
  out.vy = r.f32();
  out.vz = r.f32();
  out.yaw = r.f32();
  out.pitch = r.f32();
  out.stance = stanceAt(r.u8v());
  out.groundMaterial = r.u8v();
  out.capsuleHeight = r.f32();
  out.eyeHeight = r.f32();
  out.bobPhase = r.f32();
  out.distanceSinceStep = r.f32();
  out.airSpeedCap = r.f32();
  out.coyote = r.f32();
  out.jumpBuffer = r.f32();
  out.landImpact = r.f32();
  out.prevButtons = r.u32();
  out.tick = r.i32();

  out.grounded = (flags & OF.Grounded) !== 0;
  out.wasGrounded = (flags & OF.WasGrounded) !== 0;
  out.sprintActive = (flags & OF.SprintActive) !== 0;
  out.tacSprintActive = (flags & OF.TacSprintActive) !== 0;
  out.slideActive = (flags & OF.SlideActive) !== 0;
  out.mantleActive = (flags & OF.MantleActive) !== 0;
  out.jumpedThisTick = (flags & OF.JumpedThisTick) !== 0;
  out.justLanded = (flags & OF.JustLanded) !== 0;

  if ((blocks & OB.Sprint) !== 0) {
    out.sprintHeldTime = r.f32();
    out.tacSprintElapsed = r.f32();
    out.tacSprintCooldown = r.f32();
    out.tacLockout = r.f32();
    out.lastSprintPressTick = r.i32();
  } else {
    out.sprintHeldTime = 0;
    out.tacSprintElapsed = 0;
    out.tacSprintCooldown = 0;
    out.tacLockout = 0;
    out.lastSprintPressTick = -1000;
  }

  if ((blocks & OB.Slide) !== 0) {
    out.slideElapsed = r.f32();
    out.slideCooldown = r.f32();
    out.slideDirX = r.f32();
    out.slideDirZ = r.f32();
    out.slideSpeed = r.f32();
    out.slideAirTime = r.f32();
  } else {
    out.slideElapsed = 0;
    out.slideCooldown = 0;
    out.slideDirX = 0;
    out.slideDirZ = 1;
    out.slideSpeed = 0;
    out.slideAirTime = 0;
  }

  if ((blocks & OB.Mantle) !== 0) {
    out.mantleElapsed = r.f32();
    out.mantleCooldown = r.f32();
    out.mantleFromX = r.f32();
    out.mantleFromY = r.f32();
    out.mantleFromZ = r.f32();
    out.mantleToX = r.f32();
    out.mantleToY = r.f32();
    out.mantleToZ = r.f32();
    out.mantleDirX = r.f32();
    out.mantleDirZ = r.f32();
    out.mantleEndStance = stanceAt(r.u8v());
  } else {
    out.mantleElapsed = 0;
    out.mantleCooldown = 0;
    out.mantleEndStance = 'STAND';
  }

  if ((blocks & OB.Slope) !== 0) {
    out.groundNx = r.f32();
    out.groundNy = r.f32();
    out.groundNz = r.f32();
  } else {
    out.groundNx = 0;
    out.groundNy = 1;
    out.groundNz = 0;
  }

  // Never replicated: pure per-tick scratch that the next `step` overwrites before reading.
  out.blockedHorizontally = false;
  out.steppedUp = false;
}

export function makeOwnerState(): PlayerSimState {
  return makePlayerSimState();
}
