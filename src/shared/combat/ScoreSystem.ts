import { EV, type GameBus } from '../core/Events';
import { isHostile } from './Hostility';
import { LocalIdentity } from './LocalIdentity';
import { hitsFrom, shotsFrom } from './ShotAccounting';
import { Disposable } from '../core/Disposable';

/**
 * Who is winning, and what everybody in the match has done (brief S6.5).
 *
 * The scoreboard, the score banner, the killfeed and the end-of-match summary are four
 * views of this one object. Nothing else counts anything: M3 had bots keeping their own
 * `kills` / `shotsFired` tallies for the acceptance measurements, and a second set of
 * counters for a *scoreboard* would be a second set of numbers that can disagree with the
 * first. So this subscribes to the same events the rest of the game does and is the single
 * answer to "what is the score".
 *
 * It also means the player gets an accuracy column for free, which the M3 counters never
 * gave them: `weapon.fired` and `damage.dealt` carry a `sourceId` and this does not care
 * whose it is.
 */

export type ScoreTeam = 'A' | 'B';

/**
 * The objective actions a mode can credit (M7).
 *
 * One closed union rather than a free-form string, because `getScoreboardColumns` reads
 * these back by name and a typo would produce a column of zeroes rather than an error.
 * Every mode uses a subset: Domination captures and defends, Kill Confirmed tags, Search &
 * Destroy plants and defuses.
 */
export type ObjectiveStat = 'captures' | 'defends' | 'plants' | 'defuses' | 'tags';

export interface PlayerScore {
  /**
   * Which body this row is about. Written by `ScoreSystem.adopt` alone (M13 Phase B): a player
   * who returns after the reconnect grace is seated as a new entity, and their old row follows
   * them rather than standing on the board beside a fresh one.
   */
  entityId: number;
  readonly displayName: string;
  /** Mutable for the same one reason: an adopted row moves to the side its owner was re-seated on. */
  team: ScoreTeam;
  /**
   * True for the human at this keyboard. The scoreboard highlights their row.
   *
   * Written by `ScoreSystem` alone — it is re-stamped when a server assigns this client its
   * entity id, which on a dedicated server happens after the row may already exist.
   */
  isLocal: boolean;
  kills: number;
  deaths: number;
  /**
   * Damage contributed to somebody else's kill (M6).
   *
   * S6.1's XP table pays 50 an assist and nothing in M1-M5 knew what one was. It lives
   * here rather than in `meta/` for the same reason kills do: there is one answer to
   * "what has this player done", and a second tally kept next door is a second answer.
   */
  assists: number;
  /** Mode-defined points. TDM: 100 a kill, 50 more for a headshot. */
  score: number;
  /** Consecutive kills without dying. Reset on death; M7's killstreaks read this. */
  streak: number;
  bestStreak: number;
  shotsFired: number;
  shotsHit: number;
  damageDealt: number;
  headshots: number;

  // ---- M7: objective play -------------------------------------------------
  /** Flags taken (Domination) — the moment ownership actually changes. */
  captures: number;
  /** Kills made defending a flag this player's team owns. */
  defends: number;
  plants: number;
  defuses: number;
  /** Dog tags picked up, of either colour (Kill Confirmed). */
  tags: number;
}

export interface TeamTotals {
  score: number;
  kills: number;
  deaths: number;
  /** Rounds won. TDM only ever has one. */
  rounds: number;
}

function makeTotals(): TeamTotals {
  return { score: 0, kills: 0, deaths: 0, rounds: 0 };
}

/**
 * Recent damage, for assist attribution.
 *
 * A fixed ring rather than a map of maps: a firefight produces a few hundred damage
 * events a minute and an assist only looks back `ASSIST_WINDOW_TICKS`, so anything older
 * than the ring is older than the window by a wide margin. Allocation free after
 * construction, which matters because this is written from inside the sim.
 */
const DAMAGE_LEDGER_SIZE = 128;

/**
 * Eight seconds of grace on an assist, at 60 Hz: damage this recently before a death counts
 * toward it. Long enough that softening somebody up and losing the trade still credits you,
 * short enough that a hit landed at the start of the lane does not.
 */
const ASSIST_WINDOW_TICKS = 480;

interface DamageRecord {
  sourceId: number;
  targetId: number;
  tick: number;
}

