import type { Match } from '../ClientMatch';
import { ATTACHMENTS, ATTACHMENT_IDS, fitsWeapon, resolveWeaponDef, type AttachmentId } from '../../shared/weapons/Attachments';
import { ALL_WEAPONS, cloneWeaponDef, type WeaponDef } from '../../shared/weapons/WeaponDefs';
import { accumulatePattern } from '../../shared/weapons/Recoil';
import type { ArsenalHarness } from './ArsenalHarness';
import { ttkTableToMarkdown } from './ArsenalHarness';
import type { DebugOverlay, DebugSection } from './DebugOverlay';

/**
 * The M5 weapon panel (brief S7).
 *
 * Four things the brief asks for, and one it does not but the milestone needs:
 *
 *  1. **A weapon picker.** Twelve weapons exist; without this only one is reachable, and a
 *     roster you cannot fire is a roster you have not tested.
 *  2. **The resolved `WeaponDef` after attachments, side by side with the base.** Only rows
 *     that actually differ are printed, because a forty-row table where two rows changed
 *     hides the two rows.
 *  3. **A recoil pattern plot per weapon.** All twelve overlaid, with the active one
 *     highlighted — which is the only way to see at a glance that no two are the same.
 *  4. **A pellet spread visualisation**, drawn from a real measured shell rather than from
 *     the cone's parameters.
 *  5. The balance table, measured and copied to the clipboard as Markdown.
 *
 * Everything refreshes on the overlay's own hooks (15 Hz text, 5 Hz graphs) rather than on
 * a timer of its own, the way every panel since M2 has.
 */

const PLOT_W = 300;
const PLOT_H = 210;
const PELLET_W = 300;
const PELLET_H = 210;
const PATTERN_SHOTS = 30;

export class ArsenalPanel {
  private readonly section: DebugSection;
  private readonly patternCanvas: HTMLCanvasElement;
  private readonly patternCtx: CanvasRenderingContext2D;
  private readonly pelletCanvas: HTMLCanvasElement;
  private readonly pelletCtx: CanvasRenderingContext2D;
  private readonly resolvedBox: HTMLElement;
  private readonly deltaBox: HTMLElement;
  private readonly statusLine: HTMLElement;

  private readonly attachments = new Set<AttachmentId>();
  private readonly patternX = new Float32Array(PATTERN_SHOTS);
  private readonly patternY = new Float32Array(PATTERN_SHOTS);

  private slotIndex = 0;
  private lastResolvedKey = '';
  private pelletZones: string[] = [];
  private pelletRange = 6;

  constructor(
    overlay: DebugOverlay,
    private readonly match: Match,
    private readonly harness: ArsenalHarness,
    private readonly liveDef: WeaponDef,
    private readonly onWeaponChanged: () => void,
  ) {
    this.section = overlay.section('Arsenal');

    this.statusLine = document.createElement('div');
    this.statusLine.className = 'dbg-note';
    this.section.element.appendChild(this.statusLine);

    this.section.element.appendChild(this.buildSlotRow());
    this.section.element.appendChild(this.buildWeaponGrid());
    this.section.element.appendChild(this.buildAttachmentRow());

    this.resolvedBox = document.createElement('div');
    this.resolvedBox.className = 'dbg-note dbg-note--table';
    this.section.element.appendChild(this.resolvedBox);

    this.deltaBox = document.createElement('div');
    this.deltaBox.className = 'dbg-note dbg-note--table';
    this.section.element.appendChild(this.deltaBox);

    this.patternCanvas = makeCanvas(PLOT_W, PLOT_H);
    this.patternCtx = context2d(this.patternCanvas);
    this.section.addNode(this.patternCanvas);

    this.pelletCanvas = makeCanvas(PELLET_W, PELLET_H);
    this.pelletCtx = context2d(this.pelletCanvas);
    this.section.addNode(this.pelletCanvas);

    this.section.element.appendChild(this.buildActions());

    overlay.addTextHook(() => this.refreshText());
    overlay.addGraphHook(() => this.refreshGraphs());
    this.applyLoadout();
  }

