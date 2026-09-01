/**
 * A chevron on a ring around the crosshair, pointing at something in the world.
 *
 * ## Why this is one component and not two (playtest round 4, F2)
 *
 * The HUD already had this shape once, for the live-grenade warning: take a world position and
 * the player's own position and yaw, subtract, rotate an element. F2 asks for a second one —
 * *"a marker arrow pointing at the bomb to pick up"* — and two copies of a bearing calculation
 * is two chances for them to disagree about which way is positive. `showHitDirection` is the
 * *transient* member of the same family (a chevron that fades over 1.1 s and is gone); this is
 * the persistent member, shown for as long as a condition holds, and the bomb needs that one.
 *
 * So the arithmetic lives here and the two callers differ only in a CSS class and in what they
 * are pointing at. The sign convention is `showHitDirection`'s, unchanged: positive is to the
 * right of the crosshair.
 *
 * ## What it costs
 *
 * One element, `pointer-events: none`, `opacity` and `rotate` only, both change-guarded — the
 * angle to a whole degree, which is about 2 px of arc at the ring's radius and below what
 * anybody can see. A bomb that is not moving writes nothing at all after the first frame.
 */
export class BearingIndicator {
  readonly element: HTMLElement;

  private shown = false;
  private lastAngleDeg = 9999;

  /** `modifier` is appended to the base class, so a caller can style its own arrow. */
  constructor(modifier: string) {
    this.element = document.createElement('div');
    this.element.className = `hud-bearing hud-bearing--${modifier}`;
    this.element.appendChild(document.createElement('i'));
    this.element.style.opacity = '0';
  }

  /**
   * Point at `(targetX, targetZ)`, or go away.
   *
   * `active` is passed rather than inferred from the coordinates because "no target" and "a
   * target at the origin" are different facts and the origin is inside every one of these maps.
   */
  update(
    active: boolean,
    targetX: number,
    targetZ: number,
    playerX: number,
    playerZ: number,
    playerYaw: number,
  ): void {
    if (active !== this.shown) {
      this.shown = active;
      this.element.style.opacity = active ? '1' : '0';
    }
    if (!active) return;

    // World bearing to the target, minus where the player is looking. Positive is to the
    // right of the crosshair, which is the convention `Hud.showHitDirection` uses.
    const worldAngle = Math.atan2(targetX - playerX, -(targetZ - playerZ));
    const deg = Math.round(((worldAngle - playerYaw) * 180) / Math.PI);
    if (deg === this.lastAngleDeg) return;
    this.lastAngleDeg = deg;
    this.element.style.transform = `rotate(${deg}deg)`;
  }

  /** Teardown between matches: the arrow must not survive the thing it was pointing at. */
  reset(): void {
    this.shown = false;
    this.lastAngleDeg = 9999;
    this.element.style.opacity = '0';
  }
}
