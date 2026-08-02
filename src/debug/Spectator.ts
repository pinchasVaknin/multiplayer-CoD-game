import type { Match } from '../Match';
import type { PlayerController } from '../player/PlayerController';

/**
 * The QA spectator: god mode, invisibility and free-cam (post-M8).
 *
 * ## Three switches, and why they are three rather than one
 *
 * The playbook asks for a "spectator mode", and the obvious build is a single flag that turns
 * all of it on together. That is the wrong shape for the job it is being built for, because
 * the three answer different questions and are wanted in different combinations:
 *
 * - **God mode** alone is how you stand in the open with a stopwatch and find out how long a
 *   VETERAN bot takes to notice you and how much damage it does when it has.
 * - **Invisibility** alone is how you watch a firefight resolve without being in it. The
 *   moment the observer is also a *target*, the behaviour being observed is behaviour toward
 *   the observer, which is precisely what a natural-behaviour tool must not produce.
 * - **Free-cam** alone is how you inspect a collider seam or a spawn cluster, and you very
 *   often want to do that while still being shootable — a noclip that was also invulnerable
 *   could not be used to reproduce the "I got stuck in this doorway" bug you flew out to look
 *   at.
 *
 * So they are independent, and `full()` turns on all three for the common case.
 *
 * ## Nothing here holds state that gameplay reads
 *
 * Every switch writes through to the object that already owns the behaviour — `Match` for the
 * two combat facts, `PlayerController` for the movement one — and those are re-applied from
 * state every tick by code that existed before this file (`Match.syncChopperBody` is the
 * example worth reading). This class is the *toggle*, not the mechanism, which is what makes
 * "turn it off and the match is exactly as it was" true by construction rather than by an
 * undo path that has to be maintained.
 *
 * That also means it needs no teardown: `MatchWorld` disposes the match and the controller,
 * and a spectator holding references to two objects that are gone is simply garbage.
 */
export class Spectator {
  private readonly match: Match;
  private readonly player: PlayerController;

  private god = false;
  private hidden = false;
  private fly = false;

  constructor(match: Match, player: PlayerController) {
    this.match = match;
    this.player = player;
  }

  get godMode(): boolean {
    return this.god;
  }

  get invisible(): boolean {
    return this.hidden;
  }

  get freeCam(): boolean {
    return this.fly;
  }

  /** True while any of the three is on. Read by the HUD banner and the debug read-out. */
  get anyActive(): boolean {
    return this.god || this.hidden || this.fly;
  }

  /**
   * Zero damage, and cannot die.
   *
   * Implemented at the damage door rather than by topping health up: `Damageable.invulnerable`
   * is tested inside `DamageSystem.apply` before anything is subtracted, so a god-mode player
   * takes no damage *events* either — no hit flinch, no hurt vignette, no directional
   * indicator, no low-health muffle. Regenerating a hundred times a second would have left
   * all of those firing and made the mode unusable for watching anything.
   */
  setGodMode(on: boolean): void {
    this.god = on;
    this.match.godMode = on;
  }

  /**
   * Bots stop looking for the player entirely.
   *
   * `PlayerCombatant.active` false removes the body from perception, from bot target
   * selection *and* from spawn scoring — the third one matters more than it looks. A hidden
   * observer that still repelled spawns would silently reshape where the fight happens, and
   * the tool would be changing the behaviour it was built to watch.
   *
   * God mode is turned on alongside it, and that is not a convenience: an entity nobody is
   * aiming at can still be caught by a grenade, a mortar or a sentry burst that was already
   * in the air, and dying while invisible would drop the observer into a respawn timer in the
   * middle of the fight they were recording.
   */
  setInvisible(on: boolean): void {
    this.hidden = on;
    this.match.hiddenFromBots = on;
    if (on) this.setGodMode(true);
  }

  /**
   * Fly, through walls.
   *
   * See `PlayerController.noclip`. Leaving it drops the player wherever they were floating
   * and hands them straight back to gravity and collision, which is the honest behaviour —
   * teleporting them back to where they took off would hide the case where the geometry you
   * flew out to inspect is geometry you cannot get out of.
   */
  setFreeCam(on: boolean): void {
    this.fly = on;
    this.player.noclip = on;
  }

  /** All three. The common case, and what the panel's headline button does. */
  full(on: boolean): void {
    this.setGodMode(on);
    this.setInvisible(on);
    this.setFreeCam(on);
  }

  /** Put everything back. Called when the panel is closed and by `__operator.spectate.off()`. */
  reset(): void {
    this.full(false);
  }

  /** One line for the debug overlay's read-out. */
  describe(): string {
    if (!this.anyActive) return 'off';
    const parts: string[] = [];
    if (this.god) parts.push('god');
    if (this.hidden) parts.push('unseen');
    if (this.fly) parts.push('noclip');
    return parts.join(' · ');
  }
}
