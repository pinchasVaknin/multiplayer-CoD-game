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
  type BombInfo,
  type MutableBombInfo,
  type ColumnDef,
  type Entity,
  type GameModeId,
  type KillEvent,
  type MatchResult,
  type ModeDeps,
  type RoundResult,
} from './GameMode';
import { ObjectiveZone } from './ObjectiveZone';

/**
 * Search & Destroy (brief S6.2): one life, plant or defuse, best of nine, sides swap at five.
 *
 * This is the mode the M4 round abstraction was built for, and the payoff is that almost
 * nothing here is about rounds. `roundsToWin = 5`, `swapSidesAfterRound = 5` and
 * `livesPerRound = 1` are three constants; `MatchFlow` already owns the round machine, the
 * side swap and the respawn gate, and it runs them unchanged. What is left in this file is
 * only what S&D actually adds: a bomb, two sites, and a win condition with four ways to end.
 *
 * ## The four endings
 *
 * A round ends when: the bomb explodes (attackers), the bomb is defused (defenders), one side
 * is eliminated, or time runs out. The order matters — a defuse that completes on the same
 * tick the timer expires is a defuse, and elimination is only checked once nobody can still
 * come back, which with one life is immediately.
 *
 * **Elimination is not "everyone is dead right now".** A body is dead for a second and a half
 * before the director recycles it, and with `livesPerRound = 1` the respawn gate refuses
 * anyway — so the test is "has this side any living members", evaluated after the kill has
 * been recorded. Planting changes it: once the bomb is down, killing every attacker does *not*
 * win the round, because the bomb is still counting. That is the rule that makes the post-plant
 * a different game from the pre-plant, and it is one line below.
 *
 * ## Bots
 *
 * The brief asks for three behaviours and they are the three priorities here: attackers carry
 * the bomb to a site and plant, defenders sit on the sites, and after a plant both sides
 * converge — attackers to defend the plant, defenders to defuse. With one life the FSM's push
 * aggression drops sharply, which is `cautionScale`: it is handed to `MatchWorld` and folded
 * into the tier table for the match, so a bot in S&D is the same bot playing more carefully
 * rather than a second AI.
 */

export interface SearchDestroyConfig {
  /** Rounds a side must win. Best of nine. */
  readonly roundsToWin: number;
  readonly swapAfterRound: number;
  readonly roundSeconds: number;
  /** Seconds the bomb burns before it detonates. */
  readonly bombTimerSeconds: number;
  /** Seconds of uninterrupted contact to plant. */
  readonly plantSeconds: number;
  /** Seconds to defuse. Longer than the plant: defusing is the harder job. */
  readonly defuseSeconds: number;
  /** How close you must be to interact, metres. */
  readonly interactRadius: number;
  /** How close an attacker must be to pick the bomb up, metres. */
  readonly pickupRadius: number;
  /**
   * Seconds at the start of a round during which only an entity that asks may take the bomb.
   *
   * The post-M8 playtest turned auto-pickup off *for the human* — "the player must press the
   * key" — and left bots taking it by walking over it, which is the only interaction verb a bot
   * has. Those two rules met at the one place they collide: the bomb spawns **inside the
   * attackers' central spawn zone** (Foundry authors it at `z = -21.17`, and the spawn there
   * has radius 3), so on the first tick of every round an attacking bot is already standing on
   * it and takes it before a human has seen the round start. Over a whole match the player
   * never once held the bomb, and with nothing drawn on the carrier there was no bomb visible
   * anywhere either — reported, reasonably, as *"there is no bomb"*.
   *
   * A short grace rather than a rule about who deserves it: for these few seconds the bomb is
   * only picked up by pressing the key, which every human can do and no bot will. After it,
   * the mode behaves exactly as it did — if nobody claimed it, the nearest bot takes it and the
   * round goes ahead.
   */
  readonly pickupGraceSeconds: number;
  readonly pointsPerKill: number;
  readonly pointsHeadshotBonus: number;
  readonly pointsPerPlant: number;
  readonly pointsPerDefuse: number;
  /**
   * Multiplier applied to every tier's `pushAggression` for the duration of an S&D match.
   * One life makes trading a losing move, so bots hold angles instead of running at people.
   */
  readonly cautionScale: number;
}

