import type { CamoId } from '../meta/Camos';
import type { ChallengeId } from '../meta/Challenges';
import { ScoreSystem } from '../combat/ScoreSystem';
import { DamageSystem } from '../combat/DamageSystem';
import { createGameBus, EV, type GameBus } from '../core/Events';
import { DT } from '../core/Loop';
import { ChallengeTracker } from '../meta/ChallengeTracker';
import { MatchLedger } from '../meta/MatchLedger';
import { MatchProgression } from '../meta/MatchProgression';
import type { ProgressionStore } from '../meta/ProgressionStore';
import {
  defaultSave,
  defaultSettings,
  makeWeaponSave,
  type ChallengeSaveData,
  type SaveV2,
  type WeaponSaveData,
} from '../meta/SaveData';
import { levelForXp } from '../meta/Levels';
import { LONGSHOT_METRES, matchMinutes, xpSource, type XpLine } from '../meta/XpRules';
import { DEFAULT_MOVEMENT_CONFIG } from '../player/MovementConfig';
import { PlayerController } from '../player/PlayerController';
import { DEFAULT_VIEWMODEL_CONFIG } from '../weapons/ViewmodelConfig';
import { requireWeapon } from '../weapons/WeaponDefs';
import { WeaponSystem } from '../weapons/WeaponSystem';
import { ColliderSet } from '../world/ColliderSet';
import { CollisionWorld } from '../world/CollisionWorld';

/**
 * What a match pays for having been played (playtest round 5, B6).
 *
 * The report was a whole match — 0 kills, 6 deaths, a loss — awarding `+0 XP`, with the panel
 * under the bar rendering as an empty box and the menu behind it still saying "500 XP TO NEXT"
 * with the bar on zero. Every row in `XP_SOURCES` was contingent on succeeding; there was no row
 * for showing up, so `buildLines` skipped all ten and returned nothing at all.
 *
 * This drives the real `MatchProgression` — sampled by the real `WeaponSystem` and
 * `PlayerController` it is sampled by in a match, against a real `ScoreSystem` — for a stated
 * number of ticks, then closes it out the way `MatchMeta.finish` does. Every row carries the two
 * things B6 is about: what the match paid, and how many lines the summary would have to draw.
 *
 * ## The three cases, and what each is for
 *
 * - **worst** — the report's own match: nothing scored, a loss, six minutes. Must pay more than
 *   zero and must produce at least one line. This is the case that was broken.
 * - **short** — thirty seconds of the same. Must still pay the flat award and must **not** carry
 *   a time row, because `matchMinutes` floors: a match under a minute has no whole minutes in it,
 *   and rounding up would be a number a player could farm by joining and leaving.
 * - **played** — ten minutes of the same nothing. Must pay strictly more than **worst**, which is
 *   the whole content of *"a long match pays more than a short one"*.
 *
 * ## Why the warmup arena is not a case here
 *
 * B6 asks that time in the waiting room must not pay, and the honest way to state that is that
 * there is no path for it to pay along, rather than a zero this file could assert. A summary is
 * built by `LiveMatch.buildSummary`; `WarmupMatch` has no such method. On the client,
 * `Game.applyRotation` calls `teardownWorld` before building the live world, so the live match
 * gets a `MatchProgression` constructed at zero rather than one carrying the room's minutes.
 * Asserting a zero against a call that cannot happen is a green light with no bulb behind it —
 * see PLAN.md's standing lesson about unreachable guards. `npm run skirmish` reports the room's
 * own numbers, which is where that claim is checked.
 *
 * Pure: a throwaway world, bus, score, tracker and store per row, no clock, no wire, no DOM, and
 * nobody fires. One run is a fact rather than a sample, which is what puts it beside
 * `auditAccuracy` and `auditReplicatedScore` at the top of a harness run.
 *
 * ## The second half: one fight, two ledgers (M13 Phase B, bug 4.2)
 *
 * A dedicated server now keeps a `MatchLedger` per seat and pays what it counted, where it used
 * to pay a flat list to everybody. The claim that makes that safe is that the ledger is the
 * *same counting* single-player has done since M6 — and a claim about two runtimes agreeing is
 * exactly the kind this project has learned to measure rather than argue. So `playFight` runs
 * one scripted fight — a longshot headshot, a damaged victim somebody else finishes, a death —
 * through a solo `MatchProgression` keyed to entity 0 and through a server-shaped `MatchLedger`
 * keyed to entity 7, and asserts every row the server can price comes out identical: same
 * source, same count, same XP. The two rows only a save can price — challenges and weapon
 * levels — are excluded by name, and the exclusion is printed.
 */

