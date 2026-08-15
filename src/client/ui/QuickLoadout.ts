import type { LoadoutSlot } from '../../shared/meta/Loadouts';

/**
 * The quick class selector: five classes, five keys, no menu (M11 Gate B).
 *
 * ## Why this exists beside a perfectly good loadout editor
 *
 * Create-a-Class is where you *build* a class. This is where you *pick* one, and the two happen
 * at completely different moments: building is a considered thing done between matches, picking
 * is a five-second decision made when you have just seen the map, or just been killed by a
 * sniper and want a rifle. Sending the player to a full-screen editor for the second one costs
 * them the thing they were reacting to.
 *
 * So it is a HUD panel rather than a screen: it draws down the side, it never takes the pointer,
 * and it is bound to the digit keys that are already under the player's left hand.
 *
 * ## The two windows it appears in, and why only those two
 *
 * A class change takes effect on the **next spawn** — that is §6.6's rule and the server's
 * (`ServerMatch.setPendingLoadout`), and it exists because applying one to a standing body is
 * how Tier 1 #20's divergence came back. Both of these windows are moments when the player is
 * *about* to spawn or is frozen in place, so "next spawn" is either immediate or seconds away:
 *
 *  - the pre-match freeze, which is ten seconds long for exactly this reason;
 *  - the respawn wait, where they are dead and the timer is running.
 *
 * It is deliberately **not** available while alive and playing. There the answer is the pause
 * screen's Create-a-Class, and the change lands when they next die — which is CoD's rule, and
 * not something a HUD panel should be quietly implying otherwise about.
 *
 * ## Cost
 *
 * Five rows built once and only ever relabelled. `update` early-outs on an unchanged
 * (visible, selected, count) triple, so a panel that is up for ten seconds does DOM work on the
 * frames the player actually presses something and on no others.
 */

export interface QuickLoadoutDeps {
  readonly host: HTMLElement;
  /** The five classes, in key order. Read on every `show`, so a rename is picked up. */
  readonly slots: () => readonly LoadoutSlot[];
  /** Which one is equipped right now. */
  readonly equipped: () => number;
  /** The player pressed a key. Zero-based. */
  readonly onPick: (index: number) => void;
}

/** Keys 1-5. Five is what `LOADOUT_SLOT_COUNT` authors and what a hand reaches without moving. */
const MAX_ROWS = 5;

export class QuickLoadout {
  readonly element: HTMLElement;

  private readonly deps: QuickLoadoutDeps;
  private readonly rows: HTMLElement[] = [];
  private readonly names: HTMLElement[] = [];
  private readonly title: HTMLElement;

  private shown = false;
  private lastSelected = -1;
  private lastLabel = '';
  private lastNames = '';

  constructor(deps: QuickLoadoutDeps) {
    this.deps = deps;

    this.element = document.createElement('div');
    this.element.className = 'ql';
    this.element.hidden = true;

    this.title = document.createElement('div');
    this.title.className = 'ql__title op-label';
    this.element.appendChild(this.title);

    const list = document.createElement('div');
    list.className = 'ql__rows';
    for (let i = 0; i < MAX_ROWS; i++) {
      const row = document.createElement('div');
      row.className = 'ql__row';

      const key = document.createElement('span');
      key.className = 'ql__key op-num';
      key.textContent = String(i + 1);

      const name = document.createElement('span');
      name.className = 'ql__name';

      row.append(key, name);
      list.appendChild(row);
      this.rows.push(row);
      this.names.push(name);
    }
    this.element.appendChild(list);
    deps.host.appendChild(this.element);
  }

  get isOpen(): boolean {
    return this.shown;
  }

  /**
   * Put the panel up with a caption saying which window this is.
   *
   * The caption is not decoration: "SELECT CLASS" during the pre-match freeze and "SELECT NEXT
   * CLASS" while dead are different promises, and a player who reads the second one knows the
   * rifle arrives with their next body rather than now.
   */
  show(label: string): void {
    this.shown = true;
    this.element.hidden = false;
    if (label !== this.lastLabel) {
      this.lastLabel = label;
      this.title.textContent = label;
    }
    this.paint();
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.element.hidden = true;
  }

  /**
   * A digit arrived. Returns whether this panel consumed it.
   *
   * The same contract the vote overlay uses, and for the same reason: 1 and 2 swap weapons and
   * 3-5 spend killstreaks, so a panel that did not report having eaten the key would pick a
   * class *and* pull out a pistol. Answering false whenever it is closed is what leaves every
   * other moment of the game exactly as it was.
   */
  handleDigit(digit: number): boolean {
    if (!this.shown) return false;
    const index = digit - 1;
    if (index < 0 || index >= Math.min(MAX_ROWS, this.deps.slots().length)) return false;
    this.deps.onPick(index);
    this.paint();
    return true;
  }

  /** Per frame while open. Cheap: it repaints only when something it draws has changed. */
  update(): void {
    if (!this.shown) return;
    this.paint();
  }

  dispose(): void {
    this.element.remove();
  }

  private paint(): void {
    const slots = this.deps.slots();
    const selected = this.deps.equipped();
    // One string rather than five comparisons: renames are rare and this runs per frame.
    let stamp = '';
    for (let i = 0; i < MAX_ROWS; i++) stamp += `${slots[i]?.name ?? ''}|`;
    if (stamp === this.lastNames && selected === this.lastSelected) return;
    this.lastNames = stamp;
    this.lastSelected = selected;

    for (let i = 0; i < MAX_ROWS; i++) {
      const row = this.rows[i];
      const name = this.names[i];
      if (row === undefined || name === undefined) continue;
      const slot = slots[i];
      row.hidden = slot === undefined;
      if (slot === undefined) continue;
      name.textContent = slot.name;
      row.classList.toggle('is-selected', i === selected);
    }
  }
}
