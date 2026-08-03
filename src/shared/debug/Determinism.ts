import { PLAYER_ENTITY_ID, DamageSystem } from '../combat/DamageSystem';
import { createGameBus } from '../core/Events';
import { Btn, type MutableInputCommand } from '../core/InputCommand';
import { DT } from '../core/Loop';
import { Rng } from '../core/Rng';
import { simCos, simSin } from '../core/SimMath';
import { StateHasher } from '../core/StateHash';
import { cloneMovementConfig, DEFAULT_MOVEMENT_CONFIG } from '../player/MovementConfig';
import { PlayerController } from '../player/PlayerController';
import { AR_DEFAULT, cloneWeaponDef, PISTOL_DEFAULT } from '../weapons/WeaponDefs';
import { cloneViewmodelConfig, DEFAULT_VIEWMODEL_CONFIG } from '../weapons/ViewmodelConfig';
import { WeaponSystem } from '../weapons/WeaponSystem';
import { loadMapCollision } from '../world/MapLoader';
import { FOUNDRY_MAP } from '../world/maps/foundry';

/**
 * The cross-runtime determinism harness (brief S6.6).
 *
 * *"Run a fixed sequence of `InputCommand`s through the shared sim in Node and in the
 * browser. Hash the resulting state at every tick. The hashes must match exactly."*
 *
 * ## Why this is worth a whole phase
 *
 * At M10, reconciliation replays unacked commands through the same `PlayerController.step`
 * the server ran. If the two runtimes disagree by one bit on tick 900, the client will see a
 * correction it did not earn, every time it happens, and the symptom will look like a netcode
 * bug — dropped packets, bad interpolation, a rewind window that is too short. It is
 * enormously cheaper to find that here, with no network in the picture at all.
 *
 * ## What it exercises
 *
 * Movement *and* the weapon, deliberately. Movement alone would miss the interesting half:
 * `WeaponSystem` is where the simulation consumes randomness (spread cones, pellet spread),
 * and S4.14 names a free-running RNG stream as the most likely cause of divergence. A
 * harness that never pulled the trigger would pass while the actual hazard sat untested.
 *
 * The RNG state is hashed alongside the pose for the same reason: two runtimes whose player
 * is in the same place but whose spread stream has advanced differently *have* diverged, and
 * the next shot will prove it.
 *
 * ## What makes the sequence fixed
 *
 * The commands are generated from a seeded `Rng` that is separate from anything the
 * simulation touches. It walks, sprints, crouches, jumps, turns and fires in a pattern that
 * is arbitrary but reproducible — the point is coverage of the branches, not realism. Same
 * seed, same commands, in any runtime.
 */

/** One tick of recorded state. Small enough to write for 3600 ticks, named for the differ. */
export interface TickSample {
  readonly tick: number;
  /** FNV-1a over the whole state, as eight hex digits. */
  readonly hash: string;
  // The fields the differ names when the hashes stop matching. Kept raw, never rounded:
  // a rounded field would let the tool report "they agree" on a tick the hash says differ.
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly vx: number;
  readonly vy: number;
  readonly vz: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly stance: string;
  readonly grounded: boolean;
  readonly eyeHeight: number;
  readonly mag: number;
  readonly reserve: number;
  readonly adsFraction: number;
  readonly spreadDeg: number;
  /** The weapon RNG's four words. Where a free-running stream would show itself. */
  readonly rng0: number;
  readonly rng1: number;
  readonly rng2: number;
  readonly rng3: number;
}

export interface DeterminismRunOptions {
  /** How many ticks to run. S8 criterion 5 asks for at least 3600 (60 s). */
  readonly ticks: number;
  /** Seed for the command generator. Not the simulation's seed. */
  readonly seed: number;
}

export const DETERMINISM_DEFAULTS: DeterminismRunOptions = {
  /** 60 s at 60 Hz. S8 criterion 5 asks for at least this many. */
  ticks: 3600,
  /** Arbitrary and fixed. Changing it changes the scenario, so it is written down. */
  seed: 0x0f5e_1a37,
};