export const SND_CONFIG: SearchDestroyConfig = {
  // Best of three: first side to two rounds takes the match (M7 playtest). Sides change
  // after round one, so in a two-round match each side attacks once.
  roundsToWin: 2,
  swapAfterRound: 1,
  roundSeconds: 150,
  bombTimerSeconds: 45,
  plantSeconds: 5,
  defuseSeconds: 7.5,
  interactRadius: 2.6,
  pickupRadius: 1.8,
  // Long enough to react to "the round has started" and press the key; short enough that a
  // lobby of bots is not standing around a bomb nobody is going to pick up.
  pickupGraceSeconds: 4,
  pointsPerKill: 100,
  pointsHeadshotBonus: 50,
  pointsPerPlant: 250,
  pointsPerDefuse: 250,
  cautionScale: 0.35,
};

/**
 * Search & Destroy as it appears on the skirmish ballot (M11, §6.4).
 *
 * §6.4 asks for *"a shortened best-of-5, not best-of-9"*, with §8.20 requiring *"the side swap
 * at round 3"*. Best of five is `roundsToWin: 3`, and a swap after round two makes round three
 * the first one played from the other side — so both halves of the series are three rounds
 * long at most and each side attacks first exactly once.
 *
 * ## The brief's premise is out of date, and this is longer rather than shorter
 *
 * There has been no best-of-nine S&D since M7's playtest, which cut `SND_CONFIG` to a best of
 * three. So this variant *lengthens* the mode by one round per side rather than shortening it.
 * It is built to the brief because the brief and §8.20 both name best-of-five explicitly and
 * the round count is a tuning number rather than a structural one — but the reasoning quoted
 * for it ("a twenty-minute match is wrong in a drop-in flow") already applied to a match that
 * did not exist. At 150 s a round, a five-round series is up to 12.5 minutes of round time.
 *
 * Everything except the series shape is `SND_CONFIG` verbatim: the bomb timer, the plant and
 * defuse windows and the scoring are gunplay feel, and HARD RULE 8 keeps them unchanged.
 */
export const SND_SKIRMISH_CONFIG: SearchDestroyConfig = {
  ...SND_CONFIG,
  roundsToWin: 3,
  swapAfterRound: 2,
};

export type BombState = 'CARRIED' | 'PLANTED' | 'DEFUSED' | 'EXPLODED';

export class SearchAndDestroy extends GameMode implements ObjectiveProvider {
  override readonly id: GameModeId = 'SND';
  override readonly name = 'SEARCH & DESTROY';

  override readonly roundsToWin: number;
  override readonly swapSidesAfterRound: number | null;
  override readonly livesPerRound = 1;
  override readonly roundSeconds: number;
  /** No running score bar: the thing being counted is rounds. */
  override readonly scoreLimit = 0;
  /**
   * A decided S&D round is held for a beat and no longer (post-M8 playtest).
   *
   * The round ends on the *tick* the bomb goes off or comes apart — `checkWinCondition`
   * returns the outcome that `explode` and `stepDefuse` set, and `MatchFlow` consults it on
   * the same tick — so there has never been a delay in the *decision*. What there was is this
   * hold, and at the shared four seconds it read as one: you defuse, nothing happens, and
   * then the round ends. A second and a half is enough to register the result and short
   * enough that the bang and the round ending feel like one event.
   */
  override readonly roundEndSeconds = 1.5;

  readonly sites: ObjectiveZone[] = [];
  readonly config: SearchDestroyConfig;

  /**
   * F10, and this is the report's own example: *"where to take the bomb"*.
   *
   * The sites are named from the map's own objectives, so the letters in the brief are the
   * letters on the `SITE A` banner the objective HUD puts up when the carrier stands in one.
   *
   * **Both sides in one sentence, deliberately.** The brief is a property of the mode and the
   * mode does not know which seat is reading it — and more usefully, the two halves of Search &
   * Destroy are only legible together: a defender who is not told the attackers are carrying a
   * bomb to one of two named places does not know what they are defending. Which side *you* are
   * on is already said continuously by the objective banner and the alive strip; this says what
   * the round is.
   */
  override get brief(): string {
    const where = this.sites.map((s) => s.label).join(' OR ');
    return `ONE LIFE · ATTACKERS PLANT THE BOMB AT ${where} · DEFENDERS DEFUSE IT`;
  }

  /** Which side is attacking this round. Flips with the side swap. */
  attackers: BotTeam = 'B';
  bomb: BombState = 'CARRIED';
  /** The site the bomb is on, once planted. */
  plantedSite: ObjectiveZone | null = null;

