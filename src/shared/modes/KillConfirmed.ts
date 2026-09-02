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
  type TagInfo,
} from './GameMode';

/**
 * Kill Confirmed (brief S6.2): kills drop dog tags, and only collected tags score.
 *
 * The mode is a comment on Team Deathmatch: killing somebody is necessary and not sufficient,
 * so the ground where a fight happened stays dangerous after it ends. Two collection rules,
 * and the second is the one that makes it a mode rather than a chore:
 *
 *  - Picking up an **enemy** tag confirms the kill and scores your team a point.
 *  - Picking up a **friendly** tag *denies* it — no point for anybody, and the enemy's kill
 *    is wasted. It is worth personal score, because a player who runs into the open to deny
 *    a tag has taken the same risk as one who confirms.
 *
 * Tags are plain records rather than world entities. They need a position, an owner team and
 * a lifetime, and nothing else — the mesh is `MatchObjectives`' problem and the pickup test is
 * a distance check that already has to run on the sim tick.
 *
 * ## Bots
 *
 * The brief is explicit: bots collect friendly tags to deny and enemy tags to score. Both are
 * offered through `ObjectiveProvider`, with enemy tags weighted higher — a confirm is worth a
 * point and a deny only removes one — and both scaled by distance so a bot goes for the tag at
 * its feet rather than the theoretically better one across the map.
 */

export interface KillConfirmedConfig {
  /** Tags that win the match. */
  readonly scoreLimit: number;
  readonly timeLimitSeconds: number;
  /** How long a tag survives on the floor before it evaporates. */
  readonly tagLifetimeSeconds: number;
  /** Pickup radius, metres. */
  readonly pickupRadius: number;
  /** Vertical tolerance for a pickup, metres. */
  readonly pickupHeight: number;
  readonly pointsPerKill: number;
  readonly pointsHeadshotBonus: number;
  readonly pointsPerConfirm: number;
  readonly pointsPerDeny: number;
}

export const KILL_CONFIRMED_CONFIG: KillConfirmedConfig = {
  scoreLimit: 65,
  timeLimitSeconds: 600,
  tagLifetimeSeconds: 20,
  pickupRadius: 1.9,
  pickupHeight: 2.2,
  pointsPerKill: 100,
  pointsHeadshotBonus: 50,
  pointsPerConfirm: 150,
  pointsPerDeny: 100,
};

export interface DogTag {
  readonly id: number;
  /** The side that *died*. Enemy tags confirm; your own deny. */
  readonly team: BotTeam;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Seconds left before it evaporates. */
  life: number;
  claimed: boolean;
}

export class KillConfirmed extends GameMode implements ObjectiveProvider {
  override readonly id: GameModeId = 'KC';
  override readonly name = 'KILL CONFIRMED';

  override readonly roundsToWin = 1;
  override readonly swapSidesAfterRound: number | null = null;
  override readonly livesPerRound = Infinity;
  override readonly roundSeconds: number;
  override readonly scoreLimit: number;

  /**
   * F10, and both halves are in it because the deny is the half nobody works out unaided.
   *
   * *"A kill is not a point"* is the whole mode, and a player briefed only on collecting enemy
   * tags will leave their own team-mates' on the floor for the other side to take.
   */
  override get brief(): string {
    return `KILLS DROP TAGS · TAKE ENEMY TAGS TO SCORE, YOUR OWN TO DENY · ${this.config.scoreLimit} TAGS`;
  }

  /** Live tags. Read by `MatchObjectives` for the meshes and by the HUD for the markers. */
  readonly tags: DogTag[] = [];

  private readonly config: KillConfirmedConfig;
  private ticksLeft = 0;
  private nextTagId = 1;
  private readonly scratch: MutableObjectiveTarget = makeObjectiveTarget();

  private readonly evDropped = { tagId: 0, team: 'A' as BotTeam, victimId: 0, x: 0, y: 0, z: 0 };
  private readonly evCollected = {
    tagId: 0, team: 'A' as BotTeam, entityId: 0, denied: false, x: 0, y: 0, z: 0,
  };