/** The single-player entity id, which is what `MatchProgression` attributes everything to. */
const PLAYER = 0;
const FLOOR_HALF = 60;

/**
 * A store that satisfies the rules' contract and forgets everything.
 *
 * `Profile` is the shipped implementation and lives in `client/`, behind `localStorage`, so it
 * cannot come here — which is exactly the seam `ProgressionStore` was extracted for at M9. This
 * is the second implementation that comment anticipated.
 */
class ScratchStore implements ProgressionStore {
  readonly save: SaveV2 = defaultSave(defaultSettings('TDM', 'mp_foundry', 90));

  get xp(): number {
    return this.save.profile.xp;
  }

  get prestige(): number {
    return this.save.profile.prestige;
  }

  weapon(weaponId: string): WeaponSaveData {
    const existing = this.save.weapons[weaponId];
    if (existing !== undefined) return existing;
    const fresh = makeWeaponSave();
    this.save.weapons[weaponId] = fresh;
    return fresh;
  }

  challenge(id: ChallengeId): ChallengeSaveData {
    const existing = this.save.challenges[id];
    if (existing !== undefined) return existing;
    const fresh: ChallengeSaveData = { progress: 0, completed: false };
    this.save.challenges[id] = fresh;
    return fresh;
  }

  camoOwned(id: CamoId): boolean {
    return this.save.camos[id] === true;
  }

  grantCamo(id: CamoId): void {
    this.save.camos[id] = true;
  }

  /** The same arithmetic `Profile.bankMatch` does, minus the storage write. */
  bankMatch(xpEarned: number, won: boolean): { levelBefore: number; levelAfter: number } {
    const profile = this.save.profile;
    const levelBefore = profile.level;
    profile.xp = Math.max(0, profile.xp + Math.max(0, Math.round(xpEarned)));
    profile.level = levelForXp(profile.xp);
    profile.matchesPlayed++;
    if (won) profile.matchesWon++;
    return { levelBefore, levelAfter: profile.level };
  }

  refreshUnlocks(): void {
    /* nothing reads unlocks here */
  }

  flush(): void {
    /* nothing durable here on purpose */
  }
}

export interface MatchXpRow {
  readonly shape: string;
  /** Simulated seconds the match ran. */
  readonly seconds: number;
  /** Whole minutes those seconds are worth, as `matchTime` counts them. */
  readonly minutes: number;
  readonly total: number;
  readonly lines: number;
  /** The count on the `Time played` row, or 0 when there is none. */
  readonly timeCount: number;
  /** Every line's label and value, so a reader can see what the panel would draw. */
  readonly breakdown: readonly string[];
}

/** The second half's row: the same fight, counted twice (M13 Phase B). */
export interface LedgerAgreementRow {
  readonly shape: string;
  /** Every priced line, `label x count = xp`, from the solo progression. */
  readonly solo: readonly string[];
  /** The same, from the server-shaped ledger. */
  readonly server: readonly string[];
  /** Rows only a save can price, dropped from the comparison. */
  readonly excluded: readonly string[];
  readonly agrees: boolean;
}

export interface MatchXpAudit {
  readonly rows: readonly MatchXpRow[];
  readonly agreement: readonly LedgerAgreementRow[];
  readonly problems: string[];
}

/** The seat the server-shaped ledger follows. Any id but 0 would do; 7 is not a bot's. */
const SERVER_SEAT = 7;