export class ScoreSystem extends Disposable {
  /**
   * Whether this match has teams at all (M11 Gate B playtest).
   *
   * Free-for-All keeps the two-team substrate — see `modes/FreeForAll.ts` — so half of every
   * lobby shares a `ScoreTeam` with everybody else, and `recordKill`'s "a teammate's death is
   * not a kill" rule silently threw those away. `FreeForAll.onKill`'s own comment says *"every
   * kill counts, including one on somebody who happens to share your substrate side"*, and it
   * was the only half of that sentence the code did not implement: roughly three kills in seven
   * were credited to nobody, so the ladder crawled and the 30-kill limit was effectively
   * unreachable inside the clock.
   *
   * Set beside `DamageSystem.freeForAll`, from the same registry flag, in both runtimes —
   * the two facts are the same fact ("there are no teammates here") and setting one without
   * the other is what produced a mode where you could shoot someone but not score them.
   */
  freeForAll = false;

  /**
   * Whether this match records anything at all (playtest round 4, F7).
   *
   * False in the permanent warmup arena, and nowhere else. §6.3 said the room has *"no score
   * and no win condition"*, and that was built as two zeroed limits in `FFA_WARMUP_CONFIG` —
   * *nothing to count toward*, which is not the same claim as *nothing is counted*. The room
   * went on registering a row per player, tallying shots, hits and damage into it, and putting
   * the result on Tab and on the Free-for-All banner as a live ladder. That ladder is the
   * *"rating and results"* F7 asks to be taken out of the waiting room.
   *
   * Enforced at `register` rather than in each handler, because every counter above and below
   * already begins by looking a row up and giving up when there is not one. One absence at the
   * top therefore switches the whole class off, and there is no second place to forget.
   */
  records = true;

  /**
   * Moves on every change to the row set or to any row (M13 Phase B).
   *
   * The dedicated server sends the board to a client whenever this differs from what that
   * client was last sent, so it is the one fact the replication decides on. Compared, never
   * interpreted; a `u32` on the wire so an old frame arriving after a newer one under jitter
   * cannot move a client's board backwards.
   */
  serial = 1;

  /**
   * Whether this instance counts for itself (M13 Phase B).
   *
   * True everywhere it has ever been — single-player and the dedicated server — and false on
   * a **networked client**, whose rows are the server's, delivered whole by `applyReplicated`.
   * A replica that also subscribed to the bus would add each replicated shot and hit on top
   * of the copy the next frame overwrites, and the board would flicker between two answers.
   * The subscriptions are simply not made; `recordKill` and friends are only ever reached from
   * a mode, and a replicated client runs no mode.
   */
  readonly authoritative: boolean;

  private readonly rowsById = new Map<number, PlayerScore>();
  /** Flat array as well as a map: the scoreboard sorts this every time it opens. */
  private readonly all: PlayerScore[] = [];
  private readonly totals: Record<ScoreTeam, TeamTotals> = { A: makeTotals(), B: makeTotals() };

  private readonly ledger: DamageRecord[] = [];
  private ledgerHead = 0;
  /** Set from `MatchFlow.simulate`, so the assist window is measured in sim ticks (S4.1). */
  private tick = 0;
  /** Scratch for `recordKill`; reused so the assist scan allocates nothing. */
  private readonly assistScratch: number[] = [];

  private readonly identity: LocalIdentity;

  /**
   * `identity` is optional so every M1-M8 call site keeps working: absent, it is the
   * single-player seat and `isLocal` means exactly what it has always meant.
   */
  constructor(bus: GameBus, identity: LocalIdentity = new LocalIdentity(), authoritative = true) {
    super();
    this.identity = identity;
    this.authoritative = authoritative;
    for (let i = 0; i < DAMAGE_LEDGER_SIZE; i++) {
      this.ledger.push({ sourceId: -1, targetId: -1, tick: -1 });
    }

    /**
     * `isLocal` is stamped onto a row at registration, so a row registered before the server's
     * `Welcome` arrived would be wrong forever. Re-stamp the whole table when the assignment
     * changes — it happens at most once per session and the table is a dozen rows.
     */
    this.own(
      this.identity.onChange(() => {
        for (const row of this.all) row.isLocal = this.identity.is(row.entityId);
      }),
    );

    // A replica counts nothing for itself. See `authoritative`.
    if (!authoritative) return;

    /**
     * Both halves of the accuracy column come off this one event (round 5, B5).
     *
     * They used to come off two — pulls from here, hits from `damage.dealt` — which is why the
     * board could read 267%. See `ShotAccounting` for the definition and for what is
     * deliberately excluded from it.
     */
    this.own(
      bus.on(EV.WeaponFired, (p) => {
        const row = this.rowsById.get(p.sourceId);
        if (row === undefined) return;
        row.shotsFired += shotsFrom(p);
        row.shotsHit += hitsFrom(p);
        this.serial++;
      }),
    );
    this.own(
      bus.on(EV.DamageDealt, (p) => {
        const row = this.rowsById.get(p.sourceId);
        if (row === undefined) return;
        // Damage only. A grenade, a knife and a killstreak's belt all arrive here under the
        // owner's id and none of them sent a round, so none of them touch the shot counters.
        row.damageDealt += p.amount;
        this.serial++;
        const slot = this.ledger[this.ledgerHead];
        if (slot !== undefined) {
          slot.sourceId = p.sourceId;
          slot.targetId = p.targetId;
          slot.tick = this.tick;
          this.ledgerHead = (this.ledgerHead + 1) % DAMAGE_LEDGER_SIZE;
        }
      }),
    );
  }