  constructor(deps: ModeDeps, config: KillConfirmedConfig = KILL_CONFIRMED_CONFIG) {
    super(deps);
    this.config = config;
    this.roundSeconds = config.timeLimitSeconds;
    this.scoreLimit = config.scoreLimit;
  }

  override onSpawn(_entity: Entity): void {
    /* Tags come from deaths, not spawns. */
  }

  /** A death drops a tag where the body fell. */
  override onKill(ev: KillEvent): void {
    const points = ev.headshot
      ? this.config.pointsPerKill + this.config.pointsHeadshotBonus
      : this.config.pointsPerKill;
    this.deps.score.recordKill(ev.killerId, ev.victimId, ev.headshot, points);

    if (ev.victimTeam === null) return;
    const victim = this.combatant(ev.victimId);
    if (victim === undefined) return;

    const tag: DogTag = {
      id: this.nextTagId++,
      team: ev.victimTeam,
      x: victim.px,
      // Off the floor so the marker and the mesh both sit at chest height on the body.
      y: victim.py + 0.5,
      z: victim.pz,
      life: this.config.tagLifetimeSeconds,
      claimed: false,
    };
    this.tags.push(tag);

    const e = this.evDropped;
    e.tagId = tag.id;
    e.team = tag.team;
    e.victimId = ev.victimId;
    e.x = tag.x;
    e.y = tag.y;
    e.z = tag.z;
    this.deps.bus.emit(EV.TagDropped, e);
  }

  override onTick(_tick: number): void {
    if (this.ticksLeft > 0) this.ticksLeft--;

    const cfg = this.config;
    const r2 = cfg.pickupRadius * cfg.pickupRadius;

    for (let i = this.tags.length - 1; i >= 0; i--) {
      const tag = this.tags[i];
      if (tag === undefined) continue;

      tag.life -= DT;
      if (tag.life <= 0) {
        this.tags.splice(i, 1);
        continue;
      }

      let taker: Combatant | undefined;
      for (const c of this.deps.roster) {
        if (!c.participating) continue;
        if (Math.abs(c.py - tag.y) > cfg.pickupHeight) continue;
        const dx = c.px - tag.x;
        const dz = c.pz - tag.z;
        if (dx * dx + dz * dz > r2) continue;
        taker = c;
        break;
      }
      if (taker === undefined) continue;

      this.collect(tag, taker);
      this.tags.splice(i, 1);
    }
  }

  override checkWinCondition(): MatchResult | RoundResult | null {
    const a = this.teamScore('A');
    const b = this.teamScore('B');
    if (a >= this.config.scoreLimit || b >= this.config.scoreLimit) {
      return this.result(leaderOf(a, b), 'Tag limit', a, b);
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
      { key: 'tags', label: 'Tags', width: 6, align: 'right', value: (r) => String(r.tags) },
      { key: 'kd', label: 'K/D', width: 5, align: 'right', value: (r) => killDeath(r).toFixed(2) },
      {
        key: 'acc', label: 'Acc', width: 6, align: 'right',
        value: (r) => { const p = accuracy(r); return p < 0 ? '—' : `${p.toFixed(0)}%`; },
      },
    ];
  }

  override onRoundStart(_round: number): void {
    this.ticksLeft = this.roundTicks(this.config.timeLimitSeconds);
    this.tags.length = 0;
  }

  override onRoundEnd(_result: RoundResult): void {
    this.tags.length = 0;
  }

  override teamScore(team: ScoreTeam): number {
    return this.deps.score.team(team).score;
  }

  // -- replication (M11 Gate B, §6.8) -----------------------------------------

  /** The seam `MatchInstance` reads. See `GameMode.dogTags`. */
  override get dogTags(): readonly TagInfo[] {
    return this.tags;
  }

