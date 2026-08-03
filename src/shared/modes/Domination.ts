import type { Combatant } from '../ai/Combatant';
import { opposingTeam, type BotTeam } from '../ai/Combatant';
import {
  makeObjectiveTarget,
  type MutableObjectiveTarget,
  type ObjectiveProvider,
  type ObjectiveTarget,
} from '../ai/ObjectiveIntent';
import { accuracy, killDeath, type ScoreTeam } from '../combat/ScoreSystem';
import { EV } from '../core/Events';
import { DT } from '../core/Loop';
import {
  GameMode,
  leaderOf,
  type ColumnDef,
  type Entity,
  type GameModeId,
  type KillEvent,
  type MatchResult,
  type ModeDeps,
  type RoundResult,
} from './GameMode';
import { ObjectiveZone, recountZones } from './ObjectiveZone';

/**
 * Domination (brief S6.2): three flags, 200 points, one point per flag every five seconds.
 *
 * The scoring rule is the whole mode and it is worth being precise about: a team with two
 * flags scores twice as fast as a team with one, so the game is decided by *how long* you
 * hold ground rather than by how often you take it. That is why the tick is a single shared
 * five-second timer rather than one per flag — three independent timers would let a team that
 * kept losing and retaking B out-score a team that quietly sat on A and C.
 *
 * ## Bots
 *
 * `ObjectiveProvider` is implemented here, and the priorities are where "bots play the
 * objective" is actually decided:
 *
 *  - A flag nobody owns, or one the enemy owns, is worth taking — high priority, and higher
 *    still when the team is behind on flag count.
 *  - A flag the team already owns is worth *defending* at a much lower priority, which is
 *    what keeps some of the team at home rather than all of them rotating.
 *  - Assignments are sticky per bot: a bot that has been sent to C stays sent to C until it
 *    arrives or the flag changes hands. Re-rolling every 4 Hz decision produced bots that
 *    oscillated between two flags and reached neither, which looked exactly like the
 *    "deathmatch with decoration" the brief is warning about.
 *
 * The home-flag rule is the one the brief calls out ("do not all leave home"): at most
 * `MAX_ATTACKERS_PER_FLAG` bots are assigned to any one flag, and a team is never allowed to
 * assign its last defender away from a flag it owns.
 */

export interface DominationConfig {
  /** Points that win the match. */
  readonly scoreLimit: number;
  readonly timeLimitSeconds: number;
  /** Seconds between scoring ticks. One point per flag held, per tick. */
  readonly tickSeconds: number;
  readonly pointsPerKill: number;
  readonly pointsHeadshotBonus: number;
  /** Personal score for taking a flag. */
  readonly pointsPerCapture: number;
  /** Personal score for a kill inside your own flag's radius. */
  readonly pointsPerDefend: number;
  /** Radius within which a kill counts as a defend, metres. */
  readonly defendRadius: number;
  /** Most bots sent at one flag at a time. */
  readonly maxAttackersPerFlag: number;
}

export const DOMINATION_CONFIG: DominationConfig = {
  scoreLimit: 200,
  timeLimitSeconds: 600,
  tickSeconds: 5,
  pointsPerKill: 100,
  pointsHeadshotBonus: 50,
  pointsPerCapture: 250,
  pointsPerDefend: 150,
  defendRadius: 9,
  maxAttackersPerFlag: 3,
};

export class Domination extends GameMode implements ObjectiveProvider {
  override readonly id: GameModeId = 'DOM';
  override readonly name = 'DOMINATION';

  override readonly roundsToWin = 1;
  override readonly swapSidesAfterRound: number | null = null;
  override readonly livesPerRound = Infinity;
  override readonly roundSeconds: number;
  override readonly scoreLimit: number;

  readonly zones: ObjectiveZone[] = [];

  private readonly config: DominationConfig;
  private ticksLeft = 0;
  private scoreTimer = 0;
  /** Sticky assignment: entity id -> flag id. */
  private readonly assignment = new Map<number, string>();
  private readonly scratch: MutableObjectiveTarget = makeObjectiveTarget();

  private readonly evCaptured = {
    objectiveId: '', label: '', team: 'A' as BotTeam, entityId: 0, x: 0, y: 0, z: 0,
  };
  private readonly evProgress = {
    objectiveId: '', label: '', fraction: 0, team: 'NONE' as BotTeam | 'NONE', contested: false,
  };

  constructor(deps: ModeDeps, config: DominationConfig = DOMINATION_CONFIG) {
    super(deps);
    this.config = config;
    this.roundSeconds = config.timeLimitSeconds;
    this.scoreLimit = config.scoreLimit;
    for (const def of deps.mapDef.objectives) {
      if (def.kind === 'flag') this.zones.push(new ObjectiveZone(def));
    }
    if (this.zones.length === 0) {
      throw new Error(`Domination needs flag objectives; "${deps.mapDef.id}" authors none.`);
    }
  }

