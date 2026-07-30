import { HitboxRig, HUMANOID_RIG } from '../combat/HitboxRig';
import { PLAYER_ENTITY_ID } from '../combat/DamageSystem';
import type { Health } from '../player/Health';
import type { MovementConfig } from '../player/MovementConfig';
import type { PlayerController } from '../player/PlayerController';
import type { BotTeam, Combatant } from './Combatant';

/**
 * The local player, seen from the AI's side of the fence.
 *
 * M2 already registered the player as a `Damageable` with a rig that follows the capsule;
 * this adds the three things perception and spawn safety need on top — a team, a facing and
 * a stance — and nothing else. It is a view over `PlayerController`, not a copy of it, so
 * there is no second pose to fall out of sync.
 *
 * `participating` is what makes the AFK bot-match harness possible: a spectating player is
 * still registered, still has a rig, and is simply not a combatant, so no bot looks for it
 * and no spawn is scored against it.
 */
export class PlayerCombatant implements Combatant {
  readonly entityId = PLAYER_ENTITY_ID;
  readonly displayName = 'OPERATOR';
  readonly rig = new HitboxRig(HUMANOID_RIG);

  /** Cleared for the AFK harness, where the human is a spectator. */
  active = true;

  constructor(
    readonly health: Health,
    readonly team: BotTeam,
    private readonly player: PlayerController,
    private readonly movement: MovementConfig,
  ) {}

  get px(): number {
    return this.player.sim.x;
  }
  get py(): number {
    return this.player.sim.y;
  }
  get pz(): number {
    return this.player.sim.z;
  }
  get yaw(): number {
    return this.player.sim.yaw;
  }
  get vx(): number {
    return this.player.sim.vx;
  }
  get vz(): number {
    return this.player.sim.vz;
  }
  get eyeHeight(): number {
    return this.player.sim.eyeHeight;
  }
  get aimHeight(): number {
    return 1.26 * this.rig.heightScale;
  }
  get quiet(): boolean {
    const stance = this.player.sim.stance;
    return stance === 'CROUCH' || stance === 'SLIDE';
  }
  get participating(): boolean {
    return this.active && this.health.alive;
  }

  /**
   * Keep the rig on the capsule. Called from the sim tick, never the render pass: a shot
   * is resolved on a tick, so it has to be resolved against where the player was on it.
   */
  syncRig(): void {
    const sim = this.player.sim;
    this.rig.heightScale = sim.capsuleHeight / Math.max(this.movement.standHeight, 1e-3);
    this.rig.setTransform(sim.x, sim.y, sim.z, sim.yaw);
  }
}