  /**
   * Adopt the server's tag list wholesale (§6.8).
   *
   * Called on a networked client only, where `onKill` and `onTick` never run and this list
   * would otherwise stay empty for the whole match. The server's list *is* the list: a tag
   * absent from the frame has been collected or has expired, and either way it is gone.
   *
   * Existing records are mutated in place where the id still matches, so the array does not
   * churn on every snapshot — but the identity that matters to the renderer is `tag.id`, which
   * `MatchObjectives.updateTags` pools by, so a tag keeps its mesh across the update either
   * way.
   *
   * `life` is set to a nominal positive value rather than replicated. Nothing on the client
   * reads it — expiry is the server's to decide and arrives as an absence — but leaving it at
   * zero would make a tag look expired to any future reader, and lying about the number is
   * worse than not having it.
   */
  applyReplicatedTags(states: readonly TagInfo[]): void {
    for (let i = 0; i < states.length; i++) {
      const state = states[i];
      if (state === undefined) continue;
      const existing = this.tags[i];
      if (existing !== undefined && existing.id === state.id) {
        // Same tag in the same slot: nothing to do, a tag does not move once dropped.
        continue;
      }
      const replacement: DogTag = {
        id: state.id,
        team: state.team,
        x: state.x,
        y: state.y,
        z: state.z,
        life: this.config.tagLifetimeSeconds,
        claimed: false,
      };
      if (i < this.tags.length) this.tags[i] = replacement;
      else this.tags.push(replacement);
    }
    // Anything past the end of the server's list has been collected or has expired.
    if (this.tags.length > states.length) this.tags.length = states.length;
  }

  // -- ObjectiveProvider ------------------------------------------------------

  /**
   * Send the bot at the most worthwhile tag it can reach.
   *
   * Enemy tags outweigh friendly ones because a confirm scores and a deny only prevents. The
   * distance term dominates at range, so bots pick up what is in front of them instead of all
   * converging on the single best tag on the map.
   */
  assign(bot: Combatant): ObjectiveTarget | null {
    const enemy = opposingTeam(bot.team);
    let best: DogTag | null = null;
    let bestScore = -Infinity;

    for (const tag of this.tags) {
      if (tag.claimed) continue;
      const confirms = tag.team === enemy;
      const dist = Math.hypot(bot.px - tag.x, bot.pz - tag.z);
      // Far tags are not worth crossing a map for; a tag that is about to expire is worth less.
      if (dist > 34) continue;
      let s = (confirms ? 26 : 15) - dist;
      if (tag.life < 5) s -= 8;
      if (s <= bestScore) continue;
      bestScore = s;
      best = tag;
    }
    if (best === null) return null;

    const t = this.scratch;
    t.id = `tag_${best.id}`;
    t.label = best.team === enemy ? 'CONFIRM' : 'DENY';
    t.x = best.x;
    t.y = best.y;
    t.z = best.z;
    t.radius = this.config.pickupRadius;
    t.action = 'collect';
    // A tag close by is worth breaking off for; a distant one is a suggestion.
    t.priority = bestScore > 14 ? 0.85 : 0.45;
    return t;
  }

  onArrived(_bot: Combatant, _target: ObjectiveTarget): void {
    /**
     * Nothing to do: `onTick` already tests every combatant against every tag, so a bot that
     * has arrived has already picked it up. Doing it again here would collect it twice.
     */
  }

  // -- internals --------------------------------------------------------------

  private collect(tag: DogTag, taker: Combatant): void {
    const denied = tag.team === taker.team;
    const cfg = this.config;
    this.deps.score.recordObjective(
      taker.entityId,
      'tags',
      denied ? cfg.pointsPerDeny : cfg.pointsPerConfirm,
    );
    // Only a confirm moves the team total. A deny is worth doing because it stops the enemy
    // scoring, and paying for it twice would make denying better than confirming.
    if (!denied) this.deps.score.addTeamScore(taker.team, 1);

    const e = this.evCollected;
    e.tagId = tag.id;
    e.team = tag.team;
    e.entityId = taker.entityId;
    e.denied = denied;
    e.x = tag.x;
    e.y = tag.y;
    e.z = tag.z;
    this.deps.bus.emit(EV.TagCollected, e);
  }

  private combatant(entityId: number): Combatant | undefined {
    for (const c of this.deps.roster) if (c.entityId === entityId) return c;
    return undefined;
  }

  private result(winner: ScoreTeam | 'DRAW', reason: string, a: number, b: number): MatchResult {
    return {
      kind: 'match', winner, reason, scoreA: a, scoreB: b,
      roundsA: winner === 'A' ? 1 : 0, roundsB: winner === 'B' ? 1 : 0,
    };
  }
}