  /** The current sim tick. Called once per tick by `MatchFlow`. */
  setTick(tick: number): void {
    this.tick = tick;
  }

  /**
   * Add a combatant. Called once per roster entry when a match is composed.
   *
   * `undefined` when this match keeps no record — see `records`. The absence is in the return
   * type rather than hidden behind a row nobody can find, because a caller that starts wanting
   * the row should have to say what it does in a match that has none.
   */
  register(entityId: number, displayName: string, team: ScoreTeam): PlayerScore | undefined {
    if (!this.records) return undefined;
    const existing = this.rowsById.get(entityId);
    if (existing !== undefined) return existing;
    const row: PlayerScore = {
      entityId,
      displayName,
      team,
      isLocal: this.identity.is(entityId),
      kills: 0,
      deaths: 0,
      assists: 0,
      score: 0,
      streak: 0,
      bestStreak: 0,
      shotsFired: 0,
      shotsHit: 0,
      damageDealt: 0,
      headshots: 0,
      captures: 0,
      defends: 0,
      plants: 0,
      defuses: 0,
      tags: 0,
    };
    this.rowsById.set(entityId, row);
    this.all.push(row);
    this.serial++;
    return row;
  }

  /**
   * Take a row off the board (M13 Phase B, bug 4.3).
   *
   * Rows were never removed, which is why a bot replaced by a human before the first shot
   * stayed on every summary at `0/0/0`, and why a Free-for-All player could come eleventh in
   * an eight-body match. The one caller is the server taking a bot off the roster to seat a
   * human; a **leaver's** row is deliberately not removed — `ServerMatch.removePlayer` keeps it
   * for the match, so the kills they earned stay on the board and a return can adopt them.
   */
  remove(entityId: number): void {
    const row = this.rowsById.get(entityId);
    if (row === undefined) return;
    this.rowsById.delete(entityId);
    const at = this.all.indexOf(row);
    if (at >= 0) this.all.splice(at, 1);
    this.serial++;
  }

  /**
   * Re-key a leaver's row onto the entity they came back as (M13 Phase B, bug 4.3).
   *
   * Inside the reconnect grace a returning player reclaims their old entity id and the row
   * needs nothing. Past it they are seated fresh — a new id, possibly the other side — and
   * without this the board carried two rows with one name: the old one with the kills,
   * attributed to nobody, and a new one at zero. The kills follow the person.
   *
   * The row keeps its counters and its name; the id and the side become the new seat's.
   * Team totals are left alone — they were credited when the kills happened, and TDM is
   * decided on them, so moving a leaver's kills to the other side's total would rewrite a
   * match still being played.
   */
  adopt(fromEntityId: number, toEntityId: number, team: ScoreTeam): PlayerScore | undefined {
    const row = this.rowsById.get(fromEntityId);
    if (row === undefined || fromEntityId === toEntityId) return row;
    // The fresh seat has already registered a row on the new id — `addPlayer` does — and it is
    // blank by construction. A row on that id that is *not* blank is somebody else's record,
    // and that one is kept.
    const standing = this.rowsById.get(toEntityId);
    if (standing !== undefined) {
      const blank = standing.kills === 0 && standing.deaths === 0 && standing.score === 0 &&
        standing.shotsFired === 0 && standing.damageDealt === 0;
      if (!blank) return standing;
      this.remove(toEntityId);
    }
    this.rowsById.delete(fromEntityId);
    row.entityId = toEntityId;
    row.team = team;
    row.isLocal = this.identity.is(toEntityId);
    this.rowsById.set(toEntityId, row);
    this.serial++;
    return row;
  }

