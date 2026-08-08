import { PLAYER_ENTITY_ID } from './DamageSystem';

/**
 * Which entity is *this* client (M10, playtest round 2).
 *
 * ## The bug this exists to end
 *
 * `PLAYER_ENTITY_ID` is 0 and has been since M2, when there was one player and the question
 * "is this event mine?" had one honest answer. Every piece of local presentation was written
 * against it — the hitmarker, the damage numbers, the hurt vignette, the hit-direction
 * chevron, the camera shake, the own-weapon audio mix, the own-footstep mix, the kill sound,
 * `ScoreSystem.isLocal`, `Killfeed.involvesLocal`.
 *
 * A connected human is entity **1..99**. Entity 0 is the server's empty spectator seat and
 * nothing on the wire ever carries it. So on a dedicated server every one of those
 * comparisons is false forever, and the failure is completely silent: the events arrive, the
 * bus dispatches them, the handlers run, and each one returns early. The player shoots
 * somebody, the server registers the hit, the damage event crosses the wire and is re-emitted
 * faithfully — and no hitmarker appears, because the client is still asking whether entity 0
 * fired it.
 *
 * This is the same mistake as the M10 death path, which keyed on `PLAYER_ENTITY_ID` and
 * therefore never fired, and it is the same mistake as the frozen HUD, which read a clock
 * nothing was winding. All three have one shape: **a fact the client used to own, that the
 * server now owns, still being read from where it used to live.**
 *
 * ## Why an object and not a number
 *
 * The id is not known when the objects that need it are constructed. The `Welcome` arrives
 * over a socket, milliseconds to seconds after `MatchFeedback`, `ScoreSystem` and `Killfeed`
 * exist. Passing a number would mean passing 0 and being wrong; passing a getter at every
 * call site would mean nine call sites that can each forget. One shared, mutable holder
 * handed out at construction means there is exactly one place the answer changes and every
 * reader sees it at once.
 *
 * Single-player never calls `adopt`, so it reads 0 and behaves exactly as M1-M8 did
 * (HARD RULE 8).
 */
export class LocalIdentity {
  private id: number = PLAYER_ENTITY_ID;
  private readonly listeners: Array<(entityId: number) => void> = [];

  /** The entity this client controls. `PLAYER_ENTITY_ID` until a server says otherwise. */
  get entityId(): number {
    return this.id;
  }

  /** True when this event, damage record or scoreboard row belongs to the local player. */
  is(entityId: number): boolean {
    return entityId === this.id;
  }

  /** Take the server's assignment from the `Welcome`. */
  adopt(entityId: number): void {
    if (entityId === this.id) return;
    this.id = entityId;
    for (const fn of this.listeners) fn(entityId);
  }

  /** Back to the single-player seat. Called when a session ends. */
  reset(): void {
    this.adopt(PLAYER_ENTITY_ID);
  }

  /**
   * Be told when the assignment changes.
   *
   * For the readers that cannot ask on demand because they have already *stored* the answer —
   * `ScoreSystem` stamps `isLocal` onto a row when it is registered, and a row registered
   * before the `Welcome` landed would carry the wrong one forever. Everything that can simply
   * call `is()` at the point of use should do that instead and ignore this.
   */
  onChange(fn: (entityId: number) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const at = this.listeners.indexOf(fn);
      if (at >= 0) this.listeners.splice(at, 1);
    };
  }
}

/**
 * The identity a non-networked consumer gets by default.
 *
 * Deliberately a factory rather than a shared singleton: two matches in one process must not
 * be able to write each other's identity, and a module-level instance is exactly the kind of
 * state that survives a teardown and leaks into the next match.
 */
export function localSinglePlayerIdentity(): LocalIdentity {
  return new LocalIdentity();
}