  /**
   * Who is carrying the bomb, or -1 while it is on the ground (M7 playtest).
   *
   * The bomb is a *thing* now rather than an ability every attacker has. It starts on the
   * ground at the attacking side's spawn, an attacker has to walk over it, and it drops where
   * they fall if they are killed — so the round has an object in it that both sides care
   * about, which is the whole point of the mode.
   */
  carrierId = -1;
  /**
   * Which entities must ask before they pick the bomb up (post-M8 playtest).
   *
   * Bots keep walking onto the bomb and collecting it, because a bot has no key to press and
   * `onArrived` is the only interaction verb it has; a human presses Use, like every other
   * interaction in the mode.
   *
   * A *predicate* rather than the single id this used to be (M11 Gate B). One id is exactly
   * right for single-player, where there is one human by definition, and silently wrong on a
   * dedicated server where there are several: every human past the first would have collected
   * the bomb by walking over it, in a mode whose own playtest ruled that out. It matches the
   * shape of the codebase's other hooks of this kind — `silentFootsteps`, `targetable`,
   * `visibleToUav` — all of which answer a question about an entity id without the mode ever
   * learning what a human is.
   */
  manualPickup: (entityId: number) => boolean = () => false;
  /** Where the bomb is lying, when nobody is carrying it. */
  bombX = 0;
  bombY = 0;
  bombZ = 0;
  bombTimer = 0;
  /** 0..1 progress on the interaction currently running, for the HUD ring. */
  interactFraction = 0;
  /** Who is doing it, so an interrupted plant does not resume under somebody else. */
  interactEntity = -1;
  private interactIsDefuse = false;

  private ticksLeft = 0;
  /** Ticks left of the opening window in which only a key press takes the bomb. */
  private graceTicks = 0;
  private roundOutcome: RoundResult | null = null;
  private roundIndex = 1;
  private readonly scratch: MutableObjectiveTarget = makeObjectiveTarget();

  /** The one object `bombInfo` returns. Mutated in place; never replaced. See S4.7. */
  private readonly bombScratch: MutableBombInfo = {
    state: 'CARRIED',
    carrierId: -1,
    attackers: 'B',
    x: 0,
    y: 0,
    z: 0,
    secondsLeft: 0,
    interactFraction: 0,
    interactEntity: -1,
    plantedSiteIndex: -1,
  };

  private readonly evPlanted = { siteId: '', label: '', entityId: 0, x: 0, y: 0, z: 0 };
  private readonly evDefused = { siteId: '', label: '', entityId: 0 };
  private readonly evExploded = { siteId: '', label: '', x: 0, y: 0, z: 0 };

  constructor(deps: ModeDeps, config: SearchDestroyConfig = SND_CONFIG) {
    super(deps);
    this.config = config;
    this.roundsToWin = config.roundsToWin;
    this.swapSidesAfterRound = config.swapAfterRound;
    this.roundSeconds = config.roundSeconds;
    for (const def of deps.mapDef.objectives) {
      if (def.kind === 'bombsite') this.sites.push(new ObjectiveZone(def));
    }
    if (this.sites.length === 0) {
      throw new Error(`Search & Destroy needs bombsite objectives; "${deps.mapDef.id}" authors none.`);
    }
  }

  get defenders(): BotTeam {
    return opposingTeam(this.attackers);
  }

  get bombSecondsLeft(): number {
    return this.bombTimer;
  }

  override onSpawn(_entity: Entity): void {
    /* One life; the spawn itself carries no state. */
  }

  override onKill(ev: KillEvent): void {
    const points = ev.headshot
      ? this.config.pointsPerKill + this.config.pointsHeadshotBonus
      : this.config.pointsPerKill;
    this.deps.score.recordKill(ev.killerId, ev.victimId, ev.headshot, points);
    // Whoever was planting or defusing has stopped.
    if (ev.victimId === this.interactEntity) this.cancelInteract();

    // The carrier went down: the bomb is on the floor where they fell, for anybody to take.
    if (ev.victimId === this.carrierId) {
      const victim = this.combatant(ev.victimId);
      if (victim !== undefined) {
        this.bombX = victim.px;
        this.bombY = victim.py;
        this.bombZ = victim.pz;
      }
      this.carrierId = -1;
    }
  }

  override onTick(_tick: number): void {
    if (this.ticksLeft > 0) this.ticksLeft--;
    if (this.graceTicks > 0) this.graceTicks--;
    if (this.roundOutcome !== null) return;

    // The bomb is an object in the world whether it is on the floor or in somebody's hands.
    // Kept before every other bomb step so a plant that starts this tick reads a position
    // that is this tick's.
    this.followCarrier();

    if (this.bomb === 'CARRIED') this.stepPickup();

    if (this.bomb === 'PLANTED') {
      this.bombTimer -= DT;
      this.stepDefuse();
      if (this.bomb === 'PLANTED' && this.bombTimer <= 0) this.explode();
      return;
    }
    if (this.bomb === 'CARRIED') this.stepPlant();
  }