  /** Flags held by a team. Read by the HUD and by the bot priorities. */
  flagsHeld(team: ScoreTeam): number {
    let n = 0;
    for (const z of this.zones) if (z.owner === team) n++;
    return n;
  }

  override onSpawn(_entity: Entity): void {
    /* Domination attaches nothing to a spawn; flags are owned by standing on them. */
  }

  override onKill(ev: KillEvent): void {
    const points = ev.headshot
      ? this.config.pointsPerKill + this.config.pointsHeadshotBonus
      : this.config.pointsPerKill;
    this.deps.score.recordKill(ev.killerId, ev.victimId, ev.headshot, points);
    // A dead bot's assignment is stale the moment it drops.
    this.assignment.delete(ev.victimId);

    if (ev.suicide || ev.friendly || ev.killerTeam === null) return;
    // A defend is a kill made close to a flag your side owns. Resolved against the *victim's*
    // position, because what is being defended is the ground the enemy was trying to reach.
    const victim = this.combatant(ev.victimId);
    if (victim === undefined) return;
    for (const zone of this.zones) {
      if (zone.owner !== ev.killerTeam) continue;
      const p = zone.def.position;
      const dx = victim.px - p.x;
      const dz = victim.pz - p.z;
      if (dx * dx + dz * dz > this.config.defendRadius * this.config.defendRadius) continue;
      this.deps.score.recordObjective(ev.killerId, 'defends', this.config.pointsPerDefend);
      return;
    }
  }

  override onTick(_tick: number): void {
    if (this.ticksLeft > 0) this.ticksLeft--;

    recountZones(this.zones, this.deps.roster);
    for (const zone of this.zones) {
      const before = zone.owner;
      const taken = zone.step();
      this.publishProgress(zone);
      if (taken === null || taken === before) continue;
      this.creditCapture(zone, taken);
    }

    // One shared timer: a team scores its flag count every `tickSeconds`.
    this.scoreTimer += DT;
    if (this.scoreTimer < this.config.tickSeconds) return;
    this.scoreTimer -= this.config.tickSeconds;
    for (const team of ['A', 'B'] as const) {
      const held = this.flagsHeld(team);
      if (held > 0) this.deps.score.addTeamScore(team, held);
    }
  }

  override checkWinCondition(): MatchResult | RoundResult | null {
    const a = this.teamScore('A');
    const b = this.teamScore('B');
    if (a >= this.config.scoreLimit || b >= this.config.scoreLimit) {
      return this.result(leaderOf(a, b), 'Score limit', a, b);
    }
    if (this.ticksLeft <= 0) {
      const winner = leaderOf(a, b);
      return this.result(winner, winner === 'DRAW' ? 'Time — draw' : 'Time limit', a, b);
    }
    return null;
  }

  override getScoreboardColumns(): ColumnDef[] {
    return [
      { key: 'score', label: 'Score', width: 6, align: 'right', value: (r) => String(r.score) },
      { key: 'kills', label: 'K', width: 4, align: 'right', value: (r) => String(r.kills) },
      { key: 'deaths', label: 'D', width: 4, align: 'right', value: (r) => String(r.deaths) },
      // S6.4: Domination shows captures and defends.
      { key: 'cap', label: 'Cap', width: 5, align: 'right', value: (r) => String(r.captures) },
      { key: 'def', label: 'Def', width: 5, align: 'right', value: (r) => String(r.defends) },
      { key: 'kd', label: 'K/D', width: 5, align: 'right', value: (r) => killDeath(r).toFixed(2) },
      {
        key: 'acc', label: 'Acc', width: 6, align: 'right',
        value: (r) => { const p = accuracy(r); return p < 0 ? '—' : `${p.toFixed(0)}%`; },
      },
    ];
  }

  override onRoundStart(_round: number): void {
    this.ticksLeft = Math.round(this.config.timeLimitSeconds / DT);
    this.scoreTimer = 0;
    this.assignment.clear();
    // Each side starts holding the flag nearest its own spawn; the middle starts neutral.
    // Anything else makes the opening thirty seconds a race to three uncontested flags.
    const ordered = [...this.zones].sort((l, r) => l.def.position.x - r.def.position.x);
    for (let i = 0; i < ordered.length; i++) {
      const zone = ordered[i];
      if (zone === undefined) continue;
      if (i === 0) zone.reset('A');
      else if (i === ordered.length - 1) zone.reset('B');
      else zone.reset('NONE');
    }
  }

  override onRoundEnd(_result: RoundResult): void {
    /* One round; the match ends with it. */
  }

  override teamScore(team: ScoreTeam): number {
    return this.deps.score.team(team).score;
  }

  // -- ObjectiveProvider ------------------------------------------------------

