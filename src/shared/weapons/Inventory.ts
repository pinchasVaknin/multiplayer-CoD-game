import { EV, type GameBus } from '../core/Events';
import { DT } from '../core/Loop';
import { Weapon, type WeaponInput } from './WeaponBase';
import type { WeaponDef, WeaponSlot } from './WeaponDefs';

/**
 * Primary and secondary, and the swap between them (brief S6.4).
 *
 * The swap reuses `Weapon.raise` rather than adding a parallel animation state, because
 * `raise` is already the single authority for whether the weapon can fire and the
 * viewmodel already poses against it. A swap is therefore three facts:
 *
 *   1. the outgoing weapon is told to lower, over `swapOutTime`;
 *   2. at zero, the active slot changes and the incoming weapon starts at `raise = 0`;
 *   3. the incoming weapon rises over `swapInTime`.
 *
 * There is no window where the state machine says "ready" and the animation disagrees, and
 * `canFire` needs no new clause — a weapon half-way out of the holster is a weapon at
 * `raise < 1`, which already cannot fire.
 *
 * **A swap cancels a reload** (S6.4), and it cancels it the honest way: the ammo only lands
 * on completion, so an interrupted reload leaves the magazine exactly as it was.
 */

export type SwapPhase = 'READY' | 'PUT_AWAY' | 'TAKE_OUT';

const evSwap = { fromId: '', toId: '', sourceId: 0, slot: 'primary' as WeaponSlot };

export class Inventory {
  /** Index 0 is the primary, 1 the secondary. Fixed length for the whole match. */
  private readonly weapons: Weapon[] = [];
  private activeIndex = 0;
  private pendingIndex = 0;

  phase: SwapPhase = 'READY';
  private timer = 0;

  constructor(
    primary: WeaponDef,
    secondary: WeaponDef | null,
    private readonly bus: GameBus,
    readonly sourceId: number,
  ) {
    this.weapons.push(new Weapon(primary, bus, sourceId));
    if (secondary !== null) this.weapons.push(new Weapon(secondary, bus, sourceId));
  }

  get active(): Weapon {
    const weapon = this.weapons[this.activeIndex];
    if (weapon === undefined) throw new Error('Inventory has no active weapon');
    return weapon;
  }

  get activeSlotIndex(): number {
    return this.activeIndex;
  }

  get slotCount(): number {
    return this.weapons.length;
  }

  get swapping(): boolean {
    return this.phase !== 'READY';
  }

  /** The weapon in a slot, for the HUD and the debug panel. */
  at(index: number): Weapon | undefined {
    return this.weapons[index];
  }

  /** Every slot. The MUNITIONS field upgrade resupplies all of them, not just the one held. */
  get all(): readonly Weapon[] {
    return this.weapons;
  }

  /**
   * Replace what is in a slot. Used by the loadout picker and by the live retune path;
   * ammo is reset because it is a different gun, not the same gun with different numbers.
   */
  setSlot(index: number, def: WeaponDef): void {
    const existing = this.weapons[index];
    if (existing === undefined) {
      if (index !== this.weapons.length) return;
      this.weapons.push(new Weapon(def, this.bus, this.sourceId));
      return;
    }
    existing.setDefinition(def);
    existing.resetAmmo();
  }

  /** Live retune: same weapon, new numbers, ammo preserved and clamped. */
  retuneSlot(index: number, def: WeaponDef): void {
    this.weapons[index]?.setDefinition(def);
  }

  /**
   * Ask for a swap. Ignored while one is already under way or when the slot is already
   * active, so mashing the key does not queue three of them.
   */
  requestSwap(index: number): boolean {
    if (this.phase !== 'READY') return false;
    if (index === this.activeIndex) return false;
    const target = this.weapons[index];
    if (target === undefined) return false;

    const from = this.active;
    from.cancelReload();
    from.handlingSeconds = Math.max(from.definition.swapOutTime, 1e-3);
    this.pendingIndex = index;
    this.phase = 'PUT_AWAY';
    this.timer = from.definition.swapOutTime;
    return true;
  }

  /** Toggle between primary and secondary — the one key a player actually presses. */
  requestToggle(): boolean {
    if (this.weapons.length < 2) return false;
    return this.requestSwap(this.activeIndex === 0 ? 1 : 0);
  }

  /**
   * One sim tick of the swap machine, run *before* the active weapon steps.
   *
   * Returns whether the active weapon must be forced to stay lowered this tick, which the
   * caller folds into the weapon input alongside sprinting and sliding.
   */
  step(): boolean {
    switch (this.phase) {
      case 'READY':
        return false;

      case 'PUT_AWAY': {
        this.timer -= DT;
        if (this.timer > 0) return true;
        const from = this.active;
        from.handlingSeconds = 0;
        from.raise = 0;

        this.activeIndex = this.pendingIndex;
        const to = this.active;
        to.raise = 0;
        to.cancelReload();
        to.handlingSeconds = Math.max(to.definition.swapInTime, 1e-3);
        this.phase = 'TAKE_OUT';
        this.timer = to.definition.swapInTime;

        evSwap.fromId = from.definition.id;
        evSwap.toId = to.definition.id;
        evSwap.sourceId = this.sourceId;
        evSwap.slot = to.definition.slot;
        this.bus.emit(EV.WeaponSwapped, evSwap);
        return false;
      }

      case 'TAKE_OUT': {
        this.timer -= DT;
        if (this.timer > 0) return false;
        this.active.handlingSeconds = 0;
        this.phase = 'READY';
        this.timer = 0;
        return false;
      }
    }
  }

  /** Every weapon takes a tick, so a holstered magazine is not frozen in time. */
  stepIdle(active: Weapon, idleInput: WeaponInput): void {
    for (const weapon of this.weapons) {
      if (weapon === active) continue;
      weapon.stepHolstered(idleInput);
    }
  }

  /**
   * Back to slot 0, full magazines, sights down (S6.9's respawn).
   *
   * **This is a hard reset and it has to be one.** Post-M8 playtesting found that dying with
   * the pistol out respawned you with the pistol on screen but the rifle's ballistics behind
   * it. The logic half was always correct — `activeIndex` goes to 0 here — and the *mesh* was
   * the half that lagged, because `Match` only ever changes the visible model on a
   * `weapon.swapped` event and a reset does not swap, it resets. The fix is on the other side
   * of the seam (`Match.respawnPlayer` re-shows the slot), and it works because this method
   * is unambiguous about which slot is live afterwards.
   *
   * `clearAds` is here rather than only on death so a life can never start part-way into the
   * sights, whatever the previous one ended holding.
   */
  reset(): void {
    this.phase = 'READY';
    this.timer = 0;
    this.activeIndex = 0;
    this.pendingIndex = 0;
    for (const weapon of this.weapons) {
      weapon.handlingSeconds = 0;
      weapon.raise = weapon === this.active ? 1 : 0;
      weapon.clearAds();
      weapon.resetAmmo();
    }
  }

  /** Seconds remaining in the current swap phase, for the debug read-out. */
  get swapRemaining(): number {
    return Math.max(0, this.timer);
  }
}
