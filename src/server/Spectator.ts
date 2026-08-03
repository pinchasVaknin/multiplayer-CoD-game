import { HitboxRig, HUMANOID_RIG } from '../shared/combat/HitboxRig';
import { PLAYER_ENTITY_ID } from '../shared/combat/DamageSystem';
import type { BotTeam, Combatant } from '../shared/ai/Combatant';
import { Health, type HealthConfig } from '../shared/player/Health';

/**
 * The seat where a local player would sit, permanently empty (M9, S4.9).
 *
 * *"It does not render, does not play, and has no local player."* Every player is a client,
 * including whoever started the match — so a server-side match has a roster of bots and, at
 * M10, of remote humans, and nobody at the keyboard here.
 *
 * `BotDirector` still wants a `player` in its roster, because perception, spawn scoring and
 * the aim model are written against `Combatant` and have no business knowing which entries
 * are human. Rather than change that seam — it is the M3 symmetry the brief says to preserve
 * — this fills it with a combatant that is never `participating`.
 *
 * That is exactly the mechanism the M3 AFK bot-match harness already used
 * (`PlayerCombatant.active = false`), which is why the headless harness works unchanged: no
 * bot looks for this entity, no spawn is scored against it, and perception skips it. It is
 * not a stub — an empty seat is the correct and complete state of a dedicated server, not a
 * missing feature.
 *
 * It holds a rig and health so it satisfies `Damageable` structurally, and neither is ever
 * used: it is not registered with the `DamageSystem`, so nothing can address it.
 */
export class Spectator implements Combatant {
  readonly entityId = PLAYER_ENTITY_ID;
  readonly displayName = 'SPECTATOR';
  readonly rig = new HitboxRig(HUMANOID_RIG);
  readonly health: Health;

  constructor(
    readonly team: BotTeam,
    healthConfig: HealthConfig,
  ) {
    this.health = new Health(healthConfig);
  }

  // A pose is required by the interface. It is the origin and it never moves, which is
  // harmless precisely because `participating` is false — nothing ever reads these.
  readonly px = 0;
  readonly py = 0;
  readonly pz = 0;
  readonly yaw = 0;
  readonly vx = 0;
  readonly vz = 0;
  readonly eyeHeight = 1.65;
  readonly aimHeight = 1.26;
  readonly quiet = true;
  readonly glinting = false;

  /** Never. This is the whole class. */
  get participating(): boolean {
    return false;
  }
}
