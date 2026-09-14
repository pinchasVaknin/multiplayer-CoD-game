import type { HitZone } from '../combat/HitboxRig';
import type { ScoreSystem } from '../combat/ScoreSystem';
import { hitsFrom, shotsFrom } from '../combat/ShotAccounting';
import { EV, type GameBus } from '../core/Events';
import { DT } from '../core/Loop';
import type { PlayerSim } from '../player/PlayerState';
import type { WeaponClass } from '../weapons/WeaponDefs';
import { WEAPON_DEFS } from '../weapons/WeaponDefs';
import type { WeaponSystem } from '../weapons/WeaponSystem';
import { MULTIKILL_WINDOW, SLIDE_KILL_GRACE, type KillFact } from './Challenges';
import {
  matchFloorLine,
  matchMinutes,
  LONGSHOT_METRES,
  WEAPON_XP_FRACTION,
  xpSource,
  XP_SOURCES,
  type XpLine,
  type XpLines,
  type XpSourceId,
} from './XpRules';
import { Disposable } from '../core/Disposable';

/**
 * One seat's match, counted (M13 Phase B, bug 4.2).
 *
 * ## Why this is a class of its own
 *
 * `MatchProgression` has counted a match since M6 — kills, headshots, longshots, assists, the
 * time played — and then banked it into a profile and a challenge tracker. Every piece of that
 * counting was written against `PLAYER_ENTITY_ID`, because there was one player and one
 * profile. A dedicated server has neither: it has *seats*, each with an entity id the client
 * did not choose, and no profile at all (§6.9: no accounts). So the server paid a flat
 * `MATCH COMPLETE`, a `WIN BONUS` to everybody and a `TOP OPERATOR` to everybody, and nothing
 * for a kill — the reported "the server pays nothing for what I did".
 *
 * This is the counting, lifted out and keyed to **any** entity. `MatchProgression` still owns
 * the profile, the challenges and the banking, and composes one of these for the local
 * player; `LiveMatch` composes one per seated human and asks it for lines at the summary. The
 * two runtimes now count with the same code, which is what `MatchXpAudit`'s second half
 * asserts: the same events through a solo progression and a server ledger produce the same
 * lines.
 *
 * ## What it counts and what it does not
 *
 * Everything in `XP_SOURCES` that is a fact about the match: kills, headshots, longshots,
 * assists and the best streak (both read off the seat's score row, which is the one tally of
 * those), objectives (the row's five objective columns — Domination's captures had never paid
 * their 200, because nothing called `noteObjective`), minutes, the win and the MVP. The two
 * rows it does *not* price are `challenge` and `weaponLevel`: both are facts about a save, and
 * the server has no save. `MatchProgression` adds them.
 *
 * Per-weapon tallies and the described `KillFact` are kept because they are the same counting
 * and cost nothing; `onKill` is where a client hands the fact to its challenge tracker, and a
 * server passes nothing.
 *
 * Six subscriptions that increment integers, no allocation per event once the per-weapon
 * tallies exist, and nothing here can change what a match does.
 */

/** Blast profiles carry their own weapon ids; a kill from one is an equipment kill. */
const EQUIPMENT_WEAPON_PREFIX = 'eq_';

/** Kills remembered for the multikill window. Nothing in this game exceeds four. */
const KILL_RING = 8;

export interface MatchLedgerDeps {
  readonly bus: GameBus;
  readonly score: ScoreSystem;
  /** The seat this ledger follows. Re-keyed by `adopt` when a returning player is re-seated. */
  readonly entityId: number;
  /** Every kill this seat made, described. The client's challenge tracker; a server has none. */
  readonly onKill?: ((fact: KillFact) => void) | undefined;
  /** This seat blinded somebody else. Same consumer. */
  readonly onFlash?: (() => void) | undefined;
}

/** Per-weapon deltas, accumulated for the match and folded into a save at the end. */
export interface WeaponTally {
  kills: number;
  headshots: number;
  longshots: number;
  multikills: number;
  shotsFired: number;
  shotsHit: number;
  longestShot: number;
  timeUsed: number;
  xp: number;
}

function makeTally(): WeaponTally {
  return {
    kills: 0,
    headshots: 0,
    longshots: 0,
    multikills: 0,
    shotsFired: 0,
    shotsHit: 0,
    longestShot: 0,
    timeUsed: 0,
    xp: 0,
  };
}

/** What the two client-only rows are worth, supplied by whoever owns a save. */
export interface LedgerExtras {
  /** Challenges completed this match, and the XP they awarded between them. */
  readonly challenges: number;
  readonly challengeXp: number;
  /** Weapons that gained a level this match. */
  readonly weaponLevels: number;
}

const NO_EXTRAS: LedgerExtras = { challenges: 0, challengeXp: 0, weaponLevels: 0 };

export class MatchLedger extends Disposable {
  /** The seat. Written by `adopt` alone. */
  entityId: number;

  /** Per-source counts, keyed by XP source. */
  private readonly counts = new Map<XpSourceId, number>();
  readonly weaponTallies = new Map<string, WeaponTally>();
  private readonly killTicks: number[] = new Array<number>(KILL_RING).fill(-99999);
  private killRingHead = 0;