/**
 * Build the fixed command sequence.
 *
 * Generated up front rather than per tick, so the sequence is provably the same array in both
 * runtimes before a single simulation step has run — if the harness disagreed about its own
 * inputs, a state divergence would be meaningless.
 */
export function buildCommandSequence(ticks: number, seed: number): MutableInputCommand[] {
  const rng = new Rng(seed);
  const out: MutableInputCommand[] = [];
  let yaw = 0;
  let pitch = 0;

  for (let t = 0; t < ticks; t++) {
    // Look: a slow sweep with jitter, clamped to the same +/- 89 degrees the sampler uses.
    yaw += (rng.float() - 0.5) * 0.06;
    pitch += (rng.float() - 0.5) * 0.02;
    if (pitch > 1.5533) pitch = 1.5533;
    if (pitch < -1.5533) pitch = -1.5533;

    // Movement: hold a direction for a while rather than re-rolling every tick, so the
    // acceleration, friction and air-control branches are actually reached.
    const phase = Math.floor(t / 37);
    const moveX = ((phase * 7) % 3) - 1;
    const moveZ = ((phase * 5) % 3) - 1;

    let buttons = 0;
    if (t % 211 < 90) buttons |= Btn.Sprint;
    if (t % 173 < 40) buttons |= Btn.Crouch;
    if (t % 97 === 0) buttons |= Btn.Jump;
    if (t % 300 < 120) buttons |= Btn.Ads;
    // Fire in bursts, with gaps long enough for a reload to start and finish.
    if (t % 240 < 100) buttons |= Btn.Fire;
    if (t % 1000 === 500) buttons |= Btn.Reload;

    out.push({
      seq: t,
      tickIndex: t,
      moveX,
      moveZ,
      yaw,
      pitch,
      buttons,
      // Derived from the tick, never from a clock: a wall-clock value here would differ
      // between runtimes by construction and the whole comparison would be void.
      sampledAtMs: t * DT * 1000,
    });
  }
  return out;
}

/**
 * Run the fixed sequence and record a sample per tick.
 *
 * Everything it touches is `shared/`, which is the point — this is the same code the browser
 * runs and the same code the server runs, with no adapter in between.
 */