/** Rows a save prices. The server cannot, so they are not compared. */
const SAVE_ONLY = new Set<string>(['challenge', 'weaponLevel']);

/**
 * One scripted fight, on a bus, against a score, for `me`.
 *
 * The kill is recorded the way a match records it — `MatchFlow` subscribes to `entity.killed`
 * before any ledger does and the mode calls `ScoreSystem.recordKill` from inside it — so the
 * subscription below is made **before** the ledger under test is constructed, and the streak
 * the ledger reads off the row includes the kill being counted.
 *
 * What happens: `me` damages `V1` from beyond `LONGSHOT_METRES` and kills them with a headshot;
 * `me` damages `V2`, and a teammate `B` finishes them — an assist; then `V2` kills `me`, which
 * ends the streak at one. Kills, headshots, longshots, assists, best streak: one of each.
 */
function scriptFight(bus: GameBus, score: ScoreSystem, me: number): void {
  const V1 = 200;
  const V2 = 201;
  const B = 100;
  score.register(me, 'ME', 'A');
  score.register(B, 'B0', 'A');
  score.register(V1, 'V1', 'B');
  score.register(V2, 'V2', 'B');
  bus.on(EV.EntityKilled, (p) => score.recordKill(p.sourceId, p.targetId, p.zone === 'head', 100));
}

function fight(bus: GameBus, me: number): void {
  const V1 = 200;
  const V2 = 201;
  const B = 100;
  const damage = (sourceId: number, targetId: number, distance: number, zone: 'head' | 'torso', lethal: boolean) =>
    bus.emit(EV.DamageDealt, {
      sourceId, targetId, weaponId: 'ar_carbine', zone, amount: lethal ? 100 : 40,
      x: 0, y: 0, z: 0, distance, falloffLoss: 0, penetrationLoss: 0, lethal,
    });
  const kill = (sourceId: number, targetId: number, zone: 'head' | 'torso') =>
    bus.emit(EV.EntityKilled, { targetId, sourceId, weaponId: 'ar_carbine', zone, killerHealth: 100 });

  damage(me, V1, LONGSHOT_METRES + 4, 'head', true);
  kill(me, V1, 'head');
  damage(me, V2, 12, 'torso', false);
  damage(B, V2, 8, 'torso', true);
  kill(B, V2, 'torso');
  damage(V2, me, 10, 'torso', true);
  kill(V2, me, 'torso');
}

function describeLines(lines: readonly XpLine[]): string[] {
  return lines.map((l) => `${l.label} x${l.count} = ${Math.round(l.xp)}`);
}

/**
 * The fight through both ledgers, `seconds` long, closed out as a win by the MVP.
 *
 * Won and MVP on both sides so the two flat rows are in the comparison rather than absent from
 * it; a comparison of lists that both omit a row cannot tell whether the row is priced alike.
 */
