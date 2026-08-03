import type { Combatant } from '../ai/Combatant';
import { PLAYER_ENTITY_ID } from '../combat/DamageSystem';
import { EV, type GameBus } from '../core/Events';
import { DT } from '../core/Loop';
import type { PlayerSim } from '../player/PlayerState';
import type { WeaponSystem } from '../weapons/WeaponSystem';
import { NO_PERKS, type PerkState } from './PerkState';

/**
 * The two perks that need a world presence: Scavenger and Tracker.
 *
 * Everything else a perk does is a number on a resolved `WeaponDef`, a multiplier handed
 * to one system, or a flag somebody reads. These two are different — they put things in
 * the world — so they get a runtime that owns a pool and its subscriptions, built and
 * destroyed with the match like every other per-match object since M4.
 *
 * **Scavenger** drops a pickup where a combatant died and grants a magazine when you walk
 * over it. Deliberately a pickup rather than an automatic radius grant: "ammo from bodies"
 * means going to the body, and an invisible refill you cannot decline is not a decision.
 *
 * **Tracker** reveals enemy footsteps. The footsteps are the *same* events the bots' noise
 * field consumes, so a trail exists exactly where an enemy made a sound a bot could have
 * heard — including none at all if they were crouch-walking, which is the answer a player
 * wants from a tracking perk.
 *
 * **M9.** This file used to own a `THREE.Group`, sixteen pickup meshes and a `Points` trail.
 * All of it moved to `client/perks/PerksRenderer.ts`. What stayed is what decides something:
 * whether a pickup exists, whether walking over it grants ammunition, and whether a given
 * footstep is one Tracker reveals. Both perks are still inert while unequipped, and the
 * subscription still stays live so the cost is one branch per event either way.
 */

/** Pickups on the map at once. Bodies outnumber this only in a very bad minute. */
const PICKUP_CAPACITY = 16;
/** Seconds a dropped magazine remains. Read by the renderer for the expiry blink. */
export const PICKUP_LIFETIME = 30;
/** Metres. Generous enough to collect by running past, tight enough to need the detour. */
const PICKUP_RADIUS = 1.35;
/** Metres above the feet the pickup floats. Where it is drawn, not where it is collected. */
export const PICKUP_HEIGHT = 0.35;

/**
 * A dropped magazine.
 *
 * No `spin`: how fast it turns is a fact about a frame rate, and it lives on the renderer.
 */
export interface Pickup {
  active: boolean;
  x: number;
  y: number;
  z: number;
  age: number;
}

export interface PerksRuntimeDeps {
  readonly bus: GameBus;
  readonly roster: readonly Combatant[];
  readonly weapons: WeaponSystem;
  /** The local player's team, so a trail only shows the other side. */
  readonly localTeam: 'A' | 'B';
}

const evScavenged = { entityId: 0, x: 0, y: 0, z: 0, rounds: 0 };

export class PerksRuntime {
  /** Diagnostics for the F1 panel. The print count moved to `PerksRenderer` with the trail. */
  pickupsSpawned = 0;
  pickupsCollected = 0;

  private state: PerkState = NO_PERKS;

  private readonly deps: PerksRuntimeDeps;
  private readonly unsubscribe: Array<() => void> = [];

  /**
   * The live pickup pool (M9).
   *
   * Public because the simulation owns it and `client/perks/PerksRenderer.ts` draws it.
   * Fixed length with reused slots — a consumer reads `active`, never the length.
   */
  readonly pickups: Pickup[] = [];

  constructor(deps: PerksRuntimeDeps) {
    this.deps = deps;

    for (let i = 0; i < PICKUP_CAPACITY; i++) {
      this.pickups.push({ active: false, x: 0, y: 0, z: 0, age: 0 });
    }

    this.unsubscribe.push(deps.bus.on(EV.EntityKilled, (p) => this.onKilled(p.targetId)));
  }

  /** Called whenever the loadout changes, which in practice is once per match. */
  setPerks(state: PerkState): void {
    this.state = state;
    if (!state.scavenger) this.releaseAllPickups();
  }

  get perkState(): PerkState {
    return this.state;
  }

  /** One sim tick: age the pickups, and collect any the player is standing on. */
  simulate(sim: PlayerSim, playerAlive: boolean): void {
    if (!this.state.scavenger) return;
    for (const pickup of this.pickups) {
      if (!pickup.active) continue;
      pickup.age += DT;
      if (pickup.age >= PICKUP_LIFETIME) {
        pickup.active = false;
        continue;
      }
      if (!playerAlive) continue;
      const dx = pickup.x - sim.x;
      const dz = pickup.z - sim.z;
      const dy = pickup.y - sim.y;
      if (dx * dx + dz * dz > PICKUP_RADIUS * PICKUP_RADIUS) continue;
      if (Math.abs(dy) > 2) continue;
      this.collect(pickup);
    }
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
  }

  // -- internals --------------------------------------------------------------

  private onKilled(targetId: number): void {
    if (!this.state.scavenger) return;
    if (targetId === PLAYER_ENTITY_ID) return;
    const victim = this.findCombatant(targetId);
    if (victim === undefined) return;
    const slot = this.pickups.find((p) => !p.active);
    if (slot === undefined) return;
    slot.active = true;
    slot.x = victim.px;
    slot.y = victim.py;
    slot.z = victim.pz;
    slot.age = 0;
    this.pickupsSpawned++;
  }

  private collect(pickup: Pickup): void {
    const weapon = this.deps.weapons.weapon;
    const rounds = weapon.addReserve(weapon.definition.magSize);
    // A pickup with nothing to give is left where it is: walking over a magazine you
    // cannot carry should not consume it.
    if (rounds === 0) return;
    pickup.active = false;
    this.pickupsCollected++;
    evScavenged.entityId = PLAYER_ENTITY_ID;
    evScavenged.x = pickup.x;
    evScavenged.y = pickup.y;
    evScavenged.z = pickup.z;
    evScavenged.rounds = rounds;
    this.deps.bus.emit(EV.PerkScavenged, evScavenged);
  }

  private releaseAllPickups(): void {
    for (const pickup of this.pickups) pickup.active = false;
  }

  /**
   * Whether a footstep by `entityId` should show up on the local player's tracker trail.
   *
   * The *rule* is here — the perk has to be equipped, it is other people's footsteps, and
   * only the other side's — because it is a rule about a perk and a team. Where the prints
   * are stored, how they fade and what colour they burn is `client/perks/PerksRenderer.ts`,
   * because none of that is a fact about the match. This is the whole of what M9 moved.
   */
  revealsFootstep(entityId: number): boolean {
    if (!this.state.tracker) return false;
    if (entityId === PLAYER_ENTITY_ID) return false;
    const walker = this.findCombatant(entityId);
    return walker !== undefined && walker.team !== this.deps.localTeam;
  }

  private findCombatant(entityId: number): Combatant | undefined {
    for (const c of this.deps.roster) {
      if (c.entityId === entityId) return c;
    }
    return undefined;
  }
}
