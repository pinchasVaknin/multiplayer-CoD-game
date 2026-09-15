import { camoDef, isCamoId } from '../../shared/meta/Camos';
import { challengeDef } from '../../shared/meta/Challenges';
import { levelProgress, prestigeLabel, stepLevelBar } from '../../shared/meta/Levels';
import { unlocksAtLevel } from '../../shared/meta/Unlocks';
import type { XpReport } from '../../shared/meta/XpRules';
import { requireWeapon } from '../../shared/weapons/WeaponDefs';
import type { ProceduralAudio } from '../engine/ProceduralAudio';

/**
 * The end-of-match XP breakdown (brief S6.1).
 *
 * S6.1 calls this "the payoff moment of the whole loop — give it weight, timing and
 * audio", and the M4 summary screen left `xpSlot` empty and hidden for it. So the whole
 * thing goes in there and nothing else about `EndOfMatch` changes.
 *
 * **The timing is the design.** Rows arrive one at a time on a fixed cadence, each with a
 * tick of audio, and the bar fills *behind* them as their XP lands — so the bar is a
 * running total rather than a decoration that finishes when the list does. A level-up
 * interrupts: the bar hits the right edge, flashes, resets to empty, and the level number
 * flips with a rising sting. That interruption is the moment worth building, and the
 * cadence exists to set it up.
 *
 * It runs on `requestAnimationFrame` with a wall-clock delta rather than on sim ticks,
 * deliberately: this plays over a torn-down match with no simulation running, and it is
 * presentation with no gameplay consequence — S4.1's constant `dt` governs gameplay
 * integration, and there is none here.
 *
 * ## The accordion (M15, D2)
 *
 * The element is two parts in a bottom-anchored column: the **strip** — level, bar, total —
 * which is always shown and is what the summary's band holds when nothing else is asked for,
 * and the **list** — the rows and the unlock tail — above it, `hidden` until the accordion
 * opens. The cadence plays exactly as before: rows are appended on their interval, the bar
 * fills behind them, a level-up interrupts; only the rows land out of sight until the list
 * opens, which it does on a click on the strip or on its own when the cadence finishes.
 * Opening grows the list *upward* inside the band — `max-height` from 0 to a ceiling the
 * frame's stylesheet sets, on a list that sits on the strip — so the strip, the buttons and
 * everything above the band stay where they are, and the page never moves. The band's height
 * is fixed by the screen; the ceiling is the room the list has, and a report that outruns it
 * is what `npm run layout` would refuse.
 */

/** Seconds between one row landing and the next. */
const ROW_INTERVAL = 0.34;
/** Seconds the bar takes to travel one full level. Capped so a big match is not a wait. */
const BAR_SECONDS_PER_LEVEL = 1.1;
/** Seconds the level-up flourish holds before the bar resumes. */
const LEVELUP_HOLD = 0.85;
/** Seconds after the last row before the unlock list appears. */
const TAIL_DELAY = 0.4;

type Phase = 'IDLE' | 'ROWS' | 'BAR' | 'LEVELUP' | 'TAIL' | 'DONE';

export interface XpSummaryDeps {
  /** The two cues the cadence plays. `ProceduralAudio` in the client; two no-ops on the layout probe. */
  readonly audio: Pick<ProceduralAudio, 'playXpTick' | 'playLevelUp'>;
}

export class XpSummary {
  readonly element: HTMLElement;

  /**
   * The prestige badge shown beside the level.
   *
   * Set by `Game` before `play`: prestige is a profile fact that cannot change during a
   * match, so it is not part of the match's report.
   */
  prestige = 0;

  private readonly listEl: HTMLElement;
  private readonly strip: HTMLButtonElement;
  private readonly rowsEl: HTMLElement;
  private readonly totalEl: HTMLElement;
  private readonly levelEl: HTMLElement;
  private readonly barFill: HTMLElement;
  private readonly barLabel: HTMLElement;
  private readonly flourish: HTMLElement;
  private readonly tailEl: HTMLElement;
  private opened = false;

  private readonly deps: XpSummaryDeps;

