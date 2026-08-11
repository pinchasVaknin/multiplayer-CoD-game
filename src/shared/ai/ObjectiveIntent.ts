import type { Combatant } from './Combatant';

/**
 * The seam that lets a bot play the objective without `ai/` knowing what a mode is (M7).
 *
 * The brief's hard requirement for this milestone is that bots rotate to contested flags,
 * collect dog tags, and plant and defuse bombs — "the requirement that separates a real mode
 * from a deathmatch with decoration". The obvious way to get there is to let `BotBrain` ask
 * the mode what to do, and it is the wrong way: S3 forbids systems reaching into each other,
 * and a brain that imports `Domination` is a brain that has to be edited for every mode ever
 * added.
 *
 * So the flow is inverted, exactly as `BotDirector.silentFootsteps` inverts the Dead Silence
 * question. `ai/` asks one thing — *"where should this combatant be, and what should it do
 * when it gets there?"* — and a mode answers. The brain understands `action` and nothing else;
 * it has no idea whether it is capturing a flag or defusing a bomb, and it does not need to.
 *
 * The provider is polled at the brain's own tactical rate (~4 Hz), never per tick, and is
 * expected to be cheap: it is a lookup against state the mode is already maintaining.
 */

/** What a bot should do with the point it has been sent to. */
export type ObjectiveAction = 'capture' | 'defend' | 'plant' | 'defuse' | 'collect';

export interface ObjectiveTarget {
  /** Stable id, so the debug panel can name what each bot is pursuing. */
  readonly id: string;
  /** Short label for the overlay — a flag letter, a site letter, a tag number. */
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** How close counts as arrived, metres. */
  readonly radius: number;
  readonly action: ObjectiveAction;
  /**
   * How strongly the bot should prefer this over fighting, 0..1.
   *
   * Below `OBJECTIVE_IGNORE_BELOW` the bot keeps fighting and treats the objective as a
   * suggestion; at 1 it will break off a firefight to go. This is what stops every bot on a
   * team leaving home at once — the mode hands out high priorities sparingly.
   */
  readonly priority: number;
}

/**
 * Implemented by a mode. `assign` is called for one combatant at a time and may return the
 * same target for several of them — the mode decides how many bodies an objective is worth.
 */
export interface ObjectiveProvider {
  assign(bot: Combatant): ObjectiveTarget | null;
  /**
   * Called when a bot is standing inside `radius` of the target it was given, once per
   * tactical decision. This is where a plant timer advances or a tag is collected — the mode
   * owns the rule, the bot only reports that it is there and not dead.
   */
  onArrived(bot: Combatant, target: ObjectiveTarget): void;
}

/** Below this priority a bot in contact keeps shooting rather than walking away. */
export const OBJECTIVE_IGNORE_BELOW = 0.5;

/** Scratch target, reused so `assign` implementations can avoid allocating per call. */
export function makeObjectiveTarget(): MutableObjectiveTarget {
  return { id: '', label: '', x: 0, y: 0, z: 0, radius: 2, action: 'capture', priority: 0 };
}

export type MutableObjectiveTarget = {
  -readonly [K in keyof ObjectiveTarget]: ObjectiveTarget[K];
};

/**
 * Whether a mode also plays the objective-provider role.
 *
 * A structural test rather than an `instanceof` chain: a composition root is handed modes by
 * the registry and has no business importing four concrete classes to ask them what they are.
 *
 * **Shared rather than private to the client (M11 Gate B).** It lived in `ClientMatch` and the
 * dedicated server never had an equivalent, so `BotDirector.objectives` was null in every
 * networked match: server-side bots pursued no flag, collected no dog tag, and — the visible
 * one — never picked the bomb up, so no Search & Destroy round played on the server was ever
 * decided by a plant. The mode moved to the server at M9 and this wiring did not come with it.
 * One definition, imported by both roots, is the fix that keeps it from drifting again.
 */
export function isObjectiveProvider<T extends object>(mode: T): mode is T & ObjectiveProvider {
  const candidate = mode as Partial<ObjectiveProvider>;
  return typeof candidate.assign === 'function' && typeof candidate.onArrived === 'function';
}