  dispose(): void {
    this.section.element.replaceChildren();
  }

  /** The def the active slot is actually holding, attachments included. */
  get resolved(): WeaponDef {
    return resolveWeaponDef(this.baseDef, [...this.attachments]);
  }

  private get baseDef(): WeaponDef {
    const slotDef = this.match.weapons.inventory.at(this.slotIndex)?.definition;
    return slotDef ?? this.liveDef;
  }

  // -- controls --------------------------------------------------------------

  private buildSlotRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'dbg-chips';
    for (const [index, label] of [[0, 'PRIMARY'], [1, 'SECONDARY']] as const) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'dbg-chip';
      chip.textContent = label;
      chip.dataset['slot'] = String(index);
      chip.addEventListener('click', () => {
        this.slotIndex = index;
        this.attachments.clear();
        this.markSlots(row);
        this.applyLoadout();
      });
      row.appendChild(chip);
    }
    this.markSlots(row);
    return row;
  }

  private markSlots(row: HTMLElement): void {
    for (const child of Array.from(row.children)) {
      if (!(child instanceof HTMLElement)) continue;
      child.classList.toggle('is-on', child.dataset['slot'] === String(this.slotIndex));
    }
  }

  private buildWeaponGrid(): HTMLElement {
    const grid = document.createElement('div');
    grid.className = 'dbg-chips dbg-chips--wrap';
    for (const def of ALL_WEAPONS) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'dbg-chip';
      chip.textContent = def.name;
      chip.title = `${def.class} · ${def.rpm} RPM · ${def.damage.near}/${def.damage.far}`;
      chip.dataset['weapon'] = def.id;
      chip.addEventListener('click', () => {
        this.equip(def);
        this.markWeapons(grid);
      });
      grid.appendChild(chip);
    }
    this.weaponGrid = grid;
    return grid;
  }

  private weaponGrid: HTMLElement | null = null;

  private markWeapons(grid: HTMLElement): void {
    const activeId = this.baseDef.id;
    for (const child of Array.from(grid.children)) {
      if (!(child instanceof HTMLElement)) continue;
      child.classList.toggle('is-on', child.dataset['weapon'] === activeId);
    }
  }

  private buildAttachmentRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'dbg-chips dbg-chips--wrap';
    for (const id of ATTACHMENT_IDS) {
      const def = ATTACHMENTS[id];
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'dbg-chip';
      chip.textContent = def.name;
      chip.title = `${def.benefit}  —  ${def.cost}`;
      chip.dataset['attachment'] = id;
      chip.addEventListener('click', () => {
        if (this.attachments.has(id)) this.attachments.delete(id);
        else this.attachments.add(id);
        this.markAttachments(row);
        this.applyLoadout();
      });
      row.appendChild(chip);
    }
    this.attachmentRow = row;
    return row;
  }

  private attachmentRow: HTMLElement | null = null;

  private markAttachments(row: HTMLElement): void {
    const base = this.baseDef;
    for (const child of Array.from(row.children)) {
      if (!(child instanceof HTMLElement)) continue;
      const id = child.dataset['attachment'] as AttachmentId | undefined;
      if (id === undefined) continue;
      child.classList.toggle('is-on', this.attachments.has(id));
      child.classList.toggle('is-off', !fitsWeapon(base, id));
    }
  }

  private buildActions(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'dbg-chips';

    row.appendChild(
      this.action('Measure balance table', () => {
        this.statusLine.textContent = 'Measuring 12 weapons x 4 ranges x 2 zones…';
        // Deferred a frame so the status line paints before the measurement blocks.
        window.setTimeout(() => {
          const rows = this.harness.measureTtkTable();
          const markdown = ttkTableToMarkdown(rows);
          void copyToClipboard(markdown, (ok) => {
            this.statusLine.textContent = ok
              ? `Balance table measured (${rows.length} weapons) and copied as Markdown.`
              : 'Balance table measured; clipboard unavailable, written to the console.';
            if (!ok) console.info(markdown);
          });
        }, 32);
      }),
    );

    row.appendChild(
      this.action('Measure pellet spread', () => {
        const shotgun = ALL_WEAPONS.find((d) => d.pellets > 1);
        if (shotgun === undefined) return;
        const result = this.harness.measurePelletSpread(shotgun, this.pelletRange);
        this.pelletZones = result.zones;
        this.statusLine.textContent =
          `${shotgun.name} at ${this.pelletRange} m: ${result.hits}/${shotgun.pellets} pellets, ` +
          `${result.damage.toFixed(1)} damage, zones ${summarise(result.zones)}`;
        this.drawPellets();
      }),
    );

    for (const range of [4, 6, 10]) {
      row.appendChild(
        this.action(`${range} m`, () => {
          this.pelletRange = range;
        }),
      );
    }

    row.appendChild(
      this.action('Verify attachment purity', () => {
        const findings = this.harness.report().purity;
        const failed = findings.filter((f) => !f.ok);
        this.statusLine.textContent =
          failed.length === 0
            ? `Attachment resolution pure: ${findings.length}/${findings.length} checks pass.`
            : `FAILED: ${failed.map((f) => f.check).join(', ')}`;
        for (const f of findings) console.info(`[purity] ${f.ok ? 'ok ' : 'FAIL'} ${f.check} — ${f.detail}`);
      }),
    );

    return row;
  }

  private action(label: string, onClick: () => void): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dbg-chip dbg-chip--action';
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  }

  // -- state -----------------------------------------------------------------

  private equip(def: WeaponDef): void {
    // The live def objects are what the tuning sliders point at, so a weapon change copies
    // the new weapon *into* them rather than replacing the reference — otherwise every
    // slider in the panel would be editing a weapon nobody is holding.
    const target = this.slotIndex === 0 ? this.liveDef : this.match.weapons.inventory.at(1)?.definition;
    if (target === undefined) return;
    Object.assign(target, cloneWeaponDef(def));
    this.attachments.clear();
    this.applyLoadout();
  }

  private applyLoadout(): void {
    const resolvedDef = this.resolved;
    this.match.equip(this.slotIndex, resolvedDef);
    if (this.attachmentRow !== null) this.markAttachments(this.attachmentRow);
    if (this.weaponGrid !== null) this.markWeapons(this.weaponGrid);
    this.onWeaponChanged();
    this.lastResolvedKey = '';
  }

  private refreshText(): void {
    const base = this.baseDef;
    const resolvedDef = this.resolved;
    const key = `${base.id}|${[...this.attachments].sort().join(',')}`;
    if (key === this.lastResolvedKey) return;
    this.lastResolvedKey = key;

    this.resolvedBox.textContent = describeResolved(base, resolvedDef);
    this.deltaBox.textContent = describeAttachments([...this.attachments]);
  }

  private refreshGraphs(): void {
    this.drawPatterns();
    this.drawPellets();
  }

  /**
   * All twelve patterns in one space, the active one in the accent colour.
   *
   * The point of overlaying them is the acceptance criterion: "if two weapons feel the
   * same, one of them is wrong" is a claim you can *look at* when the traces are on top of
   * each other, and cannot when they are in twelve separate plots.
   */
  private drawPatterns(): void {
    const ctx = this.patternCtx;
    ctx.clearRect(0, 0, PLOT_W, PLOT_H);
    ctx.fillStyle = 'rgba(7,8,10,0.6)';
    ctx.fillRect(0, 0, PLOT_W, PLOT_H);

    // One shared scale so the plots are comparable rather than each auto-fitted.
    let maxX = 1;
    let maxY = 1;
    for (const def of ALL_WEAPONS) {
      const n = accumulatePattern(def, PATTERN_SHOTS, this.patternX, this.patternY);
      for (let i = 0; i < n; i++) {
        maxX = Math.max(maxX, Math.abs(this.patternX[i] ?? 0));
        maxY = Math.max(maxY, this.patternY[i] ?? 0);
      }
    }

    const cx = PLOT_W * 0.5;
    const baseY = PLOT_H - 14;
    const sx = (PLOT_W * 0.44) / maxX;
    const sy = (PLOT_H - 26) / maxY;

    ctx.strokeStyle = 'rgba(38,43,51,1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, 6);
    ctx.lineTo(cx, baseY);
    ctx.moveTo(8, baseY);
    ctx.lineTo(PLOT_W - 8, baseY);
    ctx.stroke();

    const activeId = this.baseDef.id;
    for (const def of ALL_WEAPONS) {
      const n = accumulatePattern(def, PATTERN_SHOTS, this.patternX, this.patternY);
      if (n === 0) continue;
      const active = def.id === activeId;
      ctx.strokeStyle = active ? '#ffb340' : 'rgba(154,161,173,0.32)';
      ctx.lineWidth = active ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(cx, baseY);
      for (let i = 0; i < n; i++) {
        ctx.lineTo(cx + (this.patternX[i] ?? 0) * sx, baseY - (this.patternY[i] ?? 0) * sy);
      }
      ctx.stroke();
    }

    ctx.fillStyle = '#626a77';
    ctx.font = '500 10px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(`12 patterns · ${PATTERN_SHOTS} shots · ${maxY.toFixed(1)}° peak climb`, 8, 12);
  }

  /** The measured shell, pellet by pellet, coloured by the zone each one found. */
  private drawPellets(): void {
    const ctx = this.pelletCtx;
    ctx.clearRect(0, 0, PELLET_W, PELLET_H);
    ctx.fillStyle = 'rgba(7,8,10,0.6)';
    ctx.fillRect(0, 0, PELLET_W, PELLET_H);

    const shotgun = ALL_WEAPONS.find((d) => d.pellets > 1);
    if (shotgun === undefined) return;

    // A silhouette to read the zones against: chest and head at the plotted range.
    const cx = PELLET_W * 0.5;
    const cy = PELLET_H * 0.55;
    const metresToPx = (PELLET_H * 0.42) / 1.0;
    ctx.strokeStyle = 'rgba(58,64,75,1)';
    ctx.lineWidth = 1;
    ctx.strokeRect(cx - 0.23 * metresToPx, cy - 0.2 * metresToPx, 0.46 * metresToPx, 0.4 * metresToPx);
    ctx.strokeRect(cx - 0.11 * metresToPx, cy - 0.585 * metresToPx, 0.22 * metresToPx, 0.25 * metresToPx);

    // The cone at this range, so the pellet lattice can be read against its own bound.
    const coneRadius = Math.tan((shotgun.pelletSpread * Math.PI) / 180) * this.pelletRange * metresToPx;
    ctx.strokeStyle = 'rgba(255,179,64,0.35)';
    ctx.beginPath();
    ctx.arc(cx, cy - 0.24 * metresToPx, coneRadius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = '#626a77';
    ctx.font = '500 10px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(
      `${shotgun.name} · ${shotgun.pellets} pellets · ${shotgun.pelletSpread.toFixed(2)}° at ${this.pelletRange} m`,
      8,
      12,
    );

    if (this.pelletZones.length === 0) {
      ctx.fillText('press MEASURE PELLET SPREAD', 8, PELLET_H - 8);
      return;
    }

    // The lattice is deterministic, so the plotted positions are the same ones the
    // measurement used up to the per-shot rotation.
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < this.pelletZones.length; i++) {
      const zone = this.pelletZones[i] ?? 'torso';
      const r = i === 0 ? 0 : Math.sqrt(i / Math.max(1, this.pelletZones.length - 1)) * coneRadius;
      const a = i * golden;
      const px = cx + Math.cos(a) * r;
      const py = cy - 0.24 * metresToPx + Math.sin(a) * r;
      ctx.fillStyle = zoneColour(zone);
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = '#9aa1ad';
    ctx.fillText(summarise(this.pelletZones), 8, PELLET_H - 8);
  }
}

