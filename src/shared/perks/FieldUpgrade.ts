import { PLAYER_ENTITY_ID } from '../combat/DamageSystem';
import { EV, type GameBus } from '../core/Events';
import { Btn, justPressed, type InputCommand } from '../core/InputCommand';
import { DT } from '../core/Loop';
import { clamp01 } from '../core/MathUtil';
import { EquipmentSystem, type EquipmentInventory } from '../equipment/EquipmentSystem';
import { fieldUpgradeDef, type FieldUpgradeDef, type FieldUpgradeId } from '../meta/FieldUpgrades';
import type { Health } from '../player/Health';
import type { PlayerSim } from '../player/PlayerState';
import type { Inventory } from '../weapons/Inventory';

/**
 * The loadout's field upgrade: a charge, a key, and four real effects.
 *
 * Charged by time rather than by score, because a score-charged upgrade needs the streak
 * plumbing S9 defers to M7. The charge runs on sim ticks like every other gameplay timer
 * (S4.1) and pauses while the player is dead, so dying does not hand you a free
 * activation.
 *
 * Every effect is a single call into a system that already exists — see `FieldUpgrades.ts`
 * for why those four and not others. Nothing here has its own damage, its own physics or
 * its own entity: MUNITIONS calls `Weapon.addReserve` and `EquipmentSystem.refill`, STIM
 * calls `Health.healFull`, ARMOUR PLATE calls `Health.grantOverhealth`, and SMOKE SCREEN
 * calls the same `SmokeField.spawn` a thrown smoke does — which means the bots stop seeing
 * through it through the M3 perception path, with no new code at all.
 */

export interface FieldUpgradeDeps {
  readonly bus: GameBus;
  readonly equipment: EquipmentSystem;
  readonly inventory: EquipmentInventory;
  readonly weapons: Inventory;
  readonly health: Health;
}

const evReady = { upgradeId: '', entityId: PLAYER_ENTITY_ID };
const evUsed = { upgradeId: '', entityId: PLAYER_ENTITY_ID, x: 0, y: 0, z: 0 };

export class FieldUpgradeRuntime {
  /** 0..1. Drives the HUD ring. */
  charge = 0;
  /** Activations this match, for the F1 read-out. */
  uses = 0;

  private def: FieldUpgradeDef = fieldUpgradeDef('munitions');
  private wasReady = false;
  private prevButtons = 0;

  constructor(private readonly deps: FieldUpgradeDeps) {}

  get id(): FieldUpgradeId {
    return this.def.id;
  }

  get name(): string {
    return this.def.name;
  }

  get ready(): boolean {
    return this.charge >= 1;
  }

  /** Swap the equipped upgrade. The charge is kept: it is the player's, not the item's. */
  setUpgrade(id: FieldUpgradeId): void {
    this.def = fieldUpgradeDef(id);
    this.wasReady = false;
  }

  reset(): void {
    this.charge = 0;
    this.wasReady = false;
    this.prevButtons = 0;
  }

  /** One sim tick. */
  step(cmd: InputCommand, sim: PlayerSim, alive: boolean): void {
    const pressed = justPressed(cmd.buttons, this.prevButtons, Btn.FieldUpgrade);
    this.prevButtons = cmd.buttons;

    if (alive && this.charge < 1) {
      this.charge = clamp01(this.charge + DT / Math.max(this.def.chargeSeconds, 0.1));
      if (this.charge >= 1 && !this.wasReady) {
        this.wasReady = true;
        evReady.upgradeId = this.def.id;
        this.deps.bus.emit(EV.FieldUpgradeReady, evReady);
      }
    }

    if (!pressed || !alive || this.charge < 1) return;
    this.activate(sim);
  }

  private activate(sim: PlayerSim): void {
    const def = this.def;

    if (def.resupply) {
      // Both slots, not just the one in hand: a resupply that leaves the pistol empty is
      // a resupply the player has to think about, which is not what the item is for.
      for (const weapon of this.deps.weapons.all) {
        weapon.addReserve(weapon.definition.reserveAmmo);
      }
      EquipmentSystem.refill(this.deps.inventory);
    }
    if (def.heal) this.deps.health.healFull();
    if (def.overhealth > 0) this.deps.health.grantOverhealth(def.overhealth);
    if (def.smokeSeconds > 0) {
      this.deps.equipment.smoke.spawn(
        sim.x,
        sim.y + 0.6,
        sim.z,
        def.smokeRadius,
        def.smokeSeconds,
        1.0,
      );
    }

    this.charge = 0;
    this.wasReady = false;
    this.uses++;
    evUsed.upgradeId = def.id;
    evUsed.x = sim.x;
    evUsed.y = sim.y;
    evUsed.z = sim.z;
    this.deps.bus.emit(EV.FieldUpgradeUsed, evUsed);
  }
}
