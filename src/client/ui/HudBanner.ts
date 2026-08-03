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
    teamA.append(this.scoreA, trackA);

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
    teamB.append(this.scoreB, trackB);

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
    if (state.scoreA !== this.lastA) {
      this.lastA = state.scoreA;
      this.scoreA.textContent = String(state.scoreA);
    }
    if (state.scoreB !== this.lastB) {
      this.lastB = state.scoreB;
      this.scoreB.textContent = String(state.scoreB);
    }

    const limit = state.limit > 0 ? state.limit : 1;
    const fillA = Math.round(Math.min(1, state.scoreA / limit) * 100) / 100;
    const fillB = Math.round(Math.min(1, state.scoreB / limit) * 100) / 100;
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