// -- helpers ------------------------------------------------------------------

function zoneColour(zone: string): string {
  switch (zone) {
    case 'head':
      return '#ffb340';
    case 'torso':
      return '#6fd08c';
    case 'arm':
      return '#5aa2e8';
    default:
      return '#626a77';
  }
}

function summarise(zones: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const z of zones) counts.set(z, (counts.get(z) ?? 0) + 1);
  if (counts.size === 0) return 'no hits';
  return [...counts.entries()].map(([z, n]) => `${n}x ${z}`).join(', ');
}

/**
 * Base against resolved, printing only the rows that changed.
 *
 * A forty-row table where two rows moved hides the two rows, which is the opposite of what
 * a debug panel is for.
 */
function describeResolved(base: WeaponDef, resolvedDef: WeaponDef): string {
  const rows: string[] = [];
  const num = (label: string, a: number, b: number, unit = '', digits = 3): void => {
    if (Math.abs(a - b) < 1e-9) return;
    const delta = b - a;
    const sign = delta > 0 ? '+' : '';
    rows.push(
      `${label.padEnd(16)} ${a.toFixed(digits)}${unit} -> ${b.toFixed(digits)}${unit}  (${sign}${delta.toFixed(digits)})`,
    );
  };

  num('ADS time', base.adsTime, resolvedDef.adsTime, ' s');
  num('Reload', base.reloadTime, resolvedDef.reloadTime, ' s');
  num('Reload empty', base.reloadEmptyTime, resolvedDef.reloadEmptyTime, ' s');
  num('Mag size', base.magSize, resolvedDef.magSize, '', 0);
  num('Falloff start', base.damageFalloff.start, resolvedDef.damageFalloff.start, ' m', 2);
  num('Falloff end', base.damageFalloff.end, resolvedDef.damageFalloff.end, ' m', 2);
  num('Hip spread', base.spread.hipStand, resolvedDef.spread.hipStand, '°');
  num('Hip moving', base.spread.hipMove, resolvedDef.spread.hipMove, '°');
  num('ADS spread', base.spread.ads, resolvedDef.spread.ads, '°');
  num('Recoil vert', base.recoil.verticalScale, resolvedDef.recoil.verticalScale, 'x');
  num('Sprint to fire', base.sprintOutTime, resolvedDef.sprintOutTime, ' s');
  if (base.minimapPing !== resolvedDef.minimapPing) {
    rows.push(`${'Minimap ping'.padEnd(16)} ${String(base.minimapPing)} -> ${String(resolvedDef.minimapPing)}`);
  }
  if (base.laserVisible !== resolvedDef.laserVisible) {
    rows.push(`${'Laser visible'.padEnd(16)} ${String(base.laserVisible)} -> ${String(resolvedDef.laserVisible)}`);
  }
  if (base.scope !== undefined && resolvedDef.scope !== undefined) {
    num('Scope sway', base.scope.swayDeg, resolvedDef.scope.swayDeg, '°');
  }

  const header = `BASE ${base.name}  ->  RESOLVED`;
  if (rows.length === 0) return `${header}\n  (no attachments fitted — identical)`;
  return `${header}\n  ${rows.join('\n  ')}`;
}

function describeAttachments(ids: readonly AttachmentId[]): string {
  if (ids.length === 0) return 'No attachments. Every one below costs something.';
  return ids
    .map((id) => {
      const a = ATTACHMENTS[id];
      return `${a.name}\n  + ${a.benefit}\n  - ${a.cost}`;
    })
    .join('\n');
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.className = 'dbg-canvas';
  return canvas;
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2D canvas context unavailable; cannot build the arsenal panel.');
  return ctx;
}

/** Clipboard with a console fallback — insecure origins and denied permissions both exist. */
function copyToClipboard(text: string, done: (ok: boolean) => void): void {
  const clipboard = navigator.clipboard as Clipboard | undefined;
  if (clipboard === undefined) {
    done(false);
    return;
  }
  clipboard.writeText(text).then(
    () => done(true),
    () => done(false),
  );
}
