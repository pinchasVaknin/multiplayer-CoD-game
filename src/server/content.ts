import { EventBus } from '../shared/core/EventBus';
import type { GameEvents } from '../shared/core/Events';
import { LocalIdentity } from '../shared/combat/LocalIdentity';
import { ScoreSystem, type PlayerScore, type ScoreTeam } from '../shared/combat/ScoreSystem';
import type { GameMode, ModeDeps } from '../shared/modes/GameMode';
import { MAPS, MODES, type MapEntry, type ModeEntry } from '../shared/modes/ModeRegistry';
import { FOUNDRY_MAP } from '../shared/world/maps/foundry';

/**
 * The content facts a refactor of the modes or the maps must leave untouched, printed.
 *
 * ## Why an eighth entry point
 *
 * The same reason as `readability` and `progression`: these are properties of the **content**,
 * not of a run. What a mode's scoreboard columns are, what its win condition says for a given
 * pair of team scores with time on or off the clock, and where a map puts its spawns are all
 * pure functions of the authored tables, so one execution is a fact rather than a sample, and
 * two runs on the same tree print the same bytes. That is what makes this a regression gate
 * for a structural change: run it, change the structure, run it again, `diff`.
 *
 * The match harness exercises the win condition end to end, but only through the outcome of a
 * whole seeded match; the scoreboard columns are rendered by the client and reach no headless
 * instrument at all. This prints them directly.
 *
 * ## What it prints
 *
 *   - Per mode: every column's key, label, width and alignment, and what `value()` renders for
 *     three fixed rows (an empty row, a row with everything, and a row that divides awkwardly).
 *   - Per mode: `checkWinCondition()` over a grid of (score A, score B) with the clock running
 *     and with it run out. Modes whose condition does not depend on team score (Free-for-All,
 *     Search & Destroy) print whatever they answer; the point is that the answer does not move.
 *   - Per map: every spawn zone, in authored order.
 *
 * Exit code is always 0: this is a printer, not a judge. `diff` is the judge.
 */

const FIXED_ROWS: readonly PlayerScore[] = [
  row(1, 'EMPTY', 'A', 0, 0, 0, 0, 0, 0, 0, 0),
  row(2, 'FULL', 'B', 12, 4, 3, 1450, 7, 40, 25, 2),
  row(3, 'THIRDS', 'A', 1, 3, 0, 100, 1, 3, 1, 0),
];

function row(
  entityId: number,
  displayName: string,
  team: ScoreTeam,
  kills: number,
  deaths: number,
  assists: number,
  score: number,
  bestStreak: number,
  shotsFired: number,
  shotsHit: number,
  objective: number,
): PlayerScore {
  return {
    entityId,
    displayName,
    team,
    isLocal: false,
    kills,
    deaths,
    assists,
    score,
    streak: 0,
    bestStreak,
    shotsFired,
    shotsHit,
    damageDealt: kills * 100,
    headshots: 0,
    captures: objective,
    defends: objective,
    plants: objective,
    defuses: objective,
    tags: objective,
  };
}

/** (score A, score B) pairs: nothing, one short of the limit, at it, past it, tied at it, a lead either way. */
const SCORE_GRID: readonly (readonly [number, number])[] = [
  [0, 0], [74, 0], [75, 0], [0, 75], [75, 75], [80, 75], [40, 30], [30, 40], [1, 1],
];

/** The round is a second long, so 120 ticks at 60 Hz runs the clock out with margin. */
const ROUND_SECONDS_OVERRIDE = 1;
const TICKS_TO_RUN_OUT = 120;

function makeMode(entry: ModeEntry): { mode: GameMode; deps: ModeDeps } {
  const bus = new EventBus<GameEvents>();
  const deps: ModeDeps = {
    bus,
    score: new ScoreSystem(bus, new LocalIdentity(), true),
    roster: [],
    mapDef: FOUNDRY_MAP,
    roundSecondsOverride: ROUND_SECONDS_OVERRIDE,
    variant: 'STANDARD',
  };
  return { mode: entry.create(deps), deps };
}

function printColumns(entry: ModeEntry): void {
  const { mode } = makeMode(entry);
  console.log(`\n== ${entry.id} columns`);
  for (const col of mode.getScoreboardColumns()) {
    const values = FIXED_ROWS.map((r) => JSON.stringify(col.value(r))).join(' ');
    console.log(`  ${col.key.padEnd(8)} label=${JSON.stringify(col.label).padEnd(10)} width=${String(col.width).padStart(2)} align=${col.align.padEnd(6)} ${values}`);
  }
}

function describe(result: ReturnType<GameMode['checkWinCondition']>): string {
  if (result === null) return 'null';
  return JSON.stringify(result);
}

function printWinGrid(entry: ModeEntry): void {
  console.log(`\n== ${entry.id} win condition`);
  for (const clockRunsOut of [false, true]) {
    for (const [a, b] of SCORE_GRID) {
      let text: string;
      try {
        const { mode, deps } = makeMode(entry);
        mode.onRoundStart(1);
        deps.score.addTeamScore('A', a);
        deps.score.addTeamScore('B', b);
        if (clockRunsOut) for (let t = 0; t < TICKS_TO_RUN_OUT; t++) mode.onTick(t);
        text = describe(mode.checkWinCondition());
      } catch (err) {
        text = `throws ${err instanceof Error ? err.constructor.name + ': ' + err.message : String(err)}`;
      }
      console.log(`  A=${String(a).padStart(2)} B=${String(b).padStart(2)} clock=${clockRunsOut ? 'out    ' : 'running'} -> ${text}`);
    }
  }
}

function printSpawns(entry: MapEntry): void {
  console.log(`\n== ${entry.id} spawns (${entry.def.spawns.length})`);
  for (const z of entry.def.spawns) {
    console.log(`  ${z.team} (${z.position.x}, ${z.position.y}, ${z.position.z}) yaw=${z.facingYaw} r=${z.radius}`);
  }
}

function main(): number {
  console.log('PROTOCOL SEVEN — content facts (modes and maps)');
  for (const entry of MODES) printColumns(entry);
  for (const entry of MODES) printWinGrid(entry);
  for (const entry of MAPS) printSpawns(entry);
  return 0;
}

process.exit(main());
