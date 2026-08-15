/**
 * The streak strip and the objective banner (M7, brief S6.3).
 *
 * Two widgets that share a corner and a lifetime:
 *
 * **The streak strip** — what you are holding, what you are working toward, and which key
 * spends it. Three slots because there are three keys; a fourth earned streak simply waits.
 * The next-streak line shows the *effective* requirement, which is already Hardline-discounted
 * by `StreakSystem`, so this file has never heard of a perk.
 *
 * **The objective banner** — the bomb timer, the plant/defuse ring, and the capture prompt.
 * It only appears when there is something to say, because a HUD element that is present and
 * empty is a HUD element the eye learns to ignore.
 *
 * Follows the same rule as the rest of the HUD: per-frame writes are `transform` and `opacity`
 * only, and text is written **only when the string changed**. That is what keeps a widget that
 * updates sixty times a second off the layout path — every `textContent` write is a reflow, and
 * a reflow inside the frame budget is the thing this whole HUD is written to avoid.
 */

export interface StreakSlotState {
  /** Empty string for an unused slot. */
  name: string;
  /** '3', '4' or '5'. */
  key: string;
  /**
   * Whether this slot's streak is earned and can be spent right now (M11 Gate B playtest).
   *
   * The slots used to hold whatever the player had *earned*, packed from index 0 — so the one
   * streak a player was holding always appeared on key 3, whichever key their class actually
   * bound it to, and pressing 5 for the Chopper Gunner they had just earned did nothing. The
   * slots are the **class's** three keys now, always in the same order, and this is what says
   * which of them is live. A named but unready slot is the useful half of that: it tells the
   * player what key 5 is *for* before they have earned it.
   */
  ready: boolean;
}

export interface StreakHudState {
  /** Up to three held streaks, in the order the keys spend them. */
  readonly slots: StreakSlotState[];
  /** Consecutive kills right now. */
  streak: number;
  /** What is next, and at how many kills. Empty name means everything is earned. */
  nextName: string;
  nextRequirement: number;

  // ---- objective banner --------------------------------------------------
  /** Headline, or empty to hide the banner entirely. */
  objectiveLabel: string;
  /** Seconds shown beside the label, or negative to omit. */
  objectiveSeconds: number;
  /** 0..1 interaction progress; drives the ring. Negative hides it. */
  interactFraction: number;
  interactLabel: string;
  /** True while the bomb is ticking: the banner goes red and the timer counts down. */
  urgent: boolean;

  // ---- alive counts (M7 playtest) ----------------------------------------
  /** Whether to show the per-side alive strip at all. One-life modes only. */
  showAlive: boolean;
  aliveFriendly: number;
  aliveEnemy: number;
}

export function makeStreakHudState(): StreakHudState {
  return {
    slots: [
      { name: '', key: '3', ready: false },
      { name: '', key: '4', ready: false },
      { name: '', key: '5', ready: false },
    ],
    streak: 0,
    nextName: '',
    nextRequirement: 0,
    objectiveLabel: '',
    objectiveSeconds: -1,
    interactFraction: -1,
    interactLabel: '',
    urgent: false,
    showAlive: false,
    aliveFriendly: 0,
    aliveEnemy: 0,
  };
}

export class HudStreaks {
  readonly element: HTMLElement;
  readonly bannerElement: HTMLElement;
  readonly aliveElement: HTMLElement;

  private readonly slotEls: HTMLElement[] = [];
  private readonly slotNameEls: HTMLElement[] = [];
  private readonly progressEl: HTMLElement;
  private readonly bannerLabel: HTMLElement;
  private readonly bannerTimer: HTMLElement;
  private readonly ringFill: HTMLElement;
  private readonly ringLabel: HTMLElement;
  private readonly ringWrap: HTMLElement;

  /** Last written strings, so nothing touches the DOM unless it actually changed. */
  private lastSlotNames = ['', '', ''];
  private lastProgress = '';
  private lastBanner = '';
  private lastTimer = '';
  private lastRingLabel = '';
  private lastRingShown = false;
  private lastBannerShown = false;
  private lastUrgent = false;
  private lastAlive = '';
  private lastAliveShown = false;