  /**
   * Four ways a round ends, in priority order.
   *
   * Elimination is checked *after* the bomb states because a planted bomb outlives its
   * planters: wiping the attacking team post-plant does not win the round, which is the
   * whole shape of an S&D post-plant.
   */
  /**
   * This mode's objectives, for replication (M11 Gate B, §6.8).
   *
   * The same array the renderer walks, so the client's zone N and the server's zone N are the
   * same authored objective.
   */
  override get objectiveZones(): readonly ObjectiveZone[] {
    return this.sites;
  }

  /**
   * The bomb, for replication (M11 Gate B, §6.8).
   *
   * One object, owned here and mutated in place, because this is read on the snapshot cadence
   * from inside the tick and S4.7 permits no allocation there. See `GameMode.bombInfo`.
   *
   * `plantedSiteIndex` is resolved against `this.sites` rather than sent as a site id: the two
   * runtimes build that array from `MapDef.objectives` in the same order, so an index is
   * identity and costs one byte where a string costs its length.
   */
  override get bombInfo(): BombInfo | null {
    const info = this.bombScratch;
    info.state = this.bomb;
    info.carrierId = this.carrierId;
    info.attackers = this.attackers;
    info.x = this.bombX;
    info.y = this.bombY;
    info.z = this.bombZ;
    info.secondsLeft = this.bombTimer;
    info.interactFraction = this.interactFraction;
    info.interactEntity = this.interactEntity;
    info.plantedSiteIndex =
      this.plantedSite === null ? -1 : this.sites.indexOf(this.plantedSite);
    return info;
  }

  /**
   * Adopt the server's bomb (§6.8).
   *
   * Called on a networked client only. Everything here is otherwise **frozen** rather than
   * merely stale: `stepPickup`, `stepPlant`, `stepDefuse` and the fuse countdown all run from
   * `onTick`, which `MatchFlow` drives and a networked client does not simulate. Without this
   * the bomb timer holds its constructed value for the entire round and the HUD counts down
   * from a number that never changes.
   *
   * `attackers` is adopted too, and it is the one that would be silently wrong for half a
   * match: the side swap happens on the server at round 3 (§6.4), and a client that kept its
   * initial assignment would draw every objective marker on the wrong side of the map from
   * there on.
   */
  applyReplicatedBomb(info: BombInfo): void {
    this.bomb = info.state;
    this.carrierId = info.carrierId;
    this.attackers = info.attackers;
    this.bombX = info.x;
    this.bombY = info.y;
    this.bombZ = info.z;
    this.bombTimer = info.secondsLeft;
    this.interactFraction = info.interactFraction;
    this.interactEntity = info.interactEntity;
    this.plantedSite =
      info.plantedSiteIndex < 0 ? null : (this.sites[info.plantedSiteIndex] ?? null);
  }

  override checkWinCondition(): MatchResult | RoundResult | null {
    const decided = this.roundOutcome;
    if (decided !== null) {
      this.roundOutcome = null;
      return decided;
    }

    if (this.bomb !== 'PLANTED') {
      if (!this.anyAlive(this.attackers)) {
        return this.round(this.defenders, 'Attackers eliminated');
      }
      if (!this.anyAlive(this.defenders)) {
        return this.round(this.attackers, 'Defenders eliminated');
      }
      if (this.ticksLeft <= 0) return this.round(this.defenders, 'Time — bomb not planted');
      return null;
    }

    // Post-plant: only a defuse or the clock decides it, plus defenders being wiped.
    if (!this.anyAlive(this.defenders)) return this.round(this.attackers, 'Defenders eliminated');
    return null;
  }

  override getScoreboardColumns(): ColumnDef[] {
    return [
      { key: 'score', label: 'Score', width: 6, align: 'right', value: (r) => String(r.score) },
      { key: 'kills', label: 'K', width: 4, align: 'right', value: (r) => String(r.kills) },
      { key: 'deaths', label: 'D', width: 4, align: 'right', value: (r) => String(r.deaths) },
      // S6.4: S&D shows plants and defuses.
      { key: 'plants', label: 'Plt', width: 5, align: 'right', value: (r) => String(r.plants) },
      { key: 'defuses', label: 'Dfz', width: 5, align: 'right', value: (r) => String(r.defuses) },
      { key: 'kd', label: 'K/D', width: 5, align: 'right', value: (r) => killDeath(r).toFixed(2) },
      {
        key: 'acc', label: 'Acc', width: 6, align: 'right',
        value: (r) => { const p = accuracy(r); return p < 0 ? '—' : `${p.toFixed(0)}%`; },
      },
    ];
  }

