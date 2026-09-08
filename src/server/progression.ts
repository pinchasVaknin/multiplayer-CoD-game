import {
  LEVEL_XP,
  MAX_LEVEL,
  XP_TO_MAX,
  levelForXp,
  stepLevelBar,
  xpAtLevelStart,
  xpForLevel,
} from '../shared/meta/Levels';
import { defaultLoadouts, type LoadoutSlot } from '../shared/meta/Loadouts';
import { defaultSave, defaultSettings } from '../shared/meta/SaveData';
import { sanitiseLoadout, UnlockState } from '../shared/meta/Unlocks';
import { AVERAGE_MATCH, xpPerMatch, type SimulatedMatch } from '../shared/meta/XpSimulator';
import { ALL_WEAPONS, requireWeapon } from '../shared/weapons/WeaponDefs';

/**
 * The summary screen's XP bar, stepped to completion without a screen.
 *
 * ## Why a fifth entry point
 *
 * The same reason `readability` is the fourth: this is a property of the **content and the
 * arithmetic**, not of a run. `stepLevelBar` is a pure function of the authored level table, so
 * one execution of this is a fact rather than a sample, and two runs on the same tree are
 * identical — which is exactly what the wall-clock-paced harnesses cannot promise.
 *
 * ## What it is for
 *
 * A summary screen that never finishes its animation is invisible to every instrument this
 * project has. `HeadlessClient` builds no `ClientMatch` and no DOM; the skirmish harness at
 * shipped timings has never once reached a summary; and the browser preview never fires
 * `requestAnimationFrame`. So a bar that crossed the same boundary forever, replaying the
 * level-up flourish every 0.85 s, could sit in the tree from M9 to playtest round 4 with every
 * check green.
 *
 * What makes it checkable is that `XpSummary` no longer decides where the bar goes. The frame
 * loop, the flourish and the DOM stay in `client/`; the decision — advance, hold, or stop — is
 * `stepLevelBar`, and stepping it in a loop until it says `done` is an ordinary function call
 * with an ordinary answer.
 *
 * **The bound is the assertion.** A step count is not interesting; a step count that exists at
 * all is. `MAX_STEPS` is far above any legitimate animation — the longest honest run is the
 * whole curve at `BAR_SECONDS_PER_LEVEL` per level, a few thousand frames — so reaching it
 * means the loop does not terminate, and that is a failure rather than a reading.
 */

/** 60 Hz frames. `XpSummary` clamps its own `dt` to 0.1 s, so this is the shipped step. */
const DT = 1 / 60;

/** Mirrors `XpSummary.BAR_SECONDS_PER_LEVEL`. */
const SECONDS_PER_LEVEL = 1.1;

/**
 * Ten minutes of frames. Nothing legitimate comes close: the entire curve from level 1 to 55
 * animates in 54 x 1.1 s, under four thousand frames.
 */
const MAX_STEPS = 36_000;

