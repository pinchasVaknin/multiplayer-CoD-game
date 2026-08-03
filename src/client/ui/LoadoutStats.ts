import type { WeaponDef } from '../../shared/weapons/WeaponDefs';

/**
 * The loadout editor's stat read-out (brief S6.3).
 *
 * S6.3 is emphatic: *"The editor must show **real numbers** — the resolved `WeaponDef`
 * after attachments, using the same pure function the gameplay uses. Never a hand-written
 * marketing bar chart that can drift from the actual values."*
 *
 * So this component computes nothing. It is handed two `WeaponDef`s — the base out of the
 * registry and the one `resolveLoadout` produced, which is byte-for-byte the object the
 * `WeaponSystem` will be constructed with — and prints fields off them. The only judgement
 * it makes is *formatting*, and the only thing it decides is whether a row changed.
 *
 * Rows that did not change are drawn plainly; rows that did are drawn as `base -> resolved`
 * with the direction coloured by whether the change helps. "Helps" is a per-row property
 * because half these numbers are better smaller — ADS time, spread, recoil — and a green
 * arrow on a rising reload time would be worse than no colour at all.
 */

interface StatRow {
  readonly label: string;
  readonly read: (def: WeaponDef) => number;
  readonly unit: string;
  readonly digits: number;
  /** True when a *larger* value is better for the player. */
  readonly higherIsBetter: boolean;
  /** Scale applied before formatting, e.g. seconds to milliseconds. */
  readonly scale?: number;
}

const ROWS: readonly StatRow[] = [
  { label: 'Damage near', read: (d) => d.damage.near, unit: '', digits: 0, higherIsBetter: true },
  { label: 'Damage far', read: (d) => d.damage.far, unit: '', digits: 0, higherIsBetter: true },
  { label: 'Headshot', read: (d) => d.headshotMult, unit: 'x', digits: 2, higherIsBetter: true },
  {
    label: 'Falloff start',
    read: (d) => d.damageFalloff.start,
    unit: ' m',
    digits: 1,
    higherIsBetter: true,
  },
  {
    label: 'Falloff end',
    read: (d) => d.damageFalloff.end,
    unit: ' m',
    digits: 1,
    higherIsBetter: true,
  },
  { label: 'Rate of fire', read: (d) => d.rpm, unit: ' rpm', digits: 0, higherIsBetter: true },
  { label: 'Magazine', read: (d) => d.magSize, unit: '', digits: 0, higherIsBetter: true },
  { label: 'Reserve', read: (d) => d.reserveAmmo, unit: '', digits: 0, higherIsBetter: true },
  {
    label: 'Reload',
    read: (d) => d.reloadTime,
    unit: ' ms',
    digits: 0,
    higherIsBetter: false,
    scale: 1000,
  },
  {
    label: 'Reload empty',
    read: (d) => d.reloadEmptyTime,
    unit: ' ms',
    digits: 0,
    higherIsBetter: false,
    scale: 1000,
  },
  {
    label: 'ADS time',
    read: (d) => d.adsTime,
    unit: ' ms',
    digits: 0,
    higherIsBetter: false,
    scale: 1000,
  },
  {
    label: 'Sprint to fire',
    read: (d) => d.sprintOutTime,
    unit: ' ms',
    digits: 0,
    higherIsBetter: false,
    scale: 1000,
  },
  {
    label: 'Swap in',
    read: (d) => d.swapInTime,
    unit: ' ms',
    digits: 0,
    higherIsBetter: false,
    scale: 1000,
  },
  {
    label: 'Hip spread',
    read: (d) => d.spread.hipStand,
    unit: '°',
    digits: 3,
    higherIsBetter: false,
  },
  {
    label: 'Moving spread',
    read: (d) => d.spread.hipMove,
    unit: '°',
    digits: 3,
    higherIsBetter: false,
  },
  { label: 'Aimed spread', read: (d) => d.spread.ads, unit: '°', digits: 3, higherIsBetter: false },
  {
    label: 'Recoil vertical',
    read: (d) => d.recoil.verticalScale,
    unit: 'x',
    digits: 2,
    higherIsBetter: false,
  },
  {
    label: 'Recoil lateral',
    read: (d) => d.recoil.horizontalScale,
    unit: 'x',
    digits: 2,
    higherIsBetter: false,
  },
  { label: 'Penetration', read: (d) => d.penetration, unit: ' m', digits: 2, higherIsBetter: true },
  { label: 'Pellets', read: (d) => d.pellets, unit: '', digits: 0, higherIsBetter: true },
];

/** How close two values have to be to count as unchanged. Guards float noise. */
const EPSILON = 1e-6;

export class LoadoutStats {
  readonly element: HTMLElement;

  private readonly body: HTMLElement;
  private readonly title: HTMLElement;
  private readonly subtitle: HTMLElement;

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'lo-stats';

    this.title = document.createElement('div');
    this.title.className = 'lo-stats__title';
    this.subtitle = document.createElement('div');
    this.subtitle.className = 'op-label';
    this.body = document.createElement('div');
    this.body.className = 'lo-stats__body';

    this.element.append(this.title, this.subtitle, this.body);
  }

  /**
   * Repaint against a base and its resolved counterpart.
   *
   * `note` is the one line of prose in the panel and it names what is doing the changing —
   * the attachments and perks fitted — so a moved number is attributable without the
   * player having to remember what they just clicked.
   */
  show(base: WeaponDef, resolved: WeaponDef, note: string): void {
    this.title.textContent = resolved.name;
    this.subtitle.textContent = note;
    this.body.replaceChildren();

    let changed = 0;
    for (const row of ROWS) {
      const scale = row.scale ?? 1;
      const baseValue = row.read(base) * scale;
      const resolvedValue = row.read(resolved) * scale;
      const moved = Math.abs(baseValue - resolvedValue) > EPSILON;
      if (moved) changed++;
      this.body.appendChild(this.makeRow(row, baseValue, resolvedValue, moved));
    }

    const footer = document.createElement('div');
    footer.className = 'lo-stats__footer op-label';
    footer.textContent =
      changed === 0
        ? 'No modifiers fitted — these are the base values'
        : `${changed} value${changed === 1 ? '' : 's'} changed by attachments and perks`;
    this.body.appendChild(footer);
  }

  private makeRow(row: StatRow, baseValue: number, resolvedValue: number, moved: boolean): HTMLElement {
    const el = document.createElement('div');
    el.className = 'lo-stat';
    el.classList.toggle('is-changed', moved);

    const label = document.createElement('span');
    label.className = 'lo-stat__label';
    label.textContent = row.label;

    const value = document.createElement('span');
    value.className = 'lo-stat__value op-num';

    if (!moved) {
      value.textContent = format(resolvedValue, row.digits, row.unit);
    } else {
      const from = document.createElement('span');
      from.className = 'lo-stat__from';
      from.textContent = format(baseValue, row.digits, row.unit);
      const arrow = document.createElement('span');
      arrow.className = 'lo-stat__arrow';
      arrow.textContent = '→';
      const to = document.createElement('span');
      const better = resolvedValue > baseValue === row.higherIsBetter;
      to.className = `lo-stat__to ${better ? 'is-better' : 'is-worse'}`;
      to.textContent = format(resolvedValue, row.digits, row.unit);
      value.append(from, arrow, to);
    }

    el.append(label, value);
    return el;
  }
}

function format(value: number, digits: number, unit: string): string {
  return `${value.toFixed(digits)}${unit}`;
}