  override onRoundStart(round: number): void {
    this.roundIndex = round;
    this.ticksLeft = this.roundTicks(this.config.roundSeconds);
    this.bomb = 'CARRIED';
    this.plantedSite = null;
    this.bombTimer = 0;
    this.roundOutcome = null;
    this.graceTicks = Math.round(this.config.pickupGraceSeconds / DT);
    this.cancelInteract();
    for (const site of this.sites) site.reset('NONE');
    /**
     * Sides are swapped by `MatchFlow` after `swapAfterRound`; the attacking role rides along
     * with it, so whoever is on the attacking end of the map is attacking.
     *
     * The invariant this expresses, written out because two files and three maps depend on
     * it (round 2): **the attacking end never changes.** `MatchFlow.advanceRound` swaps when
     * `swapSidesAfterRound === roundIndex - 1` and `SpawnSelector` implements a swap by
     * having each team draw from the other team's zones, so before the swap Team B attacks
     * out of the `'B'` zones and after it Team A attacks out of the `'B'` zones. Both
     * conditions are driven from the same constant, so they cannot drift apart.
     *
     * That is why the bomb sites are authored in one place on each map and never move, and
     * why `resetBomb` can read a single authored point rather than tracking the swap.
     */
    this.attackers = round > this.config.swapAfterRound ? 'A' : 'B';
    this.resetBomb();
  }

  override onRoundEnd(_result: RoundResult): void {
    this.cancelInteract();
  }

  /** Rounds won, which is what the S&D banner counts. */
  override teamScore(team: ScoreTeam): number {
    return this.deps.score.team(team).rounds;
  }

  // -- ObjectiveProvider ------------------------------------------------------

  assign(bot: Combatant): ObjectiveTarget | null {
    const attacking = bot.team === this.attackers;

    if (this.bomb === 'PLANTED') {
      const site = this.plantedSite;
      if (site === null) return null;
      if (attacking) {
        // Deliberately *below* `OBJECTIVE_IGNORE_BELOW`: the attackers who just planted should
        // hold angles around the site and fight normally, not stand on the bomb. Pinning them
        // to it made them a lethal blob that no defuse ever survived — five rounds out of five.
        return this.targetOf(site, 'defend', 0.45);
      }
      // Exactly one defuser at a time, and it is the closest living defender. Every defender
      // walking onto a held bomb one at a time is five separate one-versus-four fights, which
      // is how the first balanced run went 0-5 the other way. The rest are told to converge at
      // a priority low enough that they clear the site first.
      return this.targetOf(site, 'defuse', bot.entityId === this.nearestDefuserId(site) ? 0.95 : 0.4);
    }

    if (attacking) {
      // Somebody has to fetch the bomb before anybody can plant it. The nearest attacker goes
      // for it; the rest push the site they will need once it is in hand.
      if (this.carrierId < 0) {
        if (bot.entityId === this.nearestToBombId()) return this.bombTarget();
        const site = this.nearestSite(bot);
        return site === null ? null : this.targetOf(site, 'plant', 0.6);
      }
      if (bot.entityId !== this.carrierId) {
        // Escort: head for the site the carrier is heading for, but do not break off a fight.
        const site = this.nearestSite(bot);
        return site === null ? null : this.targetOf(site, 'defend', 0.45);
      }
      const site = this.nearestSite(bot);
      return site === null ? null : this.targetOf(site, 'plant', 0.9);
    }

    // Defending, pre-plant: split across the sites so one is never left open. The bot's own
    // id picks which, so the split is stable rather than re-rolled every decision.
    //
    // Priority is deliberately *below* `OBJECTIVE_IGNORE_BELOW`. At 0.55 the defenders stood
    // on the site centres and won four rounds out of five without the bomb ever going down —
    // holding the exact square metre the attackers have to walk onto is an unbeatable angle,
    // and it is not how the site is actually defended. Below the threshold they drift toward
    // their site when nothing is happening and otherwise fight and take cover normally.
    const site = this.sites[bot.entityId % this.sites.length];
    return site === undefined ? null : this.targetOf(site, 'defend', 0.45);
  }

  /**
   * A bot standing on its objective. This is where a bot's plant and defuse actually start —
   * the timers themselves are the same ones the player drives, in `stepPlant`/`stepDefuse`.
   */
  onArrived(bot: Combatant, target: ObjectiveTarget): void {
    if (!bot.participating) return;
    if (target.action === 'plant' && this.bomb === 'CARRIED' && bot.team === this.attackers) {
      this.beginInteract(bot, false);
      return;
    }
    if (target.action === 'defuse' && this.bomb === 'PLANTED' && bot.team === this.defenders) {
      this.beginInteract(bot, true);
    }
  }