  /**
   * Make this board the server's (M13 Phase B, bug 4.3).
   *
   * The replicated set *is* the authority: a row it carries is upserted, a row it does not is
   * removed. Rows are updated in place rather than replaced, so a `Scoreboard` that caches the
   * row object it bound a slot to keeps its cache, and only the cells whose text changed are
   * rewritten. `records` is honoured — the arena replicates an empty set and keeps none.
   */
  applyReplicated(rows: readonly ReplicatedScoreRow[]): void {
    if (!this.records) return;
    let changed = false;
    for (const r of rows) {
      let row = this.rowsById.get(r.entityId);
      if (row === undefined) {
        row = this.register(r.entityId, r.displayName, r.team);
        if (row === undefined) continue;
        changed = true;
      }
      if (row.team !== r.team) {
        row.team = r.team;
        changed = true;
      }
      if (
        row.kills !== r.kills || row.deaths !== r.deaths || row.assists !== r.assists ||
        row.score !== r.score || row.streak !== r.streak || row.bestStreak !== r.bestStreak ||
        row.shotsFired !== r.shotsFired || row.shotsHit !== r.shotsHit ||
        row.damageDealt !== r.damageDealt || row.headshots !== r.headshots ||
        row.captures !== r.captures || row.defends !== r.defends || row.plants !== r.plants ||
        row.defuses !== r.defuses || row.tags !== r.tags
      ) {
        row.kills = r.kills;
        row.deaths = r.deaths;
        row.assists = r.assists;
        row.score = r.score;
        row.streak = r.streak;
        row.bestStreak = r.bestStreak;
        row.shotsFired = r.shotsFired;
        row.shotsHit = r.shotsHit;
        row.damageDealt = r.damageDealt;
        row.headshots = r.headshots;
        row.captures = r.captures;
        row.defends = r.defends;
        row.plants = r.plants;
        row.defuses = r.defuses;
        row.tags = r.tags;
        changed = true;
      }
    }
    // Anything the server no longer lists is gone: a bot that gave its seat to a human.
    for (let i = this.all.length - 1; i >= 0; i--) {
      const row = this.all[i];
      if (row === undefined) continue;
      if (rows.some((r) => r.entityId === row.entityId)) continue;
      this.rowsById.delete(row.entityId);
      this.all.splice(i, 1);
      changed = true;
    }
    if (changed) this.serial++;
  }

  get rows(): readonly PlayerScore[] {
    return this.all;
  }

  row(entityId: number): PlayerScore | undefined {
    return this.rowsById.get(entityId);
  }

  team(team: ScoreTeam): TeamTotals {
    return this.totals[team];
  }

  /**
   * Record a kill. `points` is the mode's, because what a kill is worth is a mode decision
   * and this class has no opinion about it.
   *
   * Assists are credited here rather than by the mode: everyone who damaged the victim
   * inside the window and did not land the killing blow gets one, which is a fact about
   * the damage ledger and not a scoring policy.
   */
  recordKill(killerId: number, victimId: number, headshot: boolean, points: number): void {
    const victim = this.rowsById.get(victimId);
    if (victim !== undefined) {
      victim.deaths++;
      victim.streak = 0;
      this.totals[victim.team].deaths++;
      this.creditAssists(victimId, killerId, victim.team);
    }

    this.serial++;
    const killer = this.rowsById.get(killerId);
    if (killer === undefined || killerId === victimId) return;
    // A teammate's death is not a kill. Friendly fire is off in M4 so this cannot happen
    // through ballistics, but the score has to be right for whatever comes next.
    //
    // Unless there are no teammates: in FFA the side is substrate rather than allegiance.
    if (victim !== undefined && !isHostile(killer.team, victim.team, this.freeForAll)) return;
    killer.kills++;
    killer.score += points;
    killer.streak++;
    if (killer.streak > killer.bestStreak) killer.bestStreak = killer.streak;
    if (headshot) killer.headshots++;
    this.totals[killer.team].kills++;
  }

  /**
   * One assist each to everyone who softened the victim up, excluding the killer and the
   * victim's own team. Deduplicated through a reused scratch array so a burst of six
   * rounds is one assist rather than six.
   */
  private creditAssists(victimId: number, killerId: number, victimTeam: ScoreTeam): void {
    const scratch = this.assistScratch;
    scratch.length = 0;
    const oldest = this.tick - ASSIST_WINDOW_TICKS;
    for (const record of this.ledger) {
      if (record.targetId !== victimId) continue;
      if (record.tick < oldest) continue;
      if (record.sourceId === killerId || record.sourceId === victimId) continue;
      if (scratch.includes(record.sourceId)) continue;
      scratch.push(record.sourceId);
    }
    for (const id of scratch) {
      const row = this.rowsById.get(id);
      if (row === undefined) continue;
      // Same rule as the kill itself: in FFA the victim's "side" is not a side.
      if (!isHostile(row.team, victimTeam, this.freeForAll)) continue;
      row.assists++;
    }
  }

