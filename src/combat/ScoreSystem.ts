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

export interface PlayerScore {
  readonly entityId: number;
  readonly displayName: string;
  readonly team: ScoreTeam;
  /** True for the human. The scoreboard highlights their row. */
  readonly isLocal: boolean;
  kills: number;
  deaths: number;
  /** Mode-defined points. TDM: 100 a kill, 50 more for a headshot. */
  score: number;
  /** Consecutive kills without dying. Reset on death; M7's killstreaks read this. */
  streak: number;
  bestStreak: number;
  shotsFired: number;
  shotsHit: number;
  damageDealt: number;
  headshots: number;
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

export class ScoreSystem {
  private readonly rowsById = new Map<number, PlayerScore>();
  /** Flat array as well as a map: the scoreboard sorts this every time it opens. */
  private readonly all: PlayerScore[] = [];
  private readonly totals: Record<ScoreTeam, TeamTotals> = { A: makeTotals(), B: makeTotals() };
  private readonly unsubscribe: Array<() => void> = [];

  constructor(bus: GameBus) {
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
      }),
    );
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
      score: 0,
      streak: 0,
      bestStreak: 0,
      shotsFired: 0,
      shotsHit: 0,
      damageDealt: 0,
      headshots: 0,
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
   */
  recordKill(killerId: number, victimId: number, headshot: boolean, points: number): void {
    const victim = this.rowsById.get(victimId);
    if (victim !== undefined) {
      victim.deaths++;
      victim.streak = 0;
      this.totals[victim.team].deaths++;
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

  addTeamScore(team: ScoreTeam, amount: number): void {
    this.totals[team].score += amount;
  }

  addRoundWin(team: ScoreTeam): void {
    this.totals[team].rounds++;
  }

  /** Swap both teams' totals. Used when a mode swaps sides between rounds. */
  swapTeams(): void {
    const a = this.totals.A;
    this.totals.A = this.totals.B;
    this.totals.B = a;
  }

  /** Zero the per-round figures but keep the match ones. */
  resetRound(): void {
    for (const row of this.all) row.streak = 0;
  }

  /** Zero everything. A fresh match on the same roster. */
  reset(): void {
    for (const row of this.all) {
      row.kills = 0;
      row.deaths = 0;
      row.score = 0;
      row.streak = 0;
      row.bestStreak = 0;
      row.shotsFired = 0;
      row.shotsHit = 0;
      row.damageDealt = 0;
      row.headshots = 0;
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
