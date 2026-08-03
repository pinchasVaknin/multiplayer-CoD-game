import { EV, type GameBus } from '../core/Events';
import { PLAYER_ENTITY_ID } from './DamageSystem';

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
  readonly entityId: number;
  readonly displayName: string;
  readonly team: ScoreTeam;
  /** True for the human. The scoreboard highlights their row. */
  readonly isLocal: boolean;
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

/** 8 seconds at 60 Hz. Mirrors `meta/XpRules.ASSIST_WINDOW_SECONDS`. */
const ASSIST_WINDOW_TICKS = 480;

interface DamageRecord {
  sourceId: number;
  targetId: number;
  tick: number;
}

export class ScoreSystem {
  private readonly rowsById = new Map<number, PlayerScore>();
  /** Flat array as well as a map: the scoreboard sorts this every time it opens. */
  private readonly all: PlayerScore[] = [];
  private readonly totals: Record<ScoreTeam, TeamTotals> = { A: makeTotals(), B: makeTotals() };
  private readonly unsubscribe: Array<() => void> = [];

  private readonly ledger: DamageRecord[] = [];
  private ledgerHead = 0;
  /** Set from `MatchFlow.simulate`, so the assist window is measured in sim ticks (S4.1). */
  private tick = 0;
  /** Scratch for `recordKill`; reused so the assist scan allocates nothing. */
  private readonly assistScratch: number[] = [];

  constructor(bus: GameBus) {
    for (let i = 0; i < DAMAGE_LEDGER_SIZE; i++) {
      this.ledger.push({ sourceId: -1, targetId: -1, tick: -1 });
    }

    this.unsubscribe.push(
      bus.on(EV.WeaponFired, (p) => {
        const row = this.rowsById.get(p.sourceId);
        if (row !== undefined) row.shotsFired++;
      }),
    );
    this.unsubscribe.push(
      bus.on(EV.DamageDealt, (p) => {
        const row = this.rowsById.get(p.sourceId);
        if (row === undefined) return;
        row.shotsHit++;
        row.damageDealt += p.amount;
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

  /** Add a combatant. Called once per roster entry when a match is composed. */
  register(entityId: number, displayName: string, team: ScoreTeam): PlayerScore {
    const existing = this.rowsById.get(entityId);
    if (existing !== undefined) return existing;
    const row: PlayerScore = {
      entityId,
      displayName,
      team,
      isLocal: entityId === PLAYER_ENTITY_ID,
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
    return row;
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

    const killer = this.rowsById.get(killerId);
    if (killer === undefined || killerId === victimId) return;
    // A teammate's death is not a kill. Friendly fire is off in M4 so this cannot happen
    // through ballistics, but the score has to be right for whatever comes next.
    if (victim !== undefined && victim.team === killer.team) return;
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
      if (row === undefined || row.team === victimTeam) continue;
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
  }

  clear(): void {
    this.rowsById.clear();
    this.all.length = 0;
    this.totals.A = makeTotals();
    this.totals.B = makeTotals();
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.clear();
  }
}

/** Accuracy as a percentage, or -1 when nothing has been fired. */
export function accuracy(row: PlayerScore): number {
  if (row.shotsFired === 0) return -1;
  return (row.shotsHit / row.shotsFired) * 100;
}

/** Kill/death ratio. Deaths of zero reads as the kill count, which is what CoD shows. */
export function killDeath(row: PlayerScore): number {
  return row.deaths === 0 ? row.kills : row.kills / row.deaths;
}