  /**
   * Credit an objective action, and the personal points that go with it (M7).
   *
   * The counterpart to `recordKill`, and deliberately the same shape: the mode decides what
   * the action is *worth* — S6.4 prices a capture differently from a tag — and this class
   * only records that it happened. Team score is not touched here, because a capture adds to
   * the team total in Domination and a tag does not in Kill Confirmed; that is the mode's
   * decision and it makes it through `addTeamScore`.
   */
  recordObjective(entityId: number, stat: ObjectiveStat, points: number): void {
    const row = this.rowsById.get(entityId);
    if (row === undefined) return;
    row[stat]++;
    row.score += points;
    this.serial++;
  }

  addTeamScore(team: ScoreTeam, amount: number): void {
    this.totals[team].score += amount;
  }

  addRoundWin(team: ScoreTeam): void {
    this.totals[team].rounds++;
  }

  /**
   * There is deliberately no `swapTeams` (round 2). See `MatchFlow.swapSides`.
   *
   * There was one, and it is the Search & Destroy scoring bug: a side swap moved every team
   * total to the other team, so the round Team B won before half-time was credited to Team A
   * after it. `'A'` and `'B'` name *teams of players*, not ends of a map — a player's
   * `PlayerScore.team` does not change at half-time either — so the score has to stay with
   * the people who earned it. Swapping ends changes which spawn zones a team draws from, and
   * that is the whole of what it changes.
   */

  /** Zero the per-round figures but keep the match ones. */
  resetRound(): void {
    for (const row of this.all) row.streak = 0;
    this.serial++;
  }

  /** Zero everything. A fresh match on the same roster. */
  reset(): void {
    for (const row of this.all) {
      row.kills = 0;
      row.deaths = 0;
      row.assists = 0;
      row.score = 0;
      row.streak = 0;
      row.bestStreak = 0;
      row.shotsFired = 0;
      row.shotsHit = 0;
      row.damageDealt = 0;
      row.headshots = 0;
      row.captures = 0;
      row.defends = 0;
      row.plants = 0;
      row.defuses = 0;
      row.tags = 0;
    }
    this.totals.A = makeTotals();
    this.totals.B = makeTotals();
    this.serial++;
  }

  clear(): void {
    this.rowsById.clear();
    this.all.length = 0;
    this.totals.A = makeTotals();
    this.totals.B = makeTotals();
    this.serial++;
  }

  override dispose(): void {
    super.dispose();
    this.clear();
  }
}

/**
 * One row as the wire carries it (M13 Phase B). Every column the modes' `getScoreboardColumns`
 * can read — see `PlayerScore` for what each means — and nothing a client decides for itself.
 */
export interface ReplicatedScoreRow {
  readonly entityId: number;
  readonly displayName: string;
  readonly team: ScoreTeam;
  readonly kills: number;
  readonly deaths: number;
  readonly assists: number;
  readonly score: number;
  readonly streak: number;
  readonly bestStreak: number;
  readonly shotsFired: number;
  readonly shotsHit: number;
  readonly damageDealt: number;
  readonly headshots: number;
  readonly captures: number;
  readonly defends: number;
  readonly plants: number;
  readonly defuses: number;
  readonly tags: number;
}

/**
 * Accuracy as a percentage, or -1 when nothing has been fired.
 *
 * Both operands are rays now — see `ShotAccounting` — so this cannot exceed 100. It could,
 * and did: the numerator was a count of damage events.
 */
export function accuracy(row: PlayerScore): number {
  if (row.shotsFired === 0) return -1;
  return (row.shotsHit / row.shotsFired) * 100;
}

/** Kill/death ratio. Deaths of zero reads as the kill count, which is what CoD shows. */
export function killDeath(row: PlayerScore): number {
  return row.deaths === 0 ? row.kills : row.kills / row.deaths;
}

/** What a ladder ranks by. Structural, so the wire's summary rows rank the same way. */
export interface Rankable {
  readonly score: number;
  readonly kills: number;
  readonly deaths: number;
}

/**
 * The board's order: score, then kills, then fewest deaths (M13 Phase A, lifted from
 * `Scoreboard.refresh`).
 *
 * The CoD ordering, and stable enough that a row does not jump while the player is reading
 * it. One copy, because the Free-for-All summary now turns the same order into a *place* —
 * "2ND", "3RD" — and a place computed by a second comparator would be a place the board can
 * contradict.
 */
export function compareRows(a: Rankable, b: Rankable): number {
  return b.score - a.score || b.kills - a.kills || a.deaths - b.deaths;
}
