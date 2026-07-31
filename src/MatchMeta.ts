import type * as THREE from 'three';
import type { BotDirector } from './ai/BotDirector';
import type { BotTeam } from './ai/Combatant';
import { PLAYER_ENTITY_ID } from './combat/DamageSystem';
import type { ScoreSystem } from './combat/ScoreSystem';
import type { GameBus } from './core/Events';
import type { InputCommand } from './core/InputCommand';
import type { EquipmentSystem, EquipmentInventory } from './equipment/EquipmentSystem';
import { ChallengeTracker } from './meta/ChallengeTracker';
import type { ResolvedLoadout } from './meta/Loadouts';
import { MatchProgression } from './meta/MatchProgression';
import type { Profile } from './meta/Profile';
import type { XpReport } from './meta/XpRules';
import { FieldUpgradeRuntime } from './perks/FieldUpgrade';
import { PerksRuntime } from './perks/PerksRuntime';
import type { PerkState } from './perks/PerkState';
import type { Health } from './player/Health';
import type { PlayerController } from './player/PlayerController';
import type { PlayerSim } from './player/PlayerState';
import type { WeaponSystem } from './weapons/WeaponSystem';

/**
 * Progression and perks, composed into a match.
 *
 * Split out of `Match.ts` for the reason `MatchFeedback` and `MatchEquipment` were: `Match`
 * is wiring, and this is a subsystem's worth of it — the XP tally, the challenge tracker,
 * the two perks that own scene objects, the field upgrade, and the four hooks that put the
 * rest of the perks into systems that already existed.
 *
 * **Those four hooks are the whole design.** A perk does not get a special case anywhere;
 * it sets one number or one predicate on the system that already owns the behaviour:
 *
 *   Lightweight     -> `PlayerController.speedScale`
 *   Dead Silence    -> `BotDirector.silentFootsteps`
 *   Battle Hardened -> `FlashField.resistance`
 *   Overkill        -> loadout validation, before this object exists
 *
 * and the three weapon-number perks never reach here at all, because they were folded into
 * the resolved `WeaponDef` by `resolveLoadout` before the match was built. What is left —
 * Scavenger and Tracker — needs a group in the scene, and that is `PerksRuntime`.
 *
 * Nothing here is on the hot path in any meaningful sense: `simulate` is two calls and a
 * charge timer, and the progression side is event-driven counting.
 */

export interface MatchMetaDeps {
  readonly bus: GameBus;
  readonly scene: THREE.Scene;
  readonly profile: Profile;
  readonly loadout: ResolvedLoadout;
  readonly score: ScoreSystem;
  readonly player: PlayerController;
  readonly playerHealth: Health;
  readonly weapons: WeaponSystem;
  readonly bots: BotDirector;
  readonly equipment: EquipmentSystem;
  readonly equipmentInventory: EquipmentInventory;
  readonly localTeam: BotTeam;
  /** False in the Shooting Range: a testbed must not bank progress (see `Range.ts`). */
  readonly banksProgress: boolean;
}

export class MatchMeta {
  readonly tracker: ChallengeTracker;
  readonly progression: MatchProgression;
  readonly perks: PerksRuntime;
  readonly fieldUpgrade: FieldUpgradeRuntime;

  /** Wall time inside the last `simulate`, ms. Reported in F1 (S7, criterion 9). */
  lastMs = 0;

  private readonly deps: MatchMetaDeps;
  private perkState: PerkState;