function padStart(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

function padEnd(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

interface BarRun {
  readonly steps: number;
  readonly levelUps: number;
  readonly finalXp: number;
  readonly terminated: boolean;
}

/** Step the bar from `xpBefore` to `xpBefore + total` and report what happened. */
function runBar(xpBefore: number, total: number): BarRun {
  const target = xpBefore + total;
  let xp = xpBefore;
  let levelUps = 0;
  for (let steps = 1; steps <= MAX_STEPS; steps++) {
    const step = stepLevelBar(xp, target, DT, SECONDS_PER_LEVEL);
    xp = step.xp;
    if (step.levelUp) levelUps++;
    if (step.done) return { steps, levelUps, finalXp: xp, terminated: true };
  }
  return { steps: MAX_STEPS, levelUps, finalXp: xp, terminated: false };
}

/**
 * The bar as it was before the fix, kept as a **permanent red control**.
 *
 * §8.22's Ghost check makes the argument for this and it applies here: *"a probe that only ever
 * goes green proves that the contact list is empty, not that Ghost works."* An instrument that
 * cannot be shown to fail is not an instrument. This is the pre-round-4 arithmetic verbatim,
 * including the `Math.max(1, ...)` that manufactured a one-XP level above the cap, and it is run
 * on the max-level case only — the one it gets wrong.
 *
 * It is not called by anything that ships. If a future change to the level table makes this
 * version terminate, the control has stopped controlling and the report says so.
 */
function runBarLegacy(xpBefore: number, total: number): BarRun {
  const target = xpBefore + total;
  let xp = xpBefore;
  let levelUps = 0;
  for (let steps = 1; steps <= MAX_STEPS; steps++) {
    if (xp >= target) return { steps, levelUps, finalXp: xp, terminated: true };
    const level = levelForXp(xp);
    // The defect, in one expression: `xpForLevel` returns 0 at the cap and this insists on 1.
    const span = Math.max(1, xpForLevel(level));
    const rate = span / SECONDS_PER_LEVEL;
    const nextLevelAt = xpAtLevelStart(level) + span;
    const advanced = Math.min(target, xp + rate * DT);
    const crossed = advanced >= nextLevelAt && target >= nextLevelAt;
    xp = crossed ? nextLevelAt : advanced;
    if (crossed) {
      xp = nextLevelAt + 1e-6;
      levelUps++;
    }
  }
  return { steps: MAX_STEPS, levelUps, finalXp: xp, terminated: false };
}

interface Case {
  readonly name: string;
  readonly xpBefore: number;
  readonly total: number;
  /** Level-ups this run must produce. The bound is the assertion; this is the behaviour. */
  readonly expectLevelUps: number;
}

/**
 * The cases, and each is here because it is a way for the step to have nothing ahead of it.
 *
 * The last two are the pair the round-4 report turned on: at the cap `xpForLevel` is zero, and
 * a report that adds nothing is already at its target. Both used to be handled by separate
 * special cases — one of them a `Math.max(1, ...)` that manufactured a level — and both now
 * fall out of the same comparison.
 */
const CASES: readonly Case[] = [
  { name: 'level 1, no XP earned', xpBefore: 0, total: 0, expectLevelUps: 0 },
  { name: 'level 1, half a level', xpBefore: 0, total: 200, expectLevelUps: 0 },
  { name: 'level 1 -> 2, exactly one level', xpBefore: 0, total: LEVEL_XP[0] ?? 500, expectLevelUps: 1 },
  { name: 'level 1 -> 4, three levels', xpBefore: 0, total: 2100, expectLevelUps: 3 },
  { name: 'mid-curve, level 30 -> 31', xpBefore: xpAtLevelStart(30), total: xpForLevel(30), expectLevelUps: 1 },
  {
    name: 'the whole curve, level 1 -> 55',
    xpBefore: 0,
    total: XP_TO_MAX,
    expectLevelUps: MAX_LEVEL - 1,
  },
  {
    name: 'AT THE CAP, earning more — the round-4 regression',
    xpBefore: XP_TO_MAX,
    total: 4_000,
    expectLevelUps: 0,
  },
  {
    name: 'at the cap, a match worth nothing',
    xpBefore: XP_TO_MAX,
    total: 0,
    expectLevelUps: 0,
  },
  {
    name: 'the last level, 54 -> 55, then past it',
    xpBefore: xpAtLevelStart(MAX_LEVEL - 1),
    total: (xpForLevel(MAX_LEVEL - 1) ?? 0) + 9_000,
    expectLevelUps: 1,
  },
];

function main(): number {
  console.log('OPERATOR — progression probe (playtest round 4)\n');
  console.log(
    'level table: %d levels, %s XP to the cap, %s XP in the last step',
    MAX_LEVEL,
    XP_TO_MAX.toLocaleString(),
    (LEVEL_XP[LEVEL_XP.length - 1] ?? 0).toLocaleString(),
  );
  console.log('bar: %s s per level at %d Hz, giving up after %d steps\n', SECONDS_PER_LEVEL, 60, MAX_STEPS);

  let failures = 0;
  console.log(`  ${padEnd('case', 48)}${padStart('steps', 8)}${padStart('level-ups', 11)}  result`);
  for (const c of CASES) {
    const run = runBar(c.xpBefore, c.total);
    const levelUpsOk = run.levelUps === c.expectLevelUps;
    const landedOk = run.terminated && run.finalXp >= c.xpBefore + c.total - 1;
    const ok = run.terminated && levelUpsOk && landedOk;
    if (!ok) failures++;
    console.log(
      `  ${padEnd(c.name, 48)}` +
        `${padStart(run.terminated ? String(run.steps) : `>${MAX_STEPS}`, 8)}` +
        `${padStart(`${run.levelUps}/${c.expectLevelUps}`, 11)}  ` +
        `${ok ? 'ok' : run.terminated ? 'WRONG' : 'DID NOT TERMINATE'}`,
    );
  }

  /**
   * The red control, on the case it gets wrong.
   *
   * The count is **boundary crossings, not flourishes**, and the difference matters. On screen
   * each crossing sets `phase = 'LEVELUP'`, which holds for `LEVELUP_HOLD` (0.85 s) before
   * handing back to the bar, so the player hears roughly one flourish a second rather than one
   * a frame. What the number establishes is the thing the screen's pacing hides: there is no
   * last crossing. The bar never reaches its end state, so the frame loop never stops.
   *
   * That is also what identifies the mechanism. The sound repeats because the loop replays it,
   * not because a voice is stuck: `AudioGraph.oscHit` sets `endsAt` from the spec's decay and
   * `AudioGraph.update` releases every voice past it once a frame, so nothing can be held.
   */
  const control = runBarLegacy(XP_TO_MAX, 4_000);
  console.log(
    '\nRED CONTROL — the pre-fix arithmetic on the same max-level case: %s after %s steps, %d level-up(s) fired.',
    control.terminated ? 'terminated' : 'DID NOT TERMINATE',
    control.terminated ? String(control.steps) : `>${MAX_STEPS}`,
    control.levelUps,
  );
  if (control.terminated) {
    console.log('  WARNING: the red control now terminates, so it is no longer controlling anything.');
    failures++;
  }

  /**
   * The level the bar reports at the cap, which is the other half of the same bug.
   *
   * The old code called `playLevelUp(levelProgress(shownXp).level)` after every crossing, and at
   * the cap that argument was 55 every time — the flourish announced a level the player already
   * had. Printed rather than asserted: it is a fact about `levelForXp`, and it is what makes a
   * repeating flourish identifiable as a loop rather than as a stuck voice.
   */
  console.log(
    '\nat the cap: level %d, span %d XP, next boundary %s — nothing ahead, so nothing to cross.',
    levelForXp(XP_TO_MAX),
    xpForLevel(MAX_LEVEL),
    (xpAtLevelStart(MAX_LEVEL) + xpForLevel(MAX_LEVEL)).toLocaleString(),
  );

  console.log('\nprogression checks failed: %d', failures);
  return failures;
}
// -- the unlock ladder, and the first hour (playtest round 5, F10) -------------------------

/**
 * The primaries a level-1 profile is meant to hold.
 *
 * **This is the decision, not a reading of the table.** A probe that asked `WEAPON_DEFS` which
 * weapons unlock at level 1 and then asserted that those weapons unlock at level 1 would be
 * green on every tree, including the one F10 was reported against. The list is written out here
 * so that changing the arsenal is an argument with this file rather than a side effect of
 * editing a def.
 *
 * The principle, so a future change has something to disagree with: **three weapons that lose
 * different fights.** `docs/BALANCE.md`'s band table gives the carbine 15-25 m at 0.167 s, the
 * WASP 0-7 m at 0.117 s with a cliff past 18 m, and the BREACHER one shell inside 6 m and
 * nothing at all past 13. Neither sniper nor either LMG is here, and that is the same principle
 * from the other side: both cost a mechanic a first-time player has not been taught — 0.35-0.44 s
 * of scope-in with sway and a glint, and a 0.42 s ADS behind a four-second reload.
 */
const LEVEL_ONE_PRIMARIES: readonly string[] = ['ar_carbine', 'smg_wasp', 'shotgun_breacher'];

/**
 * A first match, as a **declared scenario rather than a measurement**.
 *
 * `AVERAGE_MATCH` is authored against the M4/M5 acceptance runs and describes a competent
 * player: 18 kills, a third of them headshots. Nobody at level 1 plays that match, so every
 * "matches to unlock" number computed from it is the optimistic end of a range. This is the
 * other end, written down so the two bracket the answer instead of one of them pretending to be
 * it. It is nobody's measurement: playtest round 5 was driven by a script that stood still for
 * long stretches, so this project has no measured new-player scoreline and this file will not
 * invent one.
 */
const NEWCOMER_MATCH: SimulatedMatch = {
  kills: 6,
  headshots: 1,
  assists: 3,
  objectives: 0,
  longshots: 0,
  bestStreak: 2,
  winRate: 0.35,
  mvpRate: 0,
  challengeXp: 200,
};

/**
 * The match a player earning `perMatch` first reaches `level` in. Level 1 is match zero.
 *
 * Closed form rather than a loop over `simulateXp`, and the same answer: the rate is constant
 * per match, so the first total to clear `xpAtLevelStart(level)` is the ceiling of one division.
 * The value that could drift — what a match is worth — comes from `xpPerMatch`, which reads the
 * shipped `XP_SOURCES` table.
 */
function matchAtLevel(level: number, perMatch: number): number {
  if (level <= 1) return 0;
  return Math.ceil(xpAtLevelStart(level) / Math.max(1, perMatch));
}

interface Rung {
  readonly id: string;
  readonly name: string;
  readonly cls: string;
  readonly level: number;
  readonly xp: number;
  readonly averageMatch: number;
  readonly newcomerMatch: number;
}

function buildLadder(averagePerMatch: number, newcomerPerMatch: number): Rung[] {
  return ALL_WEAPONS.filter((def) => def.slot === 'primary')
    .map((def) => ({
      id: def.id,
      name: def.name,
      cls: def.class,
      level: def.unlockLevel,
      xp: xpAtLevelStart(def.unlockLevel),
      averageMatch: matchAtLevel(def.unlockLevel, averagePerMatch),
      newcomerMatch: matchAtLevel(def.unlockLevel, newcomerPerMatch),
    }))
    .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
}

/**
 * Everything about a class a player can see on the Create a Class screen.
 *
 * Two classes with the same signature are the report. *"All five classes show M4 CARBINE"* was
 * the visible half of five slots identical in every field, because at level 1 there was nothing
 * legal for them to differ on.
 */
function presetSignature(slot: LoadoutSlot): string {
  return [
    slot.primary.weaponId,
    slot.secondary.weaponId,
    slot.lethal,
    slot.tactical,
    slot.fieldUpgrade,
    slot.perks.map((perk) => perk ?? '-').join('/'),
    slot.streaks.map((streak) => streak ?? '-').join('/'),
  ].join(' · ');
}

function ladder(): number {
  const problems: string[] = [];
  const averagePerMatch = xpPerMatch(AVERAGE_MATCH);
  const newcomerPerMatch = xpPerMatch(NEWCOMER_MATCH);

  const save = defaultSave(defaultSettings('TDM', 'mp_foundry', 90));
  const unlocks = UnlockState.fromSave(save);
  const rungs = buildLadder(averagePerMatch, newcomerPerMatch);

  console.log('\n\nOPERATOR — the unlock ladder (playtest round 5, F10)\n');
  console.log(
    'a match pays %s XP at the shipped AVERAGE_MATCH and %s at the declared NEWCOMER_MATCH;',
    averagePerMatch.toLocaleString(),
    newcomerPerMatch.toLocaleString(),
  );
  console.log('a fresh profile is level %d with %d XP.\n', save.profile.level, save.profile.xp);

  console.log(
    `  ${padEnd('primary', 16)}${padEnd('class', 9)}${padStart('level', 6)}${padStart('XP', 10)}` +
      `${padStart('match', 7)}${padStart('newcomer', 10)}  at level 1`,
  );
  for (const rung of rungs) {
    const open = unlocks.weaponUnlocked(rung.id);
    console.log(
      `  ${padEnd(rung.name, 16)}${padEnd(rung.cls, 9)}${padStart(String(rung.level), 6)}` +
        `${padStart(rung.xp.toLocaleString(), 10)}${padStart(String(rung.averageMatch), 7)}` +
        `${padStart(String(rung.newcomerMatch), 10)}  ${open ? 'OPEN' : 'locked'}`,
    );
  }

  // 1. The level-1 arsenal is the one that was decided, and nothing else is.
  for (const id of LEVEL_ONE_PRIMARIES) {
    const def = requireWeapon(id);
    if (def.slot !== 'primary') {
      problems.push(`LEVEL_ONE_PRIMARIES names ${def.name}, which is a ${def.slot} and not a primary.`);
      continue;
    }
    if (!unlocks.weaponUnlocked(id)) {
      problems.push(
        `${def.name} is meant to be available at level 1 and is gated at ${def.unlockLevel}. A ` +
          'fresh profile cannot equip it, and sanitiseLoadout rewrites any class that names it.',
      );
    }
  }
  for (const rung of rungs) {
    if (LEVEL_ONE_PRIMARIES.includes(rung.id)) continue;
    if (unlocks.weaponUnlocked(rung.id)) {
      problems.push(
        `${rung.name} is open at level 1 and is not one of the primaries that decision names. A ` +
          'ladder with nothing left on it is the other way to fail F10.',
      );
    }
  }

  // 2. Three weapons that lose different fights, rather than three of one kind.
  const startingClasses = new Set(LEVEL_ONE_PRIMARIES.map((id) => requireWeapon(id).class));
  if (startingClasses.size < 3) {
    problems.push(
      `the level-1 arsenal spans ${startingClasses.size} weapon class(es): ` +
        `${[...startingClasses].join(', ')}. The point of opening more than one primary is a ` +
        'choice between feels, and three of one class is one feel.',
    );
  }

  /**
   * 3. The rungs are spaced in **matches**, which is the unit the player experiences.
   *
   * This is the assertion that makes the level table half of the same conversation. The opening
   * of `LEVEL_XP` is front-loaded hard enough that four early levels land inside one match, so
   * two unlocks two levels apart arrive on the same summary screen — a re-spacing on paper that
   * is no spacing at all in play. Measured at the optimistic rate, which is the strict one: a
   * slower player only ever spreads these further apart.
   */
  const gated = rungs.filter((rung) => !LEVEL_ONE_PRIMARIES.includes(rung.id));
  for (let i = 1; i < gated.length; i++) {
    const previous = gated[i - 1];
    const current = gated[i];
    if (previous === undefined || current === undefined) continue;
    if (current.averageMatch <= previous.averageMatch) {
      problems.push(
        `${previous.name} (level ${previous.level}) and ${current.name} (level ${current.level}) ` +
          `both arrive in match ${current.averageMatch}: ${current.level - previous.level} ` +
          'level(s) apart on paper and no matches apart in play.',
      );
    }
  }
  const firstGated = gated[0];
  if (firstGated !== undefined && firstGated.averageMatch < 1) {
    problems.push(`${firstGated.name} is reached before a single match has been played.`);
  }

  // 4. The five classes, which is the screen the report is about.
  const presets = defaultLoadouts();
  console.log('\n  the five shipped classes, on a fresh profile:\n');
  const seen = new Map<string, string>();
  for (const slot of presets) {
    const signature = presetSignature(slot);
    console.log(`  ${padEnd(slot.name, 10)}${signature}`);
    const twin = seen.get(signature);
    if (twin !== undefined) {
      problems.push(
        `classes ${twin} and ${slot.name} are identical in every field a player can see. That is ` +
          'F10 as reported: five slots and one class.',
      );
    }
    seen.set(signature, slot.name);
  }

  // 5. A class that names a locked item is rewritten on first load, and a rewritten default is
  //    indistinguishable from a bug. This is what holds the two halves to each other.
  for (const slot of presets) {
    const losses: string[] = [];
    if (sanitiseLoadout(slot, unlocks, losses)) {
      for (const loss of losses) problems.push(`default class rewritten on a fresh profile: ${loss}`);
    }
  }

  // 6. Nothing is opened at level 1 that the screen never shows.
  const carried = new Set(presets.map((slot) => slot.primary.weaponId));
  for (const id of LEVEL_ONE_PRIMARIES) {
    if (!carried.has(id)) {
      problems.push(
        `${requireWeapon(id).name} is available at level 1 and no default class carries it. The ` +
          'screen is where the decision becomes visible, and an unlock nothing shows is one ' +
          'nobody finds.',
      );
    }
  }

  for (const problem of problems) console.log(`\n  LADDER: ${problem}`);
  console.log('\nladder checks failed: %d', problems.length);
  return problems.length;
}

process.exitCode = main() + ladder() > 0 ? 1 : 0;