  private readonly deps: MatchLedgerDeps;

  // ---- context sampled once per tick, so a kill can be described ------------
  private heldWeaponId = '';
  private heldWeaponClass: WeaponClass = 'AR';
  private adsFraction = 0;
  private sliding = false;
  private airborne = false;
  private sinceSlide = 999;
  private tick = 0;

  // ---- kill context --------------------------------------------------------
  /** Range of the most recent damage this seat dealt, metres. */
  private lastDamageDistance = 0;
  private lastDamageTarget = -1;
  private killsThisMag = 0;
  private lastKilledBy = -1;

  /** Objectives noted by hand — the XP simulator's door. The row's columns are the real one. */
  private objectives = 0;
  /** Ticks this ledger has been sampled through. See `sample`. */
  private ticksPlayed = 0;

  constructor(deps: MatchLedgerDeps) {
    super();
    this.deps = deps;
    this.entityId = deps.entityId;
    const bus = deps.bus;

    this.own(
      bus.on(EV.WeaponFired, (p) => {
        if (p.sourceId !== this.entityId) return;
        const tally = this.tally(p.weaponId);
        // This was already the right definition when `ScoreSystem` had the wrong one (round 5,
        // B5). It reads through `ShotAccounting` now so there is one of it rather than two that
        // happen to match.
        tally.shotsFired += shotsFrom(p);
        tally.shotsHit += hitsFrom(p);
      }),
      bus.on(EV.DamageDealt, (p) => {
        if (p.sourceId !== this.entityId) return;
        this.lastDamageDistance = p.distance;
        this.lastDamageTarget = p.targetId;
        const tally = this.tally(p.weaponId);
        if (p.distance > tally.longestShot) tally.longestShot = p.distance;
      }),
      bus.on(EV.EntityKilled, (p) => this.onKilled(p.sourceId, p.targetId, p.weaponId, p.zone)),
      bus.on(EV.EquipmentFlashed, (p) => {
        if (p.sourceId !== this.entityId || p.targetId === this.entityId) return;
        deps.onFlash?.();
      }),
      bus.on(EV.WeaponReloadFinished, (p) => {
        if (p.sourceId === this.entityId) this.killsThisMag = 0;
      }),
      bus.on(EV.WeaponSwapped, (p) => {
        if (p.sourceId === this.entityId) this.killsThisMag = 0;
      }),
      bus.on(EV.PlayerSpawned, (p) => {
        if (p.entityId === this.entityId) this.killsThisMag = 0;
      }),
    );
  }

  /**
   * One sim tick of context.
   *
   * Eight field writes and one `Map.get`, both on keys that already exist after the first
   * tick — allocation free in the steady state, which is what S4.7 asks of anything on
   * this path. A server never calls this: it has no per-seat weapon view to sample and passes
   * the match's own length to `lines` instead, which is the same number this counts.
   */
  sample(sim: PlayerSim, weapons: WeaponSystem, tickIndex: number): void {
    this.tick = tickIndex;
    const def = weapons.definition;
    this.heldWeaponId = def.id;
    this.heldWeaponClass = def.class;
    this.adsFraction = weapons.weapon.adsFraction;
    this.sliding = sim.slideActive;
    this.airborne = !sim.grounded && !sim.slideActive;
    this.sinceSlide = sim.slideActive ? 0 : Math.min(999, this.sinceSlide + DT);
    this.tally(def.id).timeUsed += DT;
    /**
     * How long this match has run, for `matchTime` (round 5, B6).
     *
     * **Ticks, converted once**, and not `+= DT` like the per-weapon line above it. `DT` is
     * `1/60`, which no float can hold, so a sum of thirty-six thousand of them lands at
     * 599.999999999783 — and `matchMinutes` floors, so a ten-minute match paid for nine. The
     * audit caught it because it prints the minutes it asked for beside the minutes it got.
     * An integer count multiplied at the end has no drift to accumulate.
     */
    this.ticksPlayed++;
  }

  /**
   * An objective was scored, by hand (S6.1's 200/objective).
   *
   * The modes credit objectives through `ScoreSystem.recordObjective`, and `lines` reads the
   * row's five objective columns — so this is only for a caller with no score row, which is
   * the XP simulator.
   */
  noteObjective(count = 1): void {
    this.objectives += count;
  }

  /**
   * A returning player was re-seated as a different entity (M13 Phase B, bug 4.3).
   *
   * The ledger follows the person, exactly as their score row does — see `ScoreSystem.adopt`.
   */
  adopt(entityId: number): void {
    this.entityId = entityId;
  }

  get killCount(): number {
    return this.counts.get('kill') ?? 0;
  }

  /** Seconds this ledger has been sampled through. */
  get secondsPlayed(): number {
    return this.ticksPlayed * DT;
  }