  constructor(host: HTMLElement) {
    this.element = document.createElement('div');
    this.element.className = 'hud-streaks';

    const slots = document.createElement('div');
    slots.className = 'hud-streaks__slots';
    for (let i = 0; i < 3; i++) {
      const slot = document.createElement('div');
      slot.className = 'hud-streaks__slot';
      const key = document.createElement('b');
      key.className = 'hud-streaks__key';
      key.textContent = String(3 + i);
      const name = document.createElement('span');
      name.className = 'hud-streaks__name';
      slot.append(key, name);
      slots.appendChild(slot);
      this.slotEls.push(slot);
      this.slotNameEls.push(name);
    }
    this.element.appendChild(slots);

    this.progressEl = document.createElement('div');
    this.progressEl.className = 'hud-streaks__progress';
    this.element.appendChild(this.progressEl);
    host.appendChild(this.element);

    // ---- the objective banner, centred above the crosshair ----
    this.bannerElement = document.createElement('div');
    this.bannerElement.className = 'hud-objective';
    this.bannerElement.style.opacity = '0';

    const head = document.createElement('div');
    head.className = 'hud-objective__head';
    this.bannerLabel = document.createElement('span');
    this.bannerLabel.className = 'hud-objective__label';
    this.bannerTimer = document.createElement('b');
    this.bannerTimer.className = 'hud-objective__timer';
    head.append(this.bannerLabel, this.bannerTimer);
    this.bannerElement.appendChild(head);

    this.ringWrap = document.createElement('div');
    this.ringWrap.className = 'hud-objective__ring';
    this.ringWrap.style.opacity = '0';
    this.ringFill = document.createElement('i');
    this.ringFill.className = 'hud-objective__ring-fill';
    this.ringLabel = document.createElement('span');
    this.ringLabel.className = 'hud-objective__ring-label';
    this.ringWrap.append(this.ringFill, this.ringLabel);
    this.bannerElement.appendChild(this.ringWrap);

    host.appendChild(this.bannerElement);

    /**
     * The alive strip: how many are still standing on each side.
     *
     * The single most important number in a one-life mode — a 3-v-1 and a 1-v-3 are completely
     * different rounds and nothing else on screen tells you which one you are in. Sits directly
     * under the score banner, centred, and is hidden entirely in modes where everybody
     * respawns and the count would be meaningless.
     */
    this.aliveElement = document.createElement('div');
    this.aliveElement.className = 'hud-alive';
    this.aliveElement.style.opacity = '0';
    const friendly = document.createElement('b');
    friendly.className = 'hud-alive__count hud-alive__count--friendly';
    const sep = document.createElement('span');
    sep.className = 'hud-alive__sep';
    sep.textContent = 'ALIVE';
    const enemy = document.createElement('b');
    enemy.className = 'hud-alive__count hud-alive__count--enemy';
    this.aliveElement.append(friendly, sep, enemy);
    this.aliveFriendlyEl = friendly;
    this.aliveEnemyEl = enemy;
    host.appendChild(this.aliveElement);
  }

  private readonly aliveFriendlyEl: HTMLElement;
  private readonly aliveEnemyEl: HTMLElement;

  update(state: StreakHudState): void {
    if (state.showAlive !== this.lastAliveShown) {
      this.lastAliveShown = state.showAlive;
      this.aliveElement.style.opacity = state.showAlive ? '1' : '0';
    }
    if (state.showAlive) {
      const key = `${state.aliveFriendly}/${state.aliveEnemy}`;
      if (key !== this.lastAlive) {
        this.lastAlive = key;
        this.aliveFriendlyEl.textContent = String(state.aliveFriendly);
        this.aliveEnemyEl.textContent = String(state.aliveEnemy);
      }
    }

    for (let i = 0; i < this.slotEls.length; i++) {
      const entry = state.slots[i];
      const name = entry?.name ?? '';
      const ready = entry?.ready === true;
      // The cache key carries both facts, so a slot that becomes spendable without changing
      // its name still repaints. Two guards would have needed two caches.
      const stamp = ready ? `+${name}` : name;
      if (stamp !== this.lastSlotNames[i]) {
        this.lastSlotNames[i] = stamp;
        const el = this.slotNameEls[i];
        const slot = this.slotEls[i];
        if (el !== undefined) el.textContent = name;
        if (slot !== undefined) {
          slot.classList.toggle('is-ready', ready);
          slot.classList.toggle('is-owned', name.length > 0);
        }
      }
    }

    const progress =
      state.nextName.length === 0
        ? ''
        : `${state.streak} / ${state.nextRequirement} · ${state.nextName}`;
    if (progress !== this.lastProgress) {
      this.lastProgress = progress;
      this.progressEl.textContent = progress;
      this.progressEl.style.opacity = progress.length > 0 ? '1' : '0';
    }

    this.updateBanner(state);
  }

  private updateBanner(state: StreakHudState): void {
    const shown = state.objectiveLabel.length > 0;
    if (shown !== this.lastBannerShown) {
      this.lastBannerShown = shown;
      this.bannerElement.style.opacity = shown ? '1' : '0';
    }
    if (!shown) return;

    if (state.objectiveLabel !== this.lastBanner) {
      this.lastBanner = state.objectiveLabel;
      this.bannerLabel.textContent = state.objectiveLabel;
    }
    // Whole seconds only: a timer flickering through tenths is unreadable and reflows
    // sixty times a second for no information.
    const timer = state.objectiveSeconds < 0 ? '' : String(Math.ceil(state.objectiveSeconds));
    if (timer !== this.lastTimer) {
      this.lastTimer = timer;
      this.bannerTimer.textContent = timer;
    }
    if (state.urgent !== this.lastUrgent) {
      this.lastUrgent = state.urgent;
      this.bannerElement.classList.toggle('is-urgent', state.urgent);
    }

    const ringShown = state.interactFraction >= 0;
    if (ringShown !== this.lastRingShown) {
      this.lastRingShown = ringShown;
      this.ringWrap.style.opacity = ringShown ? '1' : '0';
    }
    if (!ringShown) return;
    // `transform` only — a width change would reflow, a scale composites.
    this.ringFill.style.transform = `scaleX(${Math.max(0, Math.min(1, state.interactFraction)).toFixed(3)})`;
    if (state.interactLabel !== this.lastRingLabel) {
      this.lastRingLabel = state.interactLabel;
      this.ringLabel.textContent = state.interactLabel;
    }
  }

  dispose(): void {
    this.element.remove();
    this.bannerElement.remove();
    this.aliveElement.remove();
  }
}
