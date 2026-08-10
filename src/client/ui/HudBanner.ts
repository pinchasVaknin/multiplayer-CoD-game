/**
 * The score banner and the round timer (brief S6.4).
 *
 * Three numbers, and all three are read at a glance mid-firefight, so the whole design is
 * about legibility rather than decoration: tabular numerals so a score going from 9 to 10
 * does not shift the layout, one accent colour, and a progress bar per side so "how close is
 * this" is answerable without doing arithmetic.
 *
 * Every write is guarded on the value having actually changed. The clock ticks once a second
 * and the scores change every few seconds, so in a normal frame this class writes nothing at
 * all — which is the point of the DOM-cost note in S7.
 */

export interface BannerState {
  scoreA: number;
  scoreB: number;
  limit: number;
  /** Seconds left in the round. Negative or zero shows as 0:00. */
  secondsRemaining: number;
  /** 1-based; only shown when the mode actually uses rounds. */
  round: number;
  roundsToWin: number;
  /** Warm-up or round-end countdown; 0 while the round is live. */
  phaseSeconds: number;
  phaseLabel: string;
  /**
   * Free-for-All: there are no teams to put on either side of the clock.
   *
   * FFA keeps the two-team substrate internally and the banner read it literally, so eight
   * individuals were presented as a team score that means nothing to anybody in the match. The
   * numbers an FFA player tracks are *who is winning* and *where am I*.
   */
  ffa: boolean;
  /** Leader's name and score, FFA only. */
  leaderName: string;
  leaderScore: number;
  /** This client's own score, FFA only. */
  selfScore: number;
}

export function makeBannerState(): BannerState {
  return {
    scoreA: 0,
    scoreB: 0,
    limit: 0,
    secondsRemaining: 0,
    round: 1,
    roundsToWin: 1,
    phaseSeconds: 0,
    phaseLabel: '',
    ffa: false,
    leaderName: '',
    leaderScore: 0,
    selfScore: 0,
  };
}

export class HudBanner {
  readonly element: HTMLElement;

  private readonly scoreA: HTMLElement;
  private readonly scoreB: HTMLElement;
  private readonly barA: HTMLElement;
  private readonly barB: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly rounds: HTMLElement;
  private readonly phase: HTMLElement;

  private lastA = -1;
  private lastB = -1;
  private lastFillA = -1;
  private lastFillB = -1;
  private lastClock = '';
  private lastRounds = '';
  private lastPhase = '';
  private phaseShown = false;

  /** FFA captions above each score. Empty and hidden in team modes. */
  private readonly labelA: HTMLElement;
  private readonly labelB: HTMLElement;
  private lastFfa = false;
  private lastLeadLabel = '';

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'hud-banner';

    const teamA = document.createElement('div');
    teamA.className = 'hud-banner__team hud-banner__team--friendly';
    this.scoreA = document.createElement('span');
    this.scoreA.className = 'hud-banner__score op-num';
    const trackA = document.createElement('div');
    trackA.className = 'hud-banner__track';
    this.barA = document.createElement('i');
    trackA.appendChild(this.barA);
    // The same two slots, relabelled, rather than a second banner: the layout, the bars, the
    // change-guards and the tabular numerals are all still exactly what is wanted.
    this.labelA = document.createElement('span');
    this.labelA.className = 'hud-banner__who op-label';
    this.labelA.hidden = true;
    teamA.append(this.labelA, this.scoreA, trackA);

    const centre = document.createElement('div');
    centre.className = 'hud-banner__centre';
    this.clock = document.createElement('span');
    this.clock.className = 'hud-banner__clock op-num';
    this.rounds = document.createElement('span');
    this.rounds.className = 'hud-banner__rounds op-label';
    centre.append(this.clock, this.rounds);

    const teamB = document.createElement('div');
    teamB.className = 'hud-banner__team hud-banner__team--hostile';
    this.scoreB = document.createElement('span');
    this.scoreB.className = 'hud-banner__score op-num';
    const trackB = document.createElement('div');
    trackB.className = 'hud-banner__track';
    this.barB = document.createElement('i');
    trackB.appendChild(this.barB);
    this.labelB = document.createElement('span');
    this.labelB.className = 'hud-banner__who op-label';
    this.labelB.hidden = true;
    teamB.append(this.labelB, this.scoreB, trackB);