  constructor(deps: MatchMetaDeps) {
    this.deps = deps;
    this.perkState = deps.loadout.perkState;

    this.tracker = new ChallengeTracker(deps.profile);
    this.tracker.reset();
    // Subscribes to `entity.killed` *after* `MatchFlow` did, which is what makes the
    // streak it reads out of `ScoreSystem` include the kill being described. See
    // `MatchProgression`'s file comment.
    this.progression = new MatchProgression({
      bus: deps.bus,
      profile: deps.profile,
      score: deps.score,
      tracker: this.tracker,
    });

    this.perks = new PerksRuntime({
      bus: deps.bus,
      scene: deps.scene,
      roster: deps.bots.roster,
      weapons: deps.weapons,
      localTeam: deps.localTeam,
    });
    this.perks.setPerks(this.perkState);

    this.fieldUpgrade = new FieldUpgradeRuntime({
      bus: deps.bus,
      equipment: deps.equipment,
      inventory: deps.equipmentInventory,
      weapons: deps.weapons.inventory,
      health: deps.playerHealth,
    });
    this.fieldUpgrade.setUpgrade(deps.loadout.fieldUpgrade);

    this.applyPerkHooks();
  }

  get state(): PerkState {
    return this.perkState;
  }

  /**
   * Change class mid-match (S6.3: the editor is reachable "between spawns").
   *
   * Everything a perk touches is re-derived rather than patched: the state is replaced,
   * the hooks are re-applied over the top of themselves, and the runtime is told to drop
   * anything the new set no longer supports — a Scavenger pickup left lying on the floor
   * after the perk came off would be a pickup nobody can collect.
   */
  setLoadout(loadout: ResolvedLoadout): void {
    this.perkState = loadout.perkState;
    this.perks.setPerks(this.perkState);
    this.fieldUpgrade.setUpgrade(loadout.fieldUpgrade);
    this.applyPerkHooks();
  }

  /** One sim tick. Called from `Match.simulate` after the weapon has stepped. */
  simulate(cmd: InputCommand, sim: PlayerSim, playerAlive: boolean): void {
    const t0 = performance.now();
    this.progression.sample(sim, this.deps.weapons, cmd.tickIndex);
    this.perks.simulate(sim, playerAlive);
    this.fieldUpgrade.step(cmd, sim, playerAlive);
    this.lastMs = performance.now() - t0;
  }

  render(dt: number): void {
    this.perks.render(dt);
  }

  /**
   * Close the match and bank it.
   *
   * `isMvp` is decided here rather than by the score system because it is an XP rule, not
   * a scoreboard fact: the top score on the board, with ties going to nobody, because two
   * MVPs is not what the word means.
   */
  finish(won: boolean): XpReport {
    if (!this.deps.banksProgress) {
      // The range still counts kills and challenges in memory so the panels show something
      // real; it simply never writes any of it. Returning the report without banking would
      // put XP on the summary that the profile never received.
      return this.progression.finish(false, false);
    }
    return this.progression.finish(won, this.isMvp());
  }

  dispose(): void {
    // The hooks are cleared before anything else: a perk predicate that outlives the match
    // it belongs to is exactly the leak shape M4's heap harness was built to catch.
    this.deps.bots.silentFootsteps = null;
    this.deps.equipment.flash.resistance = null;
    this.deps.player.speedScale = 1;
    this.progression.dispose();
    this.perks.dispose();
  }

  // -- internals --------------------------------------------------------------

  /**
   * Put the non-weapon perks into the systems that carry them out.
   *
   * Each one is a single assignment, and each is cleared in `dispose`. The predicates
   * close over `PLAYER_ENTITY_ID` rather than over a roster lookup: only the local player
   * has a loadout in this build, and a bot asking "am I silent" should get the cheapest
   * possible no.
   */
  private applyPerkHooks(): void {
    const state = this.perkState;

    this.deps.player.speedScale = state.moveSpeedMult;

    this.deps.bots.silentFootsteps = state.audibleFootsteps
      ? null
      : (entityId) => entityId === PLAYER_ENTITY_ID;

    this.deps.equipment.flash.resistance =
      state.flashResistMult === 1
        ? null
        : (entityId) => (entityId === PLAYER_ENTITY_ID ? state.flashResistMult : 1);
  }

  private isMvp(): boolean {
    const rows = this.deps.score.rows;
    const mine = this.deps.score.row(PLAYER_ENTITY_ID);
    if (mine === undefined || mine.score <= 0) return false;
    for (const row of rows) {
      if (row === mine) continue;
      if (row.score >= mine.score) return false;
    }
    return true;
  }
}