export function runDeterminismScenario(opts: DeterminismRunOptions): TickSample[] {
  const bus = createGameBus();
  const movement = cloneMovementConfig(DEFAULT_MOVEMENT_CONFIG);
  const loaded = loadMapCollision(FOUNDRY_MAP);
  const world = loaded.collision;

  const damage = new DamageSystem(bus);
  const player = new PlayerController(movement, world, bus, PLAYER_ENTITY_ID);

  const weapons = new WeaponSystem(
    cloneWeaponDef(AR_DEFAULT),
    cloneWeaponDef(PISTOL_DEFAULT),
    world,
    damage,
    bus,
    cloneViewmodelConfig(DEFAULT_VIEWMODEL_CONFIG),
    movement.walkSpeed,
    PLAYER_ENTITY_ID,
    'viewmodel',
  );
  // Fixed, so the spread stream starts identically. S4.14's discipline applied at the seam
  // that already existed for it.
  weapons.reseed(0x51e5_0b0a);

  // A spawn on the map rather than at the origin, so the capsule starts on geometry and the
  // ground, step and slope branches are live from tick zero.
  const spawn = loaded.spawns[0];
  player.spawn(spawn?.position.x ?? 0, (spawn?.position.y ?? 0) + 0.1, spawn?.position.z ?? 0, 0);

  const commands = buildCommandSequence(opts.ticks, opts.seed);
  const hasher = new StateHasher();
  const rngState = new Int32Array(4);
  const samples: TickSample[] = [];

  for (let t = 0; t < opts.ticks; t++) {
    const cmd = commands[t];
    if (cmd === undefined) break;

    player.step(cmd);
    const sim = player.sim;
    weapons.step(cmd, sim);

    const active = weapons.weapon;
    weapons.rngState(rngState);

    hasher.reset();
    hasher.int(t);
    hasher.float(sim.x);
    hasher.float(sim.y);
    hasher.float(sim.z);
    hasher.float(sim.vx);
    hasher.float(sim.vy);
    hasher.float(sim.vz);
    hasher.float(sim.yaw);
    hasher.float(sim.pitch);
    hasher.float(sim.eyeHeight);
    hasher.float(sim.capsuleHeight);
    hasher.float(sim.bobPhase);
    hasher.str(sim.stance);
    hasher.bool(sim.grounded);
    hasher.float(sim.groundNx);
    hasher.float(sim.groundNy);
    hasher.float(sim.groundNz);
    hasher.int(active.mag);
    hasher.int(active.reserve);
    hasher.float(active.adsFraction);
    hasher.bool(active.reloading);
    hasher.float(weapons.spreadDeg);
    hasher.int(rngState[0] ?? 0);
    hasher.int(rngState[1] ?? 0);
    hasher.int(rngState[2] ?? 0);
    hasher.int(rngState[3] ?? 0);

    samples.push({
      tick: t,
      hash: hasher.hex,
      x: sim.x,
      y: sim.y,
      z: sim.z,
      vx: sim.vx,
      vy: sim.vy,
      vz: sim.vz,
      yaw: sim.yaw,
      pitch: sim.pitch,
      stance: sim.stance,
      grounded: sim.grounded,
      eyeHeight: sim.eyeHeight,
      mag: active.mag,
      reserve: active.reserve,
      adsFraction: active.adsFraction,
      spreadDeg: weapons.spreadDeg,
      rng0: rngState[0] ?? 0,
      rng1: rngState[1] ?? 0,
      rng2: rngState[2] ?? 0,
      rng3: rngState[3] ?? 0,
    });
  }

  return samples;
}

/** A one-line fingerprint of a whole run, for a quick eyeball comparison. */
export function runFingerprint(samples: readonly TickSample[]): string {
  const h = new StateHasher();
  for (const s of samples) h.str(s.hash);
  return h.hex;
}

/**
 * A digest of the maths surface the simulation stands on.
 *
 * Reported alongside the state fingerprint because the two answer different questions. The
 * state fingerprint says *whether* two runtimes agree; this says whether their **arithmetic**
 * agrees, which is what tells you where to look when they do not.
 *
 * The M9 check needed exactly this: the state hashes diverged at tick 149 on `vz`, and it was
 * this digest — split per function — that identified `Math.sin` and `Math.cos` as the only
 * two that differed between Node's V8 and Chrome's. `simSin`/`simCos` are included so the
 * replacements can be shown to agree where the natives did not.
 */
export function mathDigest(): Record<string, string> {
  const out: Record<string, string> = {};
  const h = new StateHasher();
  const sweep = (name: string, fn: (x: number) => number): void => {
    h.reset();
    for (let i = 0; i < 20000; i++) h.float(fn((i / 20000) * 24 - 12));
    out[name] = h.hex;
  };

  sweep('Math.sin', Math.sin);
  sweep('Math.cos', Math.cos);
  sweep('Math.sqrt', (x) => Math.sqrt(Math.abs(x)));
  sweep('Math.exp', (x) => Math.exp(-Math.abs(x) * 0.1));
  sweep('Math.pow', (x) => Math.pow(Math.abs(x) + 0.01, 0.37));
  sweep('Math.atan2', (x) => Math.atan2(x, 1.618));
  sweep('Math.log', (x) => Math.log(Math.abs(x) + 1e-9));
  sweep('Math.hypot', (x) => Math.hypot(x, x * 0.5 + 1));
  sweep('simSin', simSin);
  sweep('simCos', simCos);
  return out;
}