    this.element.append(teamA, centre, teamB);

    // The warm-up / round-over line, centred over the crosshair rather than in the banner:
    // it is a state change, and a state change belongs where the player is already looking.
    this.phase = document.createElement('div');
    this.phase.className = 'hud-phase';
    this.phase.appendChild(document.createElement('span'));
  }

  /** The phase caption is a separate layer; the HUD mounts it over the centre of the screen. */
  get phaseElement(): HTMLElement {
    return this.phase;
  }

  update(state: BannerState): void {
    /**
     * In Free-for-All the two sides are **leader** and **you**, not team A and team B.
     *
     * The left slot is whoever is winning and the right is this client, so "am I close" is the
     * same glance it is in a team mode.
     */
    const left = state.ffa ? state.leaderScore : state.scoreA;
    const right = state.ffa ? state.selfScore : state.scoreB;

    if (state.ffa !== this.lastFfa) {
      this.lastFfa = state.ffa;
      this.element.classList.toggle('hud-banner--ffa', state.ffa);
    }
    const leadLabel = state.ffa ? state.leaderName || 'LEADER' : '';
    if (leadLabel !== this.lastLeadLabel) {
      this.lastLeadLabel = leadLabel;
      this.labelA.textContent = leadLabel;
      this.labelA.hidden = leadLabel === '';
      this.labelB.textContent = state.ffa ? 'YOU' : '';
      this.labelB.hidden = !state.ffa;
    }

    if (left !== this.lastA) {
      this.lastA = left;
      this.scoreA.textContent = String(left);
    }
    if (right !== this.lastB) {
      this.lastB = right;
      this.scoreB.textContent = String(right);
    }

    const limit = state.limit > 0 ? state.limit : 1;
    const fillA = Math.round(Math.min(1, left / limit) * 100) / 100;
    const fillB = Math.round(Math.min(1, right / limit) * 100) / 100;
    if (fillA !== this.lastFillA) {
      this.lastFillA = fillA;
      this.barA.style.transform = `scaleX(${fillA.toFixed(2)})`;
    }
    if (fillB !== this.lastFillB) {
      this.lastFillB = fillB;
      this.barB.style.transform = `scaleX(${fillB.toFixed(2)})`;
    }

    const clock = formatClock(state.secondsRemaining);
    if (clock !== this.lastClock) {
      this.lastClock = clock;
      this.clock.textContent = clock;
      // Under thirty seconds the clock goes to the accent colour. One threshold, not a ramp.
      this.clock.classList.toggle('hud-banner__clock--urgent', state.secondsRemaining <= 30);
    }

    // Only shown by a mode that has rounds, so TDM's banner is not carrying "ROUND 1 OF 1".
    const rounds = state.roundsToWin > 1 ? `ROUND ${state.round}` : '';
    if (rounds !== this.lastRounds) {
      this.lastRounds = rounds;
      this.rounds.textContent = rounds;
    }

    this.updatePhase(state);
  }

  reset(): void {
    this.lastA = -1;
    this.lastB = -1;
    this.lastFillA = -1;
    this.lastFillB = -1;
    this.lastClock = '';
    this.lastRounds = '';
    this.lastPhase = '';
    this.phaseShown = false;
    this.phase.classList.remove('hud-phase--on');
  }

  private updatePhase(state: BannerState): void {
    const show = state.phaseLabel !== '';
    if (show !== this.phaseShown) {
      this.phaseShown = show;
      this.phase.classList.toggle('hud-phase--on', show);
    }
    if (!show) return;
    const text =
      state.phaseSeconds > 0
        ? `${state.phaseLabel} · ${Math.ceil(state.phaseSeconds)}`
        : state.phaseLabel;
    if (text === this.lastPhase) return;
    this.lastPhase = text;
    const span = this.phase.firstElementChild;
    if (span instanceof HTMLElement) span.textContent = text;
  }
}

/** `M:SS`, floored, never negative. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}
