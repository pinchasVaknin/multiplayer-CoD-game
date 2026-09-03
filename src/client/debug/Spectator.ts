import { CHEAT_FULL_SPECTATOR, Cheat, bitsClearing } from '../../shared/cheats/Cheats';

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
 * ## Round 4 (F14): this is a request now, and it holds no state at all
 *
 * The three switches used to be three booleans here, written through to `Match` and
 * `PlayerController`. They are cheat **entitlements** now — the same ones `SPEC[]1` to `SPEC[]4`
 * grant — because a client cannot decide any of them over a network: invulnerability and
 * perception are the server's, and a client that granted itself one would either be ignored or
 * be exploiting a hole. So every method here asks, through the one door that knows which kind of
 * match this is, and every getter reads the entitlement back.
 *
 * Two consequences worth knowing before using it:
 *
 * - **A request can be refused.** Against a server with `CHEATS_ENABLED` unset, nothing happens
 *   and the panel's checkbox stays clear — which is the honest reflection of the answer, and the
 *   reason the panel re-reads these getters on every refresh instead of remembering the click.
 * - **Invisibility no longer turns god mode on with it.** It did, with a good reason (a grenade
 *   already in the air does not know nobody is aiming at you), and that reason is now served by
 *   `full()` instead. Coupled, the two entitlements were indistinguishable: an effect asking
 *   *"am I unseen"* would have been answering *"am I unseen, or was god switched on beside it"*,
 *   and no probe could tell perception from invulnerability. An entitlement that means two things
 *   is not an entitlement.
 *
 * ## Nothing here holds state that gameplay reads
 *
 * Even more so than before. Every effect is derived from the mask every tick by the object that
 * owns the behaviour — `Match.syncChopperBody` for all three of them — so "turn it off and the
 * match is exactly as it was" is true by construction rather than by an undo path that has to be
 * maintained, and it needs no teardown.
 */
export interface SpectatorDeps {
  /** The live entitlement mask. `Game.cheatMask`, from the one authority that owns it. */
  readonly cheats: () => number;
  /**
   * Ask to toggle these entitlement bits, through `Game.requestCheatBits`.
   *
   * Bits rather than a code string, and `check-cheats.mjs` is what made that the answer rather
   * than a preference: it refuses a code literal anywhere outside the table, and it caught this
   * file naming four of them on its first run. The bits are looked up against the same table by
   * `cheatCodeToggling`, so there is still exactly one input to the feature and still nothing
   * downstream that can grant an entitlement without asking the authority.
   *
   * **It is a toggle, and that is not a way of saying "off".** See `full`.
   */
  readonly request: (bits: number) => void;
}

export class Spectator {
  private readonly deps: SpectatorDeps;

  constructor(deps: SpectatorDeps) {
    this.deps = deps;
  }

  get godMode(): boolean {
    return (this.deps.cheats() & Cheat.God) !== 0;
  }

  get invisible(): boolean {
    return (this.deps.cheats() & Cheat.Unseen) !== 0;
  }

  get freeCam(): boolean {
    return (this.deps.cheats() & Cheat.NoClip) !== 0;
  }

  /** True while any of the three is on. Read by the panel and the debug read-out. */
  get anyActive(): boolean {
    return this.godMode || this.invisible || this.freeCam;
  }

  /** All three on. */
  get allActive(): boolean {
    return this.godMode && this.invisible && this.freeCam;
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
    this.toggleTo(on, this.godMode, Cheat.God);
  }

  /**
   * Bots stop looking for the player entirely.
   *
   * `Combatant.participating` false removes the body from perception, from bot target selection
   * *and* from spawn scoring — the third one matters more than it looks. A hidden observer that
   * still repelled spawns would silently reshape where the fight happens, and the tool would be
   * changing the behaviour it was built to watch.
   *
   * It does **not** turn god mode on any more; see the note at the top of this file. A grenade,
   * a mortar or a sentry burst already in the air still resolves against an invisible body, and
   * dying while observing drops you into a respawn timer — which is what `full()` is for.
   */
  setInvisible(on: boolean): void {
    this.toggleTo(on, this.invisible, Cheat.Unseen);
  }

  /**
   * Fly, through walls.
   *
   * See `PlayerController.noclip`. Leaving it drops the player wherever they were floating
   * and hands them straight back to gravity and collision, which is the honest behaviour —
   * teleporting them back to where they took off would hide the case where the geometry you
   * flew out to inspect is geometry you cannot get out of.
   *
   * Over a network the server flies the body too, from the same replicated entitlement. There is
   * a window of up to one snapshot interval on each toggle where the two disagree about collision
   * and prediction corrects; see `NetPlayer.step`.
   */
  setFreeCam(on: boolean): void {
    this.toggleTo(on, this.freeCam, Cheat.NoClip);
  }

  /**
   * All three. The common case, and what the panel's headline button does.
   *
   * ## The two halves are not symmetrical, and assuming they were cost a real bug
   *
   * **On** is one request: the full-spectator code's own rule is *"complete the set unless it is
   * already complete"*, so asking for it with a subset up completes the set.
   *
   * **Off is not.** `toggleCheat` is a relative move, and toggling a three-bit set clears it only
   * when all three bits are already present — every other mask **widens to the full set**. This
   * method used to express *"off"* as one request for that code, and the result was the reported
   * mutation: a player holding god mode alone had `DebugSuite.dispose` call `reset()` on a
   * migration, the request landed on a mask the migration had already cleared to zero, and
   * `0 | God|Unseen|NoClip` arrived in the next match as **all three cheats on**. Holding all
   * three cleared correctly, which is exactly why it looked so arbitrary.
   *
   * So off asks for one single-bit toggle per bit that is actually set. `bitsClearing` decides
   * which, in `shared/`, where `check-cheats.mjs` proves over every one of the eight possible
   * masks that folding those toggles gives exactly zero.
   */
  full(on: boolean): void {
    if (on) {
      if (!this.allActive) this.deps.request(CHEAT_FULL_SPECTATOR);
      return;
    }
    // Decided against the mask as it is now, before any request is answered, which is what
    // makes one pass over the bits correct rather than racy.
    for (const bit of bitsClearing(this.deps.cheats(), CHEAT_FULL_SPECTATOR)) {
      this.deps.request(bit);
    }
  }

  /**
   * Put everything back. Called by `__operator.spectate.off()`, and by nothing else.
   *
   * **Not called on teardown any more.** `DebugSuite.dispose` did, from before F14, when these
   * three switches were booleans this class owned and `reset()` wrote them to false. Once they
   * became *requests*, that line stopped being the belt-and-braces its comment claimed and became
   * a cheat request sent during teardown — at the exact moment the server had cleared the seat's
   * entitlements — which is where the mutation above came from. The entitlement is not this
   * object's to clear: the server ends it at `unseat`, and every effect is derived from the mask
   * every tick, so there is nothing to undo.
   */
  reset(): void {
    this.full(false);
  }

  /** One line for the debug overlay's read-out. */
  describe(): string {
    if (!this.anyActive) return 'off';
    const parts: string[] = [];
    if (this.godMode) parts.push('god');
    if (this.invisible) parts.push('unseen');
    if (this.freeCam) parts.push('noclip');
    return parts.join(' · ');
  }

  /**
   * Ask only when the answer would change.
   *
   * The codes are toggles and these methods take a boolean, so a `setGodMode(true)` on a player
   * who already has it must send nothing — otherwise the console's idempotent-looking call would
   * turn the thing off.
   */
  private toggleTo(want: boolean, is: boolean, bits: number): void {
    if (want !== is) this.deps.request(bits);
  }
}
