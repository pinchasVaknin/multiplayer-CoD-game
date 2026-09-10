import type { StanceId } from '../player/Stance';

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

/**
 * The small slice of actor state that selects a presentation animation.
 *
 * This deliberately belongs beside `RenderableActor`, instead of in a Three.js class.  A
 * local bot and a remote player already have these facts through different routes (simulation
 * state and snapshots respectively), but the renderer must not know which route supplied
 * them.  The values are presentation inputs only: no animation is permitted to write them
 * back into movement, hitboxes, or network state.
 */
export interface ActorAnimationInput {
  readonly stance: StanceId;
  readonly aiming: boolean;
  readonly sprinting: boolean;
  readonly reloading: boolean;
  readonly firing: boolean;
}

/**
 * Anything the bot renderer can draw (M10, S6.5).
 *
 * S6.5: *"Remote humans reuse the bot visual representation from M3 — same mesh, same stance
 * handling, same `HitboxRig`. **Do not author a second player model.**"*
 *
 * This interface is how that instruction is obeyed structurally rather than by discipline.
 * `Bot` satisfies it because it always did; a remote player reconstructed from snapshots
 * satisfies it too, and `BotRenderer` cannot tell them apart because there is nothing on here
 * that would let it. The renderer's mesh reconciliation, its serial-driven animation and its
 * team grouping are shared by both with no branch anywhere.
 */
export interface RenderableActor {
  readonly entityId: number;
  /** Replicated/profiled identity for the client-only overhead nameplate. */
  readonly displayName: string;
  readonly team: 'A' | 'B';
  readonly visual: BotVisualState;
  /** False while dead or not yet in the fight. Drives the initial fall pose. */
  readonly participating: boolean;
  /**
   * What this body is carrying, so the renderer can put it in their hands (round 5, F4).
   *
   * Not new state. A remote player's comes from `EntitySnapshot.weaponIndex`, which the
   * cosmetic audit already lists as §4.15 gameplay and which has been on the wire since M10;
   * a local bot's is the def `drawBotWeapon` dealt it at spawn. The interface is where the two
   * meet, exactly as it is for the pose — and it is the reason F4's first item needed no wire
   * change at all. Null means an unknown id, and an unarmed body is better than a wrong one.
   */
  readonly weaponId: string | null;
  /** Semantic state used to choose a visual animation. See `ActorAnimationInput`. */
  readonly animation: ActorAnimationInput;
  /**
   * Exact authoritative health fraction, exposed only for client presentation.
   *
   * The renderer reads this for its overhead bar; it cannot write health, hitboxes, or network
   * state through this interface.
   */
  readonly healthFraction: number;
  renderX(alpha: number): number;
  renderY(alpha: number): number;
  renderZ(alpha: number): number;
  renderYaw(alpha: number): number;
  /** Stance compression, 1 standing. */
  renderScale(alpha: number): number;
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
