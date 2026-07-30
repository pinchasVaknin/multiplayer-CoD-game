import type { BotTeam } from '../ai/Combatant';
import { Btn, isDown, justPressed, justReleased, type InputCommand } from '../core/InputCommand';
import { DT } from '../core/Loop';
import type { PlayerSim } from '../player/PlayerState';
import type { EquipmentConfig } from './EquipmentConfig';
import type { EquipmentDef, EquipmentSlot } from './EquipmentDefs';
import { EquipmentSystem, type EquipmentInventory } from './EquipmentSystem';

/**
 * The player's half of throwing: cooking, releasing and running out (brief S6.3).
 *
 * Split out of `EquipmentSystem` because that class is the *world's* view of equipment —
 * what is in the air and what it does — and this is one entity's input handling. A bot's
 * equivalent is `BotThrower`, and both end at the same `throwFrom` call, which is what
 * makes a bot's frag and a player's frag the same object with the same arc.
 *
 * **Cooking is a single clock.** The fuse starts when the button goes down, not when it
 * comes up, so a frag held for two seconds detonates a second and a half after it lands.
 * Hold it past `cookLimit` and it goes off in your hand — which is the only reason cooking
 * is a decision rather than a free upgrade.
 *
 * Runs on sim ticks and reads only the `InputCommand` bitfield (S4.2).
 */

export type ThrowPhase = 'IDLE' | 'COOKING';

/** Looking down past this angle drops it at your feet instead of lobbing it. */
const UNDERHAND_PITCH_RAD = -0.6;

export class ThrowController {
  phase: ThrowPhase = 'IDLE';
  /** Seconds the current cook has burned. */
  cook = 0;
  /** Which slot is being cooked. */
  slot: EquipmentSlot = 'lethal';

  private prevButtons = 0;

  constructor(
    private readonly system: EquipmentSystem,
    private readonly cfg: EquipmentConfig,
  ) {}

  reset(): void {
    this.phase = 'IDLE';
    this.cook = 0;
    this.prevButtons = 0;
  }

  /** Seconds of fuse left if it were released right now, for the HUD. */
  remainingFuse(inv: EquipmentInventory): number {
    if (this.phase !== 'COOKING') return 0;
    const def = EquipmentSystem.slotDef(inv, this.slot);
    return Math.max(0, def.fuseSeconds - this.cook);
  }

  /**
   * One sim tick.
   *
   * `alive` is false while dead: a corpse must not keep cooking, and a cook that survived
   * a respawn would detonate in the hand of the next life.
   */
  step(
    cmd: InputCommand,
    sim: PlayerSim,
    entityId: number,
    inv: EquipmentInventory,
    team: BotTeam,
    alive: boolean,
  ): void {
    const buttons = alive ? cmd.buttons : 0;
    const prev = this.prevButtons;
    this.prevButtons = buttons;

    if (!alive) {
      this.phase = 'IDLE';
      this.cook = 0;
      return;
    }

    if (this.phase === 'IDLE') {
      if (justPressed(buttons, prev, Btn.Lethal)) this.begin('lethal', inv);
      else if (justPressed(buttons, prev, Btn.Tactical)) this.begin('tactical', inv);
      return;
    }

    const bit = this.slot === 'lethal' ? Btn.Lethal : Btn.Tactical;
    const def = EquipmentSystem.slotDef(inv, this.slot);
    this.cook += DT;

    // Non-cookable equipment leaves the hand the instant the button is pressed; there is
    // nothing to hold. Cookable equipment waits for the release.
    if (!def.cookable) {
      this.release(def, sim, entityId, cmd, inv, team, 0);
      return;
    }

    if (this.cook >= def.cookLimit) {
      // Held too long. It goes off where it is, and `throwFrom` with a spent fuse is how
      // that happens — no second detonation path, and the killfeed reads as a suicide the
      // way it should.
      this.release(def, sim, entityId, cmd, inv, team, def.fuseSeconds);
      return;
    }

    if (justReleased(buttons, prev, bit) || !isDown(buttons, bit)) {
      this.release(def, sim, entityId, cmd, inv, team, this.cook);
    }
  }

  private begin(slot: EquipmentSlot, inv: EquipmentInventory): void {
    if (EquipmentSystem.slotCount(inv, slot) <= 0) return;
    this.slot = slot;
    this.phase = 'COOKING';
    this.cook = 0;
  }

  private release(
    def: EquipmentDef,
    sim: PlayerSim,
    entityId: number,
    cmd: InputCommand,
    inv: EquipmentInventory,
    team: BotTeam,
    cooked: number,
  ): void {
    this.phase = 'IDLE';
    this.cook = 0;
    if (EquipmentSystem.slotCount(inv, this.slot) <= 0) return;

    const underhand = cmd.pitch < UNDERHAND_PITCH_RAD || def.impact === 'plant';
    const thrown = this.system.throwFrom(
      def,
      entityId,
      team,
      sim.x,
      sim.y + sim.eyeHeight,
      sim.z,
      cmd.yaw,
      cmd.pitch,
      sim.vx,
      sim.vz,
      cooked,
      underhand,
    );
    // Only spend the slot if the pool actually had room. Silently eating a grenade because
    // thirty-two were already in the air would be the worst kind of invisible failure.
    if (thrown !== null) EquipmentSystem.spendSlot(inv, this.slot);
  }

  /** Seconds between indicator beeps, exposed so the HUD and the audio agree. */
  get beepInterval(): number {
    return this.cfg.beepInterval;
  }
}
