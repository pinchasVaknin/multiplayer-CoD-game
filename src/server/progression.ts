import {
  LEVEL_XP,
  MAX_LEVEL,
  XP_TO_MAX,
  levelForXp,
  stepLevelBar,
  xpAtLevelStart,
  xpForLevel,
} from '../shared/meta/Levels';

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

process.exitCode = main() > 0 ? 1 : 0;
