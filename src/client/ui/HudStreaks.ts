/**
 * The streak strip and the objective banner (M7, brief S6.3).
 *
 * Two widgets that share a corner and a lifetime:
 *
 * **The streak strip** — what your three keys cost, which of them you can pay for, and how much
 * of a locked key's wait is left. Three slots because there are three keys. Every price shown is
 * the *effective* one, already Hardline-discounted by `StreakSystem`, so this file has never
 * heard of a perk; and the progress line counts the **balance** toward the cheapest thing still
 * out of reach, which after round 4's B9 goes back up when you buy something.
 *
 * **The cooldown is drawn and never written.** Round 4's pivot replaced "used this life" with a
 * lockout that has a length, and the brief that asked for it asked for it *visually*: a fill,
 * not a number, and nothing counting seconds. So a slot carries a bar whose height is the
 * fraction of the lockout still to run, and says nothing at all — which is also the cheaper
 * shape, because a transform composites and a digit changing once a second is a reflow a second
 * for as long as the wait lasts. The remaining time is still a number in state and on the wire;
 * this is the one place it stops being one.
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

import { STREAK_COOLDOWN_SECONDS } from '../../shared/streaks/StreakDefs';

export interface StreakSlotState {
  /** Empty string for an unused slot. */
  name: string;
  /** '3', '4' or '5'. */
  key: string;
  /**
   * Whether this slot's streak can be bought right now (M11 Gate B playtest).
   *
   * The slots used to hold whatever the player had *earned*, packed from index 0 — so the one
   * streak a player was holding always appeared on key 3, whichever key their class actually
   * bound it to, and pressing 5 for the Chopper Gunner they had just earned did nothing. The
   * slots are the **class's** three keys now, always in the same order, and this is what says
   * which of them is live. A named but unready slot is the useful half of that: it tells the
   * player what key 5 is *for* before they can pay for it.
   */
  ready: boolean;
  /**
   * What it costs, in kills (round 4, B9).
   *
   * On screen because a player cannot plan a purchase whose price they cannot see, and because
   * it is the reason a key does nothing: an unaffordable slot showing "8" says what is
   * missing, where a dark slot says only that something is.
   */
  price: number;
  /**
   * Seconds until the key works again; 0 means now (round 4, the pivot).
   *
   * The server's number, drawn as a fill and never printed. It covers the cooldown and a
   * previous instance of the same streak still being in the world, which are one event to a
   * player: nothing happens when they press the key, and the bar says how much longer that will
   * be true for.
   */
  lockoutSeconds: number;
}

export interface StreakHudState {
  /** The class's three streaks, in the order the keys spend them. */
  readonly slots: StreakSlotState[];
  /** Kills banked and not yet spent. Was the consecutive-kill count (round 4, B9). */
  balance: number;
  /** What is next, and what it costs. Empty name means everything is affordable or spent. */
  nextName: string;
  nextPrice: number;

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
      { name: '', key: '3', ready: false, price: 0, lockoutSeconds: 0 },
      { name: '', key: '4', ready: false, price: 0, lockoutSeconds: 0 },
      { name: '', key: '5', ready: false, price: 0, lockoutSeconds: 0 },
    ],
    balance: 0,
    nextName: '',
    nextPrice: 0,
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
  private readonly slotCostEls: HTMLElement[] = [];
  private readonly slotCoolEls: HTMLElement[] = [];
  private readonly progressEl: HTMLElement;
  private readonly bannerLabel: HTMLElement;
  private readonly bannerTimer: HTMLElement;
  private readonly ringFill: HTMLElement;
  private readonly ringLabel: HTMLElement;
  private readonly ringWrap: HTMLElement;

  /** Last written strings, so nothing touches the DOM unless it actually changed. */
  private lastSlotNames = ['', '', ''];
  /** Whether each slot was drawing a lockout last frame. The fill's transform is not cached. */
  private lastSlotCooling = [false, false, false];
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
      // The price, always and only. `USED` used to share this element; the lockout that
      // replaced it is drawn rather than written, so the cost has one job again.
      const cost = document.createElement('i');
      cost.className = 'hud-streaks__cost';
      // The lockout, as a fill that drains. Scaled on a transform from the bottom, so the frame
      // that draws it never touches layout.
      const cool = document.createElement('u');
      cool.className = 'hud-streaks__cool';
      cool.style.transform = 'scaleY(0)';
      slot.append(cool, key, name, cost);
      slots.appendChild(slot);
      this.slotEls.push(slot);
      this.slotNameEls.push(name);
      this.slotCostEls.push(cost);
      this.slotCoolEls.push(cool);
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
      const lockout = entry?.lockoutSeconds ?? 0;
      const cooling = name.length > 0 && lockout > 0;
      const cost = name.length === 0 ? '' : String(entry?.price ?? 0);
      // The cache key carries every fact the slot *writes*, so a slot that becomes affordable —
      // or stops being — without changing its name still repaints. One stamp rather than three
      // guards, because three guards would need three caches. The lockout is deliberately not in
      // it: it is drawn on a transform, and a transform is not a write worth guarding.
      const stamp = `${ready ? '+' : '-'}${cost}|${name}`;
      if (stamp !== this.lastSlotNames[i]) {
        this.lastSlotNames[i] = stamp;
        const el = this.slotNameEls[i];
        const costEl = this.slotCostEls[i];
        const slot = this.slotEls[i];
        if (el !== undefined) el.textContent = name;
        if (costEl !== undefined) costEl.textContent = cost;
        if (slot !== undefined) {
          slot.classList.toggle('is-ready', ready);
          slot.classList.toggle('is-owned', name.length > 0);
        }
      }
      if (cooling !== this.lastSlotCooling[i]) {
        this.lastSlotCooling[i] = cooling;
        this.slotEls[i]?.classList.toggle('is-cooling', cooling);
      }
      const coolEl = this.slotCoolEls[i];
      if (coolEl !== undefined) {
        // Clamped at 1 rather than scaled against the whole lockout, so a streak still in the
        // sky and one whose cooldown has just started read the same: full, then draining over
        // the last STREAK_COOLDOWN_SECONDS. The alternative — a fraction of a total that is 120 s
        // for a sentry and 30 s for a mortar — makes the same wait look different on two keys,
        // for a reason the player has no way to see.
        const fill = cooling ? Math.min(1, lockout / STREAK_COOLDOWN_SECONDS) : 0;
        coolEl.style.transform = `scaleY(${fill.toFixed(3)})`;
      }
    }

    const progress =
      state.nextName.length === 0
        ? ''
        : `${state.balance} / ${state.nextPrice} · ${state.nextName}`;
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
