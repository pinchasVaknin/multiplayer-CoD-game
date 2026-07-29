import type { TunableMeta } from '../player/MovementConfig';

/**
 * Live tuning sliders for every constant in a config object (brief S6).
 *
 * The slider set is generated from the config's metadata table, so it cannot drift out
 * of sync with the config: adding a field without metadata is a compile error at the
 * table, and the panel picks the new field up for free.
 *
 * COPY writes the tuned values back out as TypeScript source, ready to paste over the
 * defaults. Tuning that cannot be committed is tuning that gets lost.
 */

export interface TuningGroup {
  readonly title: string;
  readonly keys: readonly string[];
  meta(key: string): TunableMeta;
  read(key: string): number;
  write(key: string, value: number): void;
  toSource(): string;
  resetToDefaults(): void;
}

export function makeTuningGroup<T extends Record<keyof T, number>>(
  title: string,
  config: T,
  meta: Readonly<Record<keyof T, TunableMeta>>,
  keys: ReadonlyArray<keyof T>,
  defaults: Readonly<T>,
  toSource: (cfg: T) => string,
): TuningGroup {
  const stringKeys = keys.map((k) => String(k));
  const lookup = (key: string): keyof T => key as keyof T;
  return {
    title,
    keys: stringKeys,
    meta: (key) => meta[lookup(key)],
    read: (key) => config[lookup(key)],
    write: (key, value) => {
      config[lookup(key)] = value as T[keyof T];
    },
    toSource: () => toSource(config),
    resetToDefaults: () => {
      for (const k of keys) config[k] = defaults[k];
    },
  };
}

/**
 * A tuning group over a nested config, addressed by dotted keys.
 *
 * `makeTuningGroup` above only works on a flat `Record<K, number>`; a `WeaponDef` is not
 * flat, and flattening the schema to suit the debug panel would be the tail wagging the
 * dog. The accessors stay compile-checked at their own definition site instead — see
 * `WEAPON_TUNABLES` and the exhaustive switches next to it.
 */
export function makeAccessorGroup(
  title: string,
  keys: readonly string[],
  meta: (key: string) => TunableMeta,
  read: (key: string) => number,
  write: (key: string, value: number) => void,
  toSource: () => string,
  resetToDefaults: () => void,
): TuningGroup {
  return { title, keys, meta, read, write, toSource, resetToDefaults };
}

interface SliderRow {
  key: string;
  input: HTMLInputElement;
  readout: HTMLElement;
}

export class TuningPanel {
  readonly element: HTMLElement;
  private readonly rows: SliderRow[] = [];
  private readonly group: TuningGroup;
  private readonly onChange: () => void;

  constructor(group: TuningGroup, onChange: () => void) {
    this.group = group;
    this.onChange = onChange;

    const root = document.createElement('section');
    root.className = 'dbg-tuning';

    const header = document.createElement('div');
    header.className = 'dbg-tuning__head';
    const title = document.createElement('span');
    title.className = 'op-label';
    title.textContent = group.title;
    header.appendChild(title);

    const copy = document.createElement('button');
    copy.className = 'dbg-btn';
    copy.type = 'button';
    copy.textContent = 'Copy config';
    copy.addEventListener('click', () => {
      void this.copyToClipboard(copy);
    });
    header.appendChild(copy);

    const reset = document.createElement('button');
    reset.className = 'dbg-btn';
    reset.type = 'button';
    reset.textContent = 'Reset';
    reset.addEventListener('click', () => {
      group.resetToDefaults();
      this.refresh();
      onChange();
    });
    header.appendChild(reset);

    root.appendChild(header);

    let lastGroupName = '';
    for (const key of group.keys) {
      const meta = group.meta(key);
      if (meta.group !== lastGroupName) {
        lastGroupName = meta.group;
        const sub = document.createElement('div');
        sub.className = 'dbg-tuning__group op-label';
        sub.textContent = meta.group;
        root.appendChild(sub);
      }
      root.appendChild(this.buildRow(key, meta));
    }

    this.element = root;
  }

  /** Re-read every slider from the config. Call after a programmatic change. */
  refresh(): void {
    for (const row of this.rows) {
      const value = this.group.read(row.key);
      row.input.value = String(value);
      row.readout.textContent = format(value, this.group.meta(row.key));
    }
  }

  private buildRow(key: string, meta: TunableMeta): HTMLElement {
    const row = document.createElement('label');
    row.className = 'dbg-slider';

    const name = document.createElement('span');
    name.className = 'dbg-slider__label';
    name.textContent = meta.label;

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(meta.min);
    input.max = String(meta.max);
    input.step = String(meta.step);
    input.value = String(this.group.read(key));
    input.className = 'dbg-slider__input';

    const readout = document.createElement('span');
    readout.className = 'dbg-slider__value op-num';
    readout.textContent = format(this.group.read(key), meta);

    input.addEventListener('input', () => {
      const value = Number.parseFloat(input.value);
      if (!Number.isFinite(value)) return;
      this.group.write(key, value);
      readout.textContent = format(value, meta);
      this.onChange();
    });

    row.append(name, input, readout);
    this.rows.push({ key, input, readout });
    return row;
  }

  private async copyToClipboard(button: HTMLButtonElement): Promise<void> {
    const source = this.group.toSource();
    const original = 'Copy config';
    try {
      await navigator.clipboard.writeText(source);
      button.textContent = 'Copied';
    } catch (err) {
      // Clipboard access can be refused (insecure origin, permissions). Fall back to
      // the console so the tuned values are never lost.
      console.warn('[Tuning] clipboard unavailable; config written to console.', err);
      console.log(source);
      button.textContent = 'In console';
    }
    window.setTimeout(() => {
      button.textContent = original;
    }, 1400);
  }
}

function format(value: number, meta: TunableMeta): string {
  const decimals = meta.step >= 1 ? 0 : meta.step >= 0.1 ? 1 : meta.step >= 0.01 ? 2 : 3;
  return `${value.toFixed(decimals)}${meta.unit}`;
}
