/**
 * The cosmetic side of a bot, as plain replicable data (M9).
 *
 * S4.15 draws the line: position and death are server-authoritative, and what a death
 * *looks like* is client-only, driven by a replicated event. Before M9 there was no line —
 * `Bot` held a `BotMesh` and called `beginDeath()` on it inside `onKilled`, so the fall
 * animation was a side effect of the simulation and could not run without a renderer.
 *
 * This struct is what took its place. Every field is a number, so it costs nothing to
 * snapshot and nothing to send. The renderer keeps its own copy of the serials, compares
 * them each frame, and starts an animation when one has moved. A missed frame cannot lose
 * an event — the serial is still different — which a callback would not have guaranteed.
 */
export interface BotVisualState {
  /**
   * Bumped every time this bot dies. The client starts a fall when it changes.
   *
   * A counter rather than a boolean because a bot can die, respawn and die again inside
   * the interval between two rendered frames at a low frame rate.
   */
  deathSerial: number;
  /** Direction the killing round was travelling. Gives the fall its direction (S6.8). */
  deathDirX: number;
  deathDirZ: number;
  /**
   * Which of the authored fall animations to play.
   *
   * Derived per-event from `(entityId, deathSerial)` rather than drawn from the bot's own
   * `Rng` — S4.14. A free-running stream advances differently when reconciliation replays
   * a tick, and a cosmetic draw sitting in the middle of that stream would shift every
   * subsequent spread and aim-error value on the replay. Here the server can pick a
   * variant it will never draw and the client can pick the same one, with neither of them
   * perturbing anything else.
   */
  deathVariant: number;

  /** Bumped every time this bot respawns. The client clears the fall and shows the body. */
  spawnSerial: number;

  /** Bumped on every non-fatal hit. */
  flinchSerial: number;
  /** Direction the hit came from, for the flinch lean (S6.8). */
  flinchDirX: number;
  flinchDirZ: number;
}

export function makeBotVisualState(): BotVisualState {
  return {
    deathSerial: 0,
    deathDirX: 0,
    deathDirZ: 0,
    deathVariant: 0,
    spawnSerial: 0,
    flinchSerial: 0,
    flinchDirX: 0,
    flinchDirZ: 0,
  };
}

/**
 * Pick a death animation variant from the entity and the death count.
 *
 * Deterministic and stateless: the same bot's third death is always the same variant, in
 * Node and in the browser, on a first run and on a replay. This is the per-event seeding
 * S4.14 asks for, applied to the one cosmetic draw that was sitting in a gameplay stream.
 *
 * Integer hash (splitmix32 finalizer), so consecutive deaths do not produce consecutive
 * variants — `(entityId, 1)` and `(entityId, 2)` land far apart.
 */
export function deathVariantFor(entityId: number, deathSerial: number, variants: number): number {
  let z = (Math.imul(entityId, 0x9e3779b9) + Math.imul(deathSerial, 0x85ebca6b)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  z = (z ^ (z >>> 15)) >>> 0;
  return variants <= 0 ? 0 : z % variants;
}

/**
 * How many fall animations exist.
 *
 * The number lives here rather than in `client/ai/BotMesh.ts` because the *choice* is made
 * in the simulation and has to be identical on a server that has no meshes to count. The
 * mesh asserts against it — see `BotMesh.beginDeath`.
 */
export const DEATH_VARIANTS = 4;