  /**
   * The breakdown, as the summary draws it.
   *
   * `seconds` is the match's length. A client passes what it sampled; a server passes
   * `tickCount * DT`, which is the decision B6 asked for — the award is for the match, so a
   * player who dropped and came back cannot lose the minutes before the drop. Assists, the best
   * streak and the objectives are read off the seat's score row here rather than counted twice.
   */
  lines(won: boolean, isMvp: boolean, seconds: number, extras: LedgerExtras = NO_EXTRAS): XpLines {
    const row = this.deps.score.row(this.entityId);
    const bestStreak = row?.bestStreak ?? 0;
    const assists = row?.assists ?? 0;
    const objectives =
      this.objectives +
      (row === undefined ? 0 : row.captures + row.defends + row.plants + row.defuses + row.tags);
    const minutes = matchMinutes(seconds);

    const out: XpLine[] = [];
    for (const source of XP_SOURCES) {
      // The floor is the head of the list rather than one more row the loop might drop, and
      // that is what makes `XpLines` non-empty without the renderer having to check.
      if (source.id === 'matchComplete') continue;
      let count = this.counts.get(source.id) ?? 0;
      if (source.id === 'matchTime') count = minutes;
      if (source.id === 'assist') count = assists;
      if (source.id === 'objective') count = objectives;
      if (source.id === 'win') count = won ? 1 : 0;
      if (source.id === 'mvp') count = isMvp ? 1 : 0;
      if (source.id === 'streak') count = bestStreak;
      if (source.id === 'challenge') count = extras.challenges;
      if (source.id === 'weaponLevel') count = extras.weaponLevels;
      if (count <= 0) continue;
      // A challenge carries its own award, so the row's total is the sum of what completed
      // rather than `count x value` — the one source in the table whose XP is data.
      const xp =
        source.id === 'challenge'
          ? extras.challengeXp
          : source.kind === 'flat'
            ? source.value
            : count * source.value;
      out.push({ id: source.id, label: source.label, count, xp, kind: source.kind });
    }
    return [matchFloorLine(), ...out];
  }

  // -- internals --------------------------------------------------------------

  private onKilled(sourceId: number, targetId: number, weaponId: string, zone: HitZone): void {
    if (targetId === this.entityId) {
      // Remember who did it, so PAYBACK can be a real challenge rather than a flavour text.
      this.lastKilledBy = sourceId;
      this.killsThisMag = 0;
      return;
    }
    if (sourceId !== this.entityId) return;

    const fact = this.buildKillFact(targetId, weaponId, zone);
    this.bump('kill', 1);
    if (fact.headshot) this.bump('headshot', 1);
    if (fact.distance >= LONGSHOT_METRES) this.bump('longshot', 1);

    const tally = this.tally(fact.weaponId);
    tally.kills++;
    if (fact.headshot) tally.headshots++;
    if (fact.distance >= LONGSHOT_METRES) tally.longshots++;
    if (fact.killsThisMag === 2) tally.multikills++;

    // Per-weapon XP is a fraction of what this kill paid the account, so a weapon can
    // never level from something the player was not rewarded for.
    const killXp =
      xpSource('kill').value +
      (fact.headshot ? xpSource('headshot').value : 0) +
      (fact.distance >= LONGSHOT_METRES ? xpSource('longshot').value : 0);
    tally.xp += killXp * WEAPON_XP_FRACTION;

    this.deps.onKill?.(fact);
  }

  private buildKillFact(targetId: number, weaponId: string, zone: HitZone): KillFact {
    const equipment = weaponId.startsWith(EQUIPMENT_WEAPON_PREFIX);
    // A grenade kill is attributed to the grenade, not to whatever was in your hands.
    const resolvedId = equipment ? weaponId : this.heldWeaponId || weaponId;
    const def = WEAPON_DEFS[resolvedId];

    if (!equipment) this.killsThisMag++;
    this.killTicks[this.killRingHead] = this.tick;
    this.killRingHead = (this.killRingHead + 1) % KILL_RING;

    const windowTicks = MULTIKILL_WINDOW / DT;
    let killsInWindow = 0;
    for (const t of this.killTicks) {
      if (this.tick - t <= windowTicks) killsInWindow++;
    }

    const distance = this.lastDamageTarget === targetId ? this.lastDamageDistance : 0;
    const streak = this.deps.score.row(this.entityId)?.streak ?? 0;

    return {
      weaponId: resolvedId,
      weaponClass: equipment ? 'LAUNCHER' : (def?.class ?? this.heldWeaponClass),
      zone,
      headshot: zone === 'head',
      distance,
      ads: this.adsFraction > 0.5,
      // A kill in the beat after a slide still reads as a slide kill to the player, which
      // is what the challenge is about — the shot is fired before the stance has settled.
      sliding: this.sliding || this.sinceSlide <= SLIDE_KILL_GRACE,
      airborne: this.airborne,
      equipment,
      killsThisMag: equipment ? 0 : this.killsThisMag,
      killsInWindow,
      streak,
      revenge: targetId === this.lastKilledBy,
    };
  }

  private bump(id: XpSourceId, by: number): void {
    this.counts.set(id, (this.counts.get(id) ?? 0) + by);
  }

  private tally(weaponId: string): WeaponTally {
    const existing = this.weaponTallies.get(weaponId);
    if (existing !== undefined) return existing;
    const fresh = makeTally();
    this.weaponTallies.set(weaponId, fresh);
    return fresh;
  }
}