  /**
   * Put the bomb back on the ground at the attackers' base — the point the *map* names.
   *
   * ## Why this is authored and no longer derived (round 2)
   *
   * It used to average the attacking side's spawn zones, and the report was "the bomb is
   * spawning far away". Two separate faults, and the second one is the interesting one.
   *
   * The mean was taken over *every* zone the side owns, including the deep fallbacks each map
   * places past the centre line for a team that has been pushed off its own end. Those drag
   * the average toward mid-map, so even in the best case the bomb sat some way in front of
   * the spawn line rather than on it.
   *
   * The real fault is that it filtered on `zone.team !== this.attackers`, and after the
   * half-time swap that is the wrong set of zones. `SpawnSelector` implements a side swap by
   * having each team draw from the *other* team's zones, so from round two Team A attacks
   * while spawning out of the zones labelled `'B'`. The bomb went to the zones labelled
   * `'A'` — the defenders' base, the other end of the map. Not far away: as far away as it
   * is possible to be.
   *
   * The mode could be taught the swap, and then it would have two facts about the same thing
   * to keep in step with `SpawnSelector`. A map already knows where its attackers muster, so
   * it says so, and there is one fact. `MatchFlow`'s swap schedule and `swapAfterRound` are
   * in step by construction, which means the attacking end never changes — it is always the
   * `-Z` end — so a single authored point is correct for every round of every match.
   *
   * The old average survives as a fallback for a map that authors no `bombspawn`, so a map
   * added later fails soft rather than dropping the bomb at the origin.
   */
  private resetBomb(): void {
    this.carrierId = -1;
    this.bombY = 0;

    for (const def of this.deps.mapDef.objectives) {
      if (def.kind !== 'bombspawn') continue;
      this.bombX = def.position.x;
      this.bombY = def.position.y;
      this.bombZ = def.position.z;
      return;
    }

    let sx = 0;
    let sz = 0;
    let n = 0;
    for (const zone of this.deps.mapDef.spawns) {
      if (zone.team !== this.attackers) continue;
      sx += zone.position.x;
      sz += zone.position.z;
      n++;
    }
    this.bombX = n > 0 ? sx / n : 0;
    this.bombZ = n > 0 ? sz / n : 0;
  }

  /**
   * An attacker standing on the loose bomb picks it up — unless it is the one entity that
   * has to ask (post-M8 playtest).
   *
   * The report was "disable auto-pickup; the player must press the key". Bots are exempt
   * from that, and not as a concession: a bot's entire interaction vocabulary is *arriving
   * somewhere* (`onArrived`), and giving it a synthetic key press would be inventing an
   * input path for the one participant that does not have one.
   */
  private stepPickup(): void {
    if (this.carrierId >= 0) return;
    // The opening seconds belong to whoever presses the key. See `pickupGraceSeconds`.
    if (this.graceTicks > 0) return;
    for (const c of this.deps.roster) {
      if (this.manualPickup(c.entityId)) continue;
      if (this.tryPickup(c)) return;
    }
  }

  /**
   * Keep the bomb's position on whoever is carrying it (M11 Gate B playtest).
   *
   * `bombX/Y/Z` used to be written in exactly two places — the round reset and the carrier's
   * death — so while the bomb was *held* it reported the point where it was last dropped. That
   * is a stale answer everywhere it is read: `MatchObjectives` hid the mesh rather than draw it
   * at a lie, `objectiveTarget` sent bots to a place the bomb had left, and `BombInfo.x/y/z`
   * replicated the same lie to every client. With the mesh hidden and the position wrong, a
   * carried bomb was not an object in the world at all — it was a boolean on an entity.
   *
   * Cheap: one roster scan per tick, only while somebody is carrying, and it makes the single
   * replicated position true in all three states rather than in two of them.
   */
  private followCarrier(): void {
    if (this.bomb !== 'CARRIED' || this.carrierId < 0) return;
    const carrier = this.combatant(this.carrierId);
    if (carrier === undefined) {
      // The carrier stopped existing without dying — a disconnect, or a bot removed to make
      // room for a human. The bomb stays where it was rather than following a ghost.
      this.carrierId = -1;
      return;
    }
    this.bombX = carrier.px;
    this.bombY = carrier.py;
    this.bombZ = carrier.pz;
  }

  /**
   * Take the bomb, if this combatant is an attacker standing on it. Returns whether they did.
   *
   * Public because the player's route in is a held key rather than proximity: `Match` calls
   * it from the Use branch. The eligibility test lives here, once, so the manual and the
   * automatic paths cannot develop different ideas of what "standing on the bomb" means.
   */
  tryPickup(c: Combatant): boolean {
    if (!this.canPickup(c)) return false;
    this.carrierId = c.entityId;
    return true;
  }