function playFight(shape: string, seconds: number): LedgerAgreementRow {
  const ticks = Math.round(seconds / DT);

  // ---- solo: the client's arrangement, entity 0, a store and a tracker ----------------------
  const soloBus = createGameBus();
  const soloScore = new ScoreSystem(soloBus);
  const store = new ScratchStore();
  const tracker = new ChallengeTracker(store);
  tracker.reset();
  scriptFight(soloBus, soloScore, PLAYER);
  const progression = new MatchProgression({ bus: soloBus, profile: store, score: soloScore, tracker });
  {
    const damage = new DamageSystem(soloBus);
    const set = new ColliderSet(2);
    set.add({ x: 0, y: -1, z: 0 }, { x: FLOOR_HALF * 2, y: 2, z: FLOOR_HALF * 2 }, 0, 0, 0, 'floor');
    const world = new CollisionWorld(
      set,
      { min: { x: -FLOOR_HALF, y: -8, z: -FLOOR_HALF }, max: { x: FLOOR_HALF, y: 24, z: FLOOR_HALF } },
      8,
    );
    world.configure(DEFAULT_MOVEMENT_CONFIG.maxSlopeDeg, DEFAULT_MOVEMENT_CONFIG.collisionSkin);
    const player = new PlayerController({ ...DEFAULT_MOVEMENT_CONFIG }, world, soloBus);
    player.spawn(0, 0.2, 0, 0);
    const weapons = new WeaponSystem(
      requireWeapon('ar_carbine'), null, world, damage, soloBus,
      DEFAULT_VIEWMODEL_CONFIG, DEFAULT_MOVEMENT_CONFIG.walkSpeed, PLAYER,
    );
    for (let t = 0; t < ticks; t++) progression.sample(player.sim, weapons, t);
  }
  fight(soloBus, PLAYER);
  const soloReport = progression.finish(true, true);
  progression.dispose();
  soloScore.dispose();

  // ---- server: a ledger keyed to a seat, nothing sampled, the match's own length ---------
  const serverBus = createGameBus();
  const serverScore = new ScoreSystem(serverBus);
  scriptFight(serverBus, serverScore, SERVER_SEAT);
  const ledger = new MatchLedger({ bus: serverBus, score: serverScore, entityId: SERVER_SEAT });
  fight(serverBus, SERVER_SEAT);
  const serverLines = ledger.lines(true, true, seconds);
  ledger.dispose();
  serverScore.dispose();

  const excluded = soloReport.lines.filter((l) => SAVE_ONLY.has(l.id));
  const solo = describeLines(soloReport.lines.filter((l) => !SAVE_ONLY.has(l.id)));
  const server = describeLines(serverLines.filter((l) => !SAVE_ONLY.has(l.id)));
  return {
    shape,
    solo,
    server,
    excluded: describeLines(excluded),
    agrees: solo.length === server.length && solo.every((line, i) => line === server[i]),
  };
}

/**
 * One match of doing nothing at all, for `seconds`, then closed out as a loss.
 *
 * Nothing is scored on purpose: B6 is about the floor, and a single kill would put a row in the
 * panel that hides whether the floor is there. The trigger is never pulled — the buttons stay at
 * zero — so this is a player who stood still for the whole match, which is the harshest reading
 * of the report and the one the award has to survive.
 */
function playNothing(shape: string, seconds: number): MatchXpRow {
  const bus = createGameBus();
  const damage = new DamageSystem(bus);
  const score = new ScoreSystem(bus);
  const store = new ScratchStore();
  const tracker = new ChallengeTracker(store);
  tracker.reset();
  const progression = new MatchProgression({ bus, profile: store, score, tracker });

  score.register(PLAYER, 'OPERATOR', 'A');

  const set = new ColliderSet(2);
  set.add({ x: 0, y: -1, z: 0 }, { x: FLOOR_HALF * 2, y: 2, z: FLOOR_HALF * 2 }, 0, 0, 0, 'floor');
  const world = new CollisionWorld(
    set,
    { min: { x: -FLOOR_HALF, y: -8, z: -FLOOR_HALF }, max: { x: FLOOR_HALF, y: 24, z: FLOOR_HALF } },
    8,
  );
  world.configure(DEFAULT_MOVEMENT_CONFIG.maxSlopeDeg, DEFAULT_MOVEMENT_CONFIG.collisionSkin);

  const player = new PlayerController({ ...DEFAULT_MOVEMENT_CONFIG }, world, bus);
  player.spawn(0, 0.2, 0, 0);
  const weapons = new WeaponSystem(
    requireWeapon('ar_carbine'),
    null,
    world,
    damage,
    bus,
    DEFAULT_VIEWMODEL_CONFIG,
    DEFAULT_MOVEMENT_CONFIG.walkSpeed,
    PLAYER,
  );

  const ticks = Math.round(seconds / DT);
  for (let t = 0; t < ticks; t++) {
    progression.sample(player.sim, weapons, t);
  }

  const report = progression.finish(false, false);
  progression.dispose();
  score.dispose();

  return {
    shape,
    seconds,
    minutes: matchMinutes(seconds),
    total: report.total,
    lines: report.lines.length,
    timeCount: report.lines.find((l) => l.id === 'matchTime')?.count ?? 0,
    breakdown: report.lines.map((l) => `${l.label} x${l.count} = ${Math.round(l.xp)}`),
  };
}