  private report: XpReport | null = null;
  private phase: Phase = 'IDLE';
  private timer = 0;
  private rowIndex = 0;
  /** XP shown by the bar right now; chases `targetXp`. */
  private shownXp = 0;
  private targetXp = 0;
  private shownTotal = 0;
  private raf = 0;
  private lastFrameMs = 0;

  constructor(deps: XpSummaryDeps) {
    this.deps = deps;

    this.element = document.createElement('div');
    this.element.className = 'xp';

    // The list: the rows and the unlock tail, above the strip, hidden until the accordion opens.
    this.listEl = document.createElement('div');
    this.listEl.className = 'xp__list';
    this.listEl.hidden = true;

    this.rowsEl = document.createElement('div');
    this.rowsEl.className = 'xp__rows';

    this.tailEl = document.createElement('div');
    this.tailEl.className = 'xp__tail';

    this.listEl.append(this.rowsEl, this.tailEl);

    // The strip: the level, the bar with its label, the running total, and the chevron. One
    // button, so the whole strip is the accordion's handle and a keyboard can reach it.
    this.strip = document.createElement('button');
    this.strip.type = 'button';
    this.strip.className = 'xp__strip';
    this.strip.setAttribute('aria-expanded', 'false');
    this.strip.addEventListener('click', () => this.toggle());

    const levelBlock = document.createElement('div');
    levelBlock.className = 'xp__level-block';
    const levelCaption = document.createElement('span');
    levelCaption.className = 'op-label';
    levelCaption.textContent = 'LEVEL';
    this.levelEl = document.createElement('span');
    this.levelEl.className = 'xp__level op-num';
    levelBlock.append(levelCaption, this.levelEl);

    const barBlock = document.createElement('div');
    barBlock.className = 'xp__bar-block';
    const bar = document.createElement('div');
    bar.className = 'xp__bar';
    this.barFill = document.createElement('i');
    bar.appendChild(this.barFill);
    this.barLabel = document.createElement('div');
    this.barLabel.className = 'xp__bar-label op-label';
    barBlock.append(bar, this.barLabel);

    this.totalEl = document.createElement('div');
    this.totalEl.className = 'xp__total op-num';

    const chevron = document.createElement('span');
    chevron.className = 'xp__chevron';
    chevron.setAttribute('aria-hidden', 'true');

    this.strip.append(levelBlock, barBlock, this.totalEl, chevron);

    this.flourish = document.createElement('div');
    this.flourish.className = 'xp__flourish';
    this.flourish.hidden = true;

    this.element.append(this.listEl, this.strip, this.flourish);
  }

  /** Whether the row list is showing. */
  get isOpen(): boolean {
    return this.opened;
  }

  /**
   * Grow the list up out of the strip. `instant` skips the transition — the layout probe's,
   * which measures in the same task it calls this in and wants the geometry the client reaches
   * `--dur-med` later, not the first keyframe of it.
   */
  open(instant = false): void {
    if (this.opened) return;
    this.opened = true;
    this.strip.setAttribute('aria-expanded', 'true');
    this.listEl.hidden = false;
    if (instant) this.element.classList.add('xp--instant');
    // A reflow between un-hiding and the class, so the height is a transition from 0.
    void this.listEl.offsetHeight;
    this.element.classList.add('xp--open');
    if (instant) {
      void this.listEl.offsetHeight;
      this.element.classList.remove('xp--instant');
    }
  }

