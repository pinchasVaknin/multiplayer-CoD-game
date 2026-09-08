import { MAX_PELLETS } from '../weapons/WeaponDefs';

/**
 * What counts as a shot, and what counts as a hit (playtest round 5, B5).
 *
 * The report was `CINDER · ACC 267%` on the post-match board, out of `25 shots / 62 hits`, and
 * it was not a rendering fault: `ScoreSystem` incremented `shotsFired` from `weapon.fired` —
 * one trigger pull, one increment, correct — and `shotsHit` from `damage.dealt`, which is one
 * *damage event*. Those are two different populations. A shotgun pull produces up to eight
 * damage events; a frag that catches three people produces three and no pull at all; so did a
 * knife, a mortar and a Chopper Gunner's belt, all of which apply damage under the owner's
 * `sourceId`. Divide one by the other and the number has no ceiling.
 *
 * `meta/MatchProgression` had it right from M5 — `tally.shotsFired += p.pellets` — so the game
 * carried two definitions of one statistic and showed them on two different screens: the
 * per-weapon accuracy in Create-a-Class was right while the scoreboard column beside it was
 * not. This module is the one definition left standing.
 *
 * ## The definition
 *
 * **A shot is one ray that left a barrel. A hit is one ray that found a body.**
 *
 * `weapon.fired` already carries both numbers — `pellets` and `pelletsHit`, added at M5 for
 * exactly the reason quoted in `core/Events`: one trigger pull is one event even for a shotgun.
 * So the whole statistic is a property of a single event, and nothing has to be correlated
 * across two.
 *
 * ## What is deliberately not a hit, and why it is a decision rather than an omission
 *
 * Explosives, equipment, melee and killstreak weapons deal damage and are **not** counted.
 * Accuracy is a weapon-handling figure: it answers *"of the rounds you sent, how many
 * connected"*, and a grenade sends none. Counting it inflated the numerator with no
 * denominator to match, which is the second, smaller half of B5 that nobody reported.
 *
 * The decision is enforced by shape rather than by discipline. Both functions take a
 * `FiredShot`, and a `damage.dealt` payload cannot satisfy it — so a future counter that
 * subscribes to damage and reaches for these gets a compile error instead of a percentage over
 * one hundred. That is the point of the pair: five call sites used to agree by luck, and the
 * type is what makes them agree on purpose.
 *
 * `SentryGun` and `ChopperGunner` keep their own `shotsFired`/`shotsHit` for their own debug
 * read-outs, and those are the same definition — each `stepFiring` sends exactly one ray and
 * counts it — but they are the *turret's* numbers on the turret's panel. They never enter a
 * player's row, and after this change they cannot: the only writer of a `PlayerScore`'s shot
 * counters is the `weapon.fired` handler.
 */

/**
 * How many rays a pull sends.
 *
 * Satisfied by a `WeaponDef` as well as by a fired shot, because the fire loop has to ask
 * before the shot exists and everything that counts it asks afterwards — and those two have
 * to be the same number or the denominator is a different weapon's.
 */
export interface PelletCount {
  /** Rays one pull sends. */
  readonly pellets: number;
}

/**
 * One trigger pull, as everything that counts shots sees it.
 *
 * Structurally satisfied by `EV.WeaponFired`'s payload, which is the only event that carries
 * both halves. Kept as its own interface so a caller holding the two numbers from somewhere
 * else — a replicated `FiredEvent` plus the weapon table it resolves against — can still ask.
 */
export interface FiredShot extends PelletCount {
  /** How many of them found a body. */
  readonly pelletsHit: number;
}

/**
 * How many shots this trigger pull is worth.
 *
 * Clamped the same way `WeaponSystem` clamps its own fire loop, and for the same two reasons:
 * `WeaponDef.pellets` is writable from the tuning panel, and on a client this number is
 * resolved from a weapon index that arrived over a socket. A decoder must not be able to make
 * the denominator zero.
 */
export function shotsFrom(fired: PelletCount): number {
  return Math.max(1, Math.min(MAX_PELLETS, Math.round(fired.pellets)));
}

/**
 * How many of them connected.
 *
 * Bounded by the shot count rather than trusted, for the wire's sake — six bits of a
 * replicated byte decide this on a client. The bound is a decoder guard and not the thing that
 * makes the figure right: that `pelletsHit <= pellets` holds for every shape a weapon can fire
 * is asserted against the real ballistics path by `debug/AccuracyAudit`.
 */
export function hitsFrom(fired: FiredShot): number {
  return Math.max(0, Math.min(shotsFrom(fired), Math.round(fired.pelletsHit)));
}