export function auditMatchXp(): MatchXpAudit {
  const problems: string[] = [];
  const rows: MatchXpRow[] = [
    playNothing('worst', 6 * 60),
    playNothing('short', 30),
    playNothing('played', 10 * 60),
  ];
  const agreement: LedgerAgreementRow[] = [playFight('fight', 4 * 60)];

  for (const row of agreement) {
    if (!row.agrees) {
      problems.push(
        `${row.shape}: the solo progression and the server ledger priced the same fight ` +
          `differently — solo [${row.solo.join(', ')}] against server [${row.server.join(', ')}]. ` +
          'A dedicated server pays what the client would have paid, or it pays a different game.',
      );
    }
    // The fight is scripted to earn one of each; a ledger that priced none of them is not
    // counting, and two ledgers agreeing on nothing is not agreement.
    for (const wanted of ['Kills x1', 'Headshots x1', 'Assists x1', 'Longshots x1', 'Best streak x1', 'Match win x1', 'MVP x1']) {
      if (!row.server.some((line) => line.startsWith(wanted))) {
        problems.push(`${row.shape}: the server ledger has no "${wanted}" row for a fight that earned one.`);
      }
    }
  }

  const floor = xpSource('matchComplete').value;

  for (const row of rows) {
    if (row.lines === 0) {
      problems.push(
        `${row.shape}: the summary would render an empty panel. That is the second half of B6 — ` +
          'an empty box reads as broken rather than as harsh — and `XpLines` is a non-empty ' +
          'tuple precisely so this cannot compile, let alone happen.',
      );
    }
    if (row.total < floor) {
      problems.push(
        `${row.shape}: a match played to the end paid ${row.total}, under the ${floor} flat ` +
          'award every finished match carries. Every row in XP_SOURCES used to be contingent ' +
          'on succeeding; matchComplete is the one that is not.',
      );
    }
  }

  for (const row of rows) {
    /*
     * The minutes asked for against the minutes awarded, and this is not a formality.
     *
     * It went red the first time it ran: `secondsPlayed` was accumulated as `+= DT` once a
     * tick, `DT` is `1/60`, and thirty-six thousand of those sum to 599.999999999783 — so a
     * ten-minute match paid for nine whole minutes. Counting ticks and multiplying once has no
     * drift, and this line is why anybody knew there was one.
     */
    if (row.timeCount !== row.minutes) {
      problems.push(
        `${row.shape}: ${row.seconds}s is ${row.minutes} whole minute(s) but the row awarded ` +
          `${row.timeCount}. The clock the award is counted on disagrees with matchMinutes, ` +
          'which is a drift rather than a rule.',
      );
    }
  }

  const short = rows.find((r) => r.shape === 'short');
  if (short !== undefined && short.minutes !== 0) {
    problems.push(
      `short: ${short.seconds}s came out as ${short.minutes} minute(s). matchMinutes floors, so ` +
        'a match under a minute has none — rounding up is a number a player can farm by ' +
        'joining and leaving.',
    );
  }
  if (short !== undefined && short.total !== floor) {
    problems.push(
      `short: paid ${short.total} where the flat award alone is ${floor}. A sub-minute match ` +
        'carries the floor and no time row.',
    );
  }

  const worst = rows.find((r) => r.shape === 'worst');
  const played = rows.find((r) => r.shape === 'played');
  if (worst !== undefined && played !== undefined && played.total <= worst.total) {
    problems.push(
      `played (${played.seconds}s) paid ${played.total} against worst (${worst.seconds}s) at ` +
        `${worst.total}. "A long match pays more than a short one" is the whole of the ` +
        'per-minute term, and it is not holding.',
    );
  }

  return { rows, agreement, problems };
}