  assign(bot: Combatant): ObjectiveTarget | null {
    const held = this.assignment.get(bot.entityId);
    if (held !== undefined) {
      const zone = this.zoneById(held);
      // Keep the assignment until the flag actually changes hands under it.
      if (zone !== undefined && zone.owner !== bot.team) return this.target(zone, bot, 'capture');
      this.assignment.delete(bot.entityId);
    }

    const enemy = opposingTeam(bot.team);
    const owned = this.flagsHeld(bot.team);
    let best: ObjectiveZone | null = null;
    let bestScore = -Infinity;

    for (const zone of this.zones) {
      if (zone.owner === bot.team) continue;
      const crowd = this.assignedCount(zone.id);
      if (crowd >= this.config.maxAttackersPerFlag) continue;
      const p = zone.def.position;
      const dist = Math.hypot(bot.px - p.x, bot.pz - p.z);
      // Nearest first, neutral before enemy-held, and everything more urgent while behind.
      let s = -dist;
      if (zone.owner === 'NONE') s += 12;
      if (zone.owner === enemy && owned === 0) s += 20;
      if (zone.contested) s += 8;
      s -= crowd * 6;
      if (s <= bestScore) continue;
      bestScore = s;
      best = zone;
    }

    if (best !== null) {
      this.assignment.set(bot.entityId, best.id);
      return this.target(best, bot, 'capture');
    }

    // Everything is ours. Sit on the one nearest this bot and hold it — a low priority, so
    // the bot still fights anything it meets on the way rather than jogging past it.
    let nearest: ObjectiveZone | null = null;
    let nearestDist = Infinity;
    for (const zone of this.zones) {
      if (zone.owner !== bot.team) continue;
      const p = zone.def.position;
      const d = Math.hypot(bot.px - p.x, bot.pz - p.z);
      if (d >= nearestDist) continue;
      nearestDist = d;
      nearest = zone;
    }
    return nearest === null ? null : this.target(nearest, bot, 'defend');
  }

  onArrived(_bot: Combatant, _target: ObjectiveTarget): void {
    /**
     * Nothing to do: a Domination flag is taken by *standing* on it, and `onTick` already
     * counts everybody inside every zone. Arriving is the whole interaction.
     */
  }

  // -- internals --------------------------------------------------------------

  private target(zone: ObjectiveZone, bot: Combatant, action: 'capture' | 'defend'): ObjectiveTarget {
    const t = this.scratch;
    t.id = zone.id;
    t.label = zone.label;
    t.x = zone.def.position.x;
    t.y = zone.def.position.y;
    t.z = zone.def.position.z;
    // Inside the ring rather than on its edge, so a bot that stops short still counts.
    t.radius = Math.max(1.2, zone.def.radius * 0.7);
    t.action = action;
    // Defending is deliberately below `OBJECTIVE_IGNORE_BELOW` so a bot holding a flag will
    // break off to shoot, while a bot sent to take one will not.
    t.priority = action === 'capture' ? (zone.contested ? 0.95 : 0.8) : 0.35;
    void bot;
    return t;
  }

  private assignedCount(zoneId: string): number {
    let n = 0;
    for (const id of this.assignment.values()) if (id === zoneId) n++;
    return n;
  }

  private zoneById(id: string): ObjectiveZone | undefined {
    for (const z of this.zones) if (z.id === id) return z;
    return undefined;
  }

  private combatant(entityId: number): Combatant | undefined {
    for (const c of this.deps.roster) if (c.entityId === entityId) return c;
    return undefined;
  }

  /**
   * Credit the capture to whoever is standing in the zone.
   *
   * Everybody inside gets the stat and the points, which is what CoD does and what makes
   * three bots taking a flag together worth doing. The event carries the first of them so
   * the killfeed has somebody to name.
   */
  private creditCapture(zone: ObjectiveZone, team: BotTeam): void {
    let first = -1;
    for (const c of this.deps.roster) {
      if (c.team !== team || !zone.contains(c)) continue;
      if (first < 0) first = c.entityId;
      this.deps.score.recordObjective(c.entityId, 'captures', this.config.pointsPerCapture);
    }
    const ev = this.evCaptured;
    ev.objectiveId = zone.id;
    ev.label = zone.label;
    ev.team = team;
    ev.entityId = first;
    ev.x = zone.def.position.x;
    ev.y = zone.def.position.y;
    ev.z = zone.def.position.z;
    this.deps.bus.emit(EV.ObjectiveCaptured, ev);
  }

  private publishProgress(zone: ObjectiveZone): void {
    const ev = this.evProgress;
    ev.objectiveId = zone.id;
    ev.label = zone.label;
    ev.fraction = zone.progress;
    ev.team = zone.capturingTeam;
    ev.contested = zone.contested;
    this.deps.bus.emit(EV.ObjectiveProgress, ev);
  }

  private result(winner: ScoreTeam | 'DRAW', reason: string, a: number, b: number): MatchResult {
    return {
      kind: 'match', winner, reason, scoreA: a, scoreB: b,
      roundsA: winner === 'A' ? 1 : 0, roundsB: winner === 'B' ? 1 : 0,
    };
  }
}