  /**
   * Would `tryPickup` succeed? For the HUD prompt, which has to know without doing it.
   *
   * Deliberately the same predicate rather than a re-derivation: a prompt that appears where
   * the interaction does not work — or fails to appear where it does — is worse than none,
   * and that is exactly what two copies of a proximity test drift into.
   */
  tryPickupPrompt(c: Combatant): boolean {
    return this.canPickup(c);
  }

  private canPickup(c: Combatant): boolean {
    if (this.bomb !== 'CARRIED' || this.carrierId >= 0) return false;
    if (c.team !== this.attackers || !c.participating) return false;
    const r2 = this.config.pickupRadius * this.config.pickupRadius;
    const dx = c.px - this.bombX;
    const dz = c.pz - this.bombZ;
    if (dx * dx + dz * dz > r2) return false;
    return Math.abs(c.py - this.bombY) <= 2.5;
  }

  /**
   * Who is planting or defusing right now, or -1 (post-M8).
   *
   * Read by the HUD so the "hold to defuse" prompt is suppressed for everybody except the
   * person actually doing it, and by `MatchObjectives` so the bomb shows somebody working on
   * it. Both were previously reconstructing it from `interactEntity` plus a fraction test,
   * which is the same question asked two ways.
   */
  get interactingEntity(): number {
    return this.interactFraction > 0 ? this.interactEntity : -1;
  }

  /** True while the interaction under way is a defuse rather than a plant. */
  get interactIsDefusing(): boolean {
    return this.interactIsDefuse;
  }

  /** True when this combatant is the one holding the bomb. Read by the HUD and the bots. */
  isCarrier(entityId: number): boolean {
    return this.carrierId === entityId;
  }

  /** How many of a side are still standing. The alive-count HUD reads this (M7 playtest). */
  aliveCount(team: BotTeam): number {
    let n = 0;
    for (const c of this.deps.roster) if (c.team === team && c.participating) n++;
    return n;
  }

  // -- interactions -----------------------------------------------------------

  /**
   * Advance a plant. Interruptible: the moment the planter leaves the site, dies or is no
   * longer the entity that started it, progress is thrown away rather than banked.
   */
  private stepPlant(): void {
    const actor = this.interactEntity >= 0 && !this.interactIsDefuse
      ? this.combatant(this.interactEntity)
      : undefined;
    // Only the carrier plants. Anyone else standing on the site is just standing on the site.
    if (
      actor === undefined ||
      !actor.participating ||
      actor.team !== this.attackers ||
      actor.entityId !== this.carrierId
    ) {
      this.cancelInteract();
      return;
    }
    const site = this.siteContaining(actor);
    if (site === null) {
      this.cancelInteract();
      return;
    }
    this.interactFraction += DT / this.config.plantSeconds;
    if (this.interactFraction < 1) return;

    this.bomb = 'PLANTED';
    this.plantedSite = site;
    this.carrierId = -1;
    this.bombTimer = this.config.bombTimerSeconds;
    this.deps.score.recordObjective(actor.entityId, 'plants', this.config.pointsPerPlant);

    const e = this.evPlanted;
    e.siteId = site.id;
    e.label = site.label;
    e.entityId = actor.entityId;
    e.x = site.def.position.x;
    e.y = site.def.position.y;
    e.z = site.def.position.z;
    this.deps.bus.emit(EV.BombPlanted, e);
    this.cancelInteract();
  }

  private stepDefuse(): void {
    const actor = this.interactEntity >= 0 && this.interactIsDefuse
      ? this.combatant(this.interactEntity)
      : undefined;
    const site = this.plantedSite;
    if (site === null) return;
    if (actor === undefined || !actor.participating || actor.team !== this.defenders || !site.contains(actor)) {
      this.cancelInteract();
      return;
    }
    this.interactFraction += DT / this.config.defuseSeconds;
    if (this.interactFraction < 1) return;

    this.bomb = 'DEFUSED';
    this.deps.score.recordObjective(actor.entityId, 'defuses', this.config.pointsPerDefuse);
    const e = this.evDefused;
    e.siteId = site.id;
    e.label = site.label;
    e.entityId = actor.entityId;
    this.deps.bus.emit(EV.BombDefused, e);
    this.cancelInteract();
    this.roundOutcome = this.round(this.defenders, 'Bomb defused');
  }