  /** Fold the list back into the strip. */
  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.strip.setAttribute('aria-expanded', 'false');
    this.element.classList.remove('xp--open');
    const onEnd = (e: TransitionEvent): void => {
      if (e.target !== this.listEl) return;
      this.listEl.removeEventListener('transitionend', onEnd);
      if (!this.opened) this.listEl.hidden = true;
    };
    this.listEl.addEventListener('transitionend', onEnd);
  }

  toggle(): void {
    if (this.opened) this.close();
    else this.open();
  }

  /** Start the animation. Safe to call again; the previous run is abandoned. */
  play(report: XpReport): void {
    this.stop();
    this.report = report;
    // Always ROWS: `XpLines` is a non-empty tuple, so there is no such thing as a match with
    // nothing to show (playtest round 5, B6). The branch that used to skip straight to the bar
    // is what left the panel an empty box after a 0-kill loss.
    this.phase = 'ROWS';
    this.timer = 0;
    this.rowIndex = 0;
    this.shownXp = report.xpBefore;
    this.targetXp = report.xpBefore;
    this.shownTotal = 0;

    this.rowsEl.replaceChildren();
    this.tailEl.replaceChildren();
    this.tailEl.classList.remove('is-in');
    this.flourish.hidden = true;
    this.flourish.classList.remove('is-on');
    // Folded, every time: the rows land out of sight and the list opens when they are all in.
    this.opened = false;
    this.strip.setAttribute('aria-expanded', 'false');
    this.element.classList.remove('xp--open');
    this.listEl.hidden = true;
    this.paintLevel(report.levelBefore);
    this.paintBar();
    this.totalEl.textContent = '+0 XP';

    this.lastFrameMs = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Skip to the end. Bound to the Continue button so nobody has to wait it out. */
  finish(): void {
    const report = this.report;
    if (report === null) return;
    this.stop();
    for (let i = this.rowIndex; i < report.lines.length; i++) this.appendRow(i, false);
    this.rowIndex = report.lines.length;
    this.shownXp = report.xpBefore + report.total;
    this.targetXp = this.shownXp;
    this.shownTotal = report.total;
    this.totalEl.textContent = `+${report.total.toLocaleString()} XP`;
    this.paintLevel(report.levelAfter);
    this.paintBar();
    this.paintTail();
    this.phase = 'DONE';
  }

  stop(): void {
    if (this.raf !== 0) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  get isPlaying(): boolean {
    return this.phase !== 'IDLE' && this.phase !== 'DONE';
  }

  // -- animation --------------------------------------------------------------

  private readonly frame = (nowMs: number): void => {
    const dt = Math.min(0.1, Math.max(0, (nowMs - this.lastFrameMs) / 1000));
    this.lastFrameMs = nowMs;
    this.step(dt);
    if (this.phase === 'DONE') {
      this.raf = 0;
      return;
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  private step(dt: number): void {
    const report = this.report;
    if (report === null) return;
    this.timer += dt;

    switch (this.phase) {
      case 'ROWS':
        while (this.timer >= ROW_INTERVAL && this.rowIndex < report.lines.length) {
          this.timer -= ROW_INTERVAL;
          this.appendRow(this.rowIndex, true);
          this.rowIndex++;
        }
        if (this.rowIndex >= report.lines.length) {
          this.phase = 'BAR';
          this.timer = 0;
          this.targetXp = report.xpBefore + report.total;
        }
        break;

      case 'BAR':
        this.stepBar(dt, report);
        break;

      case 'LEVELUP':
        if (this.timer < LEVELUP_HOLD) break;
        this.flourish.classList.remove('is-on');
        this.phase = 'BAR';
        this.timer = 0;
        break;

      case 'TAIL':
        if (this.timer < TAIL_DELAY) break;
        this.paintTail();
        this.phase = 'DONE';
        // The cadence is over: show what it landed, without being asked (D2).
        this.open();
        break;

      case 'IDLE':
      case 'DONE':
        break;
    }
  }

  /**
   * Advance the bar, one level at a time.
   *
   * When the bar reaches the top of a level it stops there and hands over to the flourish
   * rather than rolling through, because rolling through is precisely the moment the player is
   * here for.
   *
   * **Where the bar goes is `stepLevelBar`'s decision and not this method's** (playtest round 4
   * regression). This used to do the arithmetic itself, and it invented a one-XP level above
   * the cap — `Math.max(1, xpForLevel(level))` against a function that returns zero there on
   * purpose — so a max-level summary crossed the same boundary every frame, replayed the
   * flourish for a level that never changed, and never reached `DONE`. The frame loop below
   * stops on `DONE` and nothing else, so it ran for as long as the screen was up. Everything
   * left here is presentation: the text, the bar, the flourish and the phase.
   */
  private stepBar(dt: number, report: XpReport): void {
    const step = stepLevelBar(this.shownXp, this.targetXp, dt, BAR_SECONDS_PER_LEVEL);
    this.shownXp = step.xp;
    this.shownTotal = Math.min(report.total, Math.round(this.shownXp - report.xpBefore));
    this.paintBar();

    if (step.done) {
      this.phase = 'TAIL';
      this.timer = 0;
      this.totalEl.textContent = `+${report.total.toLocaleString()} XP`;
      return;
    }

    this.totalEl.textContent = `+${this.shownTotal.toLocaleString()} XP`;
    if (step.levelUp) this.playLevelUp(levelProgress(this.shownXp).level);
  }

  private playLevelUp(level: number): void {
    this.paintLevel(level);
    const unlocked = unlocksAtLevel(level);
    this.flourish.hidden = false;
    this.flourish.replaceChildren();

    const title = document.createElement('div');
    title.className = 'xp__flourish-title';
    title.textContent = `LEVEL ${level}`;
    this.flourish.appendChild(title);

    if (unlocked.length > 0) {
      const sub = document.createElement('div');
      sub.className = 'xp__flourish-sub op-label';
      sub.textContent = `UNLOCKED · ${unlocked.join(' · ')}`;
      this.flourish.appendChild(sub);
    }
    // Force a reflow so the class change is a transition rather than an instant state.
    void this.flourish.offsetWidth;
    this.flourish.classList.add('is-on');

    this.deps.audio.playLevelUp();
    this.phase = 'LEVELUP';
    this.timer = 0;
  }

  private appendRow(index: number, withAudio: boolean): void {
    const line = this.report?.lines[index];
    if (line === undefined) return;

    const row = document.createElement('div');
    row.className = 'xp__row';

    const label = document.createElement('span');
    label.className = 'xp__row-label';
    label.textContent = line.label;

    const count = document.createElement('span');
    count.className = 'xp__row-count op-num';
    count.textContent = line.kind === 'each' && line.count > 1 ? `x${line.count}` : '';

    const value = document.createElement('span');
    value.className = 'xp__row-xp op-num';
    value.textContent = `+${line.xp.toLocaleString()}`;

    row.append(label, count, value);
    this.rowsEl.appendChild(row);
    void row.offsetWidth;
    row.classList.add('is-in');
    if (withAudio) this.deps.audio.playXpTick(index);
  }

  private paintLevel(level: number): void {
    const prestige = prestigeLabel(this.prestige);
    this.levelEl.textContent = prestige.length > 0 ? `${prestige} · ${level}` : String(level);
  }

  private paintBar(): void {
    const progress = levelProgress(this.shownXp);
    this.barFill.style.transform = `scaleX(${progress.fraction.toFixed(4)})`;
    this.barLabel.textContent = progress.atCap
      ? 'MAX LEVEL — PRESTIGE AVAILABLE'
      : `${Math.floor(progress.into).toLocaleString()} / ${progress.span.toLocaleString()} XP`;
  }

  /** Challenges, camos and weapon levels, once the bar has finished. */
  private paintTail(): void {
    const report = this.report;
    if (report === null) return;
    this.tailEl.replaceChildren();

    for (const id of report.challengesCompleted) {
      const def = challengeDef(id);
      if (def === undefined) continue;
      this.tailEl.appendChild(tag('CHALLENGE', `${def.name} — ${def.description}`));
    }
    for (const id of report.camosUnlocked) {
      if (!isCamoId(id)) continue;
      this.tailEl.appendChild(tag('CAMO', camoDef(id).name));
    }
    for (const id of report.weaponLevelUps) {
      this.tailEl.appendChild(tag('WEAPON', `${requireWeapon(id).name} levelled up`));
    }
    if (this.tailEl.childElementCount === 0) return;
    void this.tailEl.offsetWidth;
    this.tailEl.classList.add('is-in');
  }
}

function tag(kind: string, text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'xp__tag';
  const k = document.createElement('span');
  k.className = 'op-label';
  k.textContent = kind;
  const t = document.createElement('span');
  t.textContent = text;
  el.append(k, t);
  return el;
}
