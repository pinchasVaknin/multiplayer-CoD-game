import type { CamoId } from '../meta/Camos';
import type { ChallengeId } from '../meta/Challenges';
import { ScoreSystem } from '../combat/ScoreSystem';
import { DamageSystem } from '../combat/DamageSystem';
import { createGameBus } from '../core/Events';
import { DT } from '../core/Loop';
import { ChallengeTracker } from '../meta/ChallengeTracker';
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
import { matchMinutes, xpSource } from '../meta/XpRules';
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

export interface MatchXpAudit {
  readonly rows: readonly MatchXpRow[];
  readonly problems: string[];
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

  return { rows, problems };
}