  /**
   * Start (or continue) an interaction.
   *
   * Called every tactical decision while a bot stands on its target, and by `Match` for the
   * player's hold. If somebody else is already on it, the newcomer is ignored rather than
   * stealing it — two attackers cannot plant twice as fast.
   */
  beginInteract(actor: Combatant, defuse: boolean): void {
    if (this.interactEntity === actor.entityId && this.interactIsDefuse === defuse) return;
    if (this.interactEntity >= 0) {
      const current = this.combatant(this.interactEntity);
      if (current !== undefined && current.participating) return;
    }
    this.interactEntity = actor.entityId;
    this.interactIsDefuse = defuse;
    this.interactFraction = 0;
  }

  cancelInteract(): void {
    this.interactEntity = -1;
    this.interactFraction = 0;
    this.interactIsDefuse = false;
  }

  /** The site a combatant is standing in, or null. Public: the HUD prompts from it. */
  siteContaining(c: Combatant): ObjectiveZone | null {
    for (const site of this.sites) {
      const p = site.def.position;
      const dx = c.px - p.x;
      const dz = c.pz - p.z;
      const r = Math.max(site.def.radius, this.config.interactRadius);
      if (dx * dx + dz * dz <= r * r && Math.abs(c.py - p.y) < 3) return site;
    }
    return null;
  }

  // -- internals --------------------------------------------------------------

  private explode(): void {
    const site = this.plantedSite;
    this.bomb = 'EXPLODED';
    if (site !== null) {
      const e = this.evExploded;
      e.siteId = site.id;
      e.label = site.label;
      e.x = site.def.position.x;
      e.y = site.def.position.y;
      e.z = site.def.position.z;
      this.deps.bus.emit(EV.BombExploded, e);
    }
    this.roundOutcome = this.round(this.attackers, 'Bomb detonated');
  }

  private anyAlive(team: BotTeam): boolean {
    for (const c of this.deps.roster) {
      if (c.team === team && c.participating) return true;
    }
    return false;
  }

  /**
   * The living defender closest to the planted bomb — the one that actually goes for it.
   *
   * Recomputed per call rather than latched, so the job passes to somebody else the moment the
   * current defuser dies, which is the behaviour that makes a post-plant feel like a siege
   * rather than a queue.
   */
  /** The living attacker closest to the loose bomb — the one who goes and gets it. */
  private nearestToBombId(): number {
    let bestId = -1;
    let bestD = Infinity;
    for (const c of this.deps.roster) {
      if (c.team !== this.attackers || !c.participating) continue;
      const d = Math.hypot(c.px - this.bombX, c.pz - this.bombZ);
      if (d >= bestD) continue;
      bestD = d;
      bestId = c.entityId;
    }
    return bestId;
  }

  /** The loose bomb, as something to walk to. */
  private bombTarget(): ObjectiveTarget {
    const t = this.scratch;
    t.id = 'snd_bomb';
    t.label = 'BOMB';
    t.x = this.bombX;
    t.y = this.bombY;
    t.z = this.bombZ;
    t.radius = this.config.pickupRadius;
    t.action = 'collect';
    // Worth breaking off for: without the bomb the attacking side cannot win.
    t.priority = 0.9;
    return t;
  }

  private nearestDefuserId(site: ObjectiveZone): number {
    const p = site.def.position;
    let bestId = -1;
    let bestD = Infinity;
    for (const c of this.deps.roster) {
      if (c.team !== this.defenders || !c.participating) continue;
      const d = Math.hypot(c.px - p.x, c.pz - p.z);
      if (d >= bestD) continue;
      bestD = d;
      bestId = c.entityId;
    }
    return bestId;
  }

  private nearestSite(bot: Combatant): ObjectiveZone | null {
    let best: ObjectiveZone | null = null;
    let bestD = Infinity;
    for (const site of this.sites) {
      const p = site.def.position;
      const d = Math.hypot(bot.px - p.x, bot.pz - p.z);
      if (d >= bestD) continue;
      bestD = d;
      best = site;
    }
    return best;
  }

  private targetOf(site: ObjectiveZone, action: ObjectiveTarget['action'], priority: number): ObjectiveTarget {
    const t = this.scratch;
    t.id = site.id;
    t.label = site.label;
    t.x = site.def.position.x;
    t.y = site.def.position.y;
    t.z = site.def.position.z;
    t.radius = Math.max(1.2, site.def.radius * 0.7);
    t.action = action;
    t.priority = priority;
    return t;
  }

  private combatant(entityId: number): Combatant | undefined {
    for (const c of this.deps.roster) if (c.entityId === entityId) return c;
    return undefined;
  }

  private round(winner: BotTeam, reason: string): RoundResult {
    return { kind: 'round', round: this.roundIndex, winner, reason };
  }
}
