import type { GameEvents } from '../../shared/core/Events';
import { HEADSHOT_PATH, HEADSHOT_VIEWBOX, ICON_VIEWBOX, iconFor, makeIconSvg } from './WeaponIcons';

/**
 * The killfeed, drawn (brief S6.5).
 *
 * The model is `combat/Killfeed.ts`; this is four preallocated rows and a fade. Rows are
 * built once at construction and reused, so a busy feed does no DOM allocation at all — a
 * ten-bot match produces a kill every couple of seconds and creating and destroying elements
 * for each one is a per-kill layout and a per-kill garbage.
 *
 * Text is written only when a row's content actually changes, and everything animated is
 * opacity. The whole feed costs one `style.opacity` write per live row per frame, which is
 * why it does not appear in the HUD millisecond count next to it.
 */

const ROWS = 5;
/** Seconds a line stays fully readable, and how long it takes to go afterwards. */
const HOLD_SECONDS = 4.6;
const FADE_SECONDS = 0.8;

type Entry = GameEvents['killfeed.entry'];

interface Row {
  readonly el: HTMLElement;
  readonly killer: HTMLElement;
  readonly victim: HTMLElement;
  readonly iconSlot: HTMLElement;
  readonly headshotSlot: HTMLElement;
  life: number;
  active: boolean;
  lastOpacity: number;
  lastKiller: string;
  lastVictim: string;
  lastWeapon: string;
  lastHeadshot: boolean;
}

export class KillfeedView {
  readonly element: HTMLElement;

  private readonly rows: Row[] = [];
  /** Cached icon markup per weapon id, so a path is parsed once and not once per kill. */
  private readonly iconCache = new Map<string, SVGSVGElement>();

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'hud-feed';

    for (let i = 0; i < ROWS; i++) {
      const el = document.createElement('div');
      el.className = 'hud-feed__row';
      el.style.opacity = '0';

      const killer = document.createElement('span');
      killer.className = 'hud-feed__name';
      const iconSlot = document.createElement('span');
      iconSlot.className = 'hud-feed__icon';
      const headshotSlot = document.createElement('span');
      headshotSlot.className = 'hud-feed__hs';
      const victim = document.createElement('span');
      victim.className = 'hud-feed__name';

      el.append(killer, iconSlot, headshotSlot, victim);
      this.element.appendChild(el);
      this.rows.push({
        el,
        killer,
        victim,
        iconSlot,
        headshotSlot,
        life: 0,
        active: false,
        lastOpacity: -1,
        lastKiller: '',
        lastVictim: '',
        lastWeapon: '',
        lastHeadshot: false,
      });
    }
  }

  /**
   * Add a line. Newest at the top: rows shift down by one and the oldest is dropped, which
   * is done by moving *state* between the fixed rows rather than by touching the DOM order.
   */
  push(entry: Entry): void {
    for (let i = this.rows.length - 1; i > 0; i--) {
      const to = this.rows[i];
      const from = this.rows[i - 1];
      if (to === undefined || from === undefined) continue;
      this.copyRow(from, to);
    }
    const head = this.rows[0];
    if (head === undefined) return;

    head.active = true;
    head.life = HOLD_SECONDS + FADE_SECONDS;

    const killerName = entry.suicide ? '' : entry.killerName;
    if (killerName !== head.lastKiller) {
      head.lastKiller = killerName;
      head.killer.textContent = killerName;
    }
    if (entry.victimName !== head.lastVictim) {
      head.lastVictim = entry.victimName;
      head.victim.textContent = entry.victimName;
    }

    head.killer.className = `hud-feed__name ${teamClass(entry.killerTeam, entry.involvesLocal)}`;
    head.victim.className = `hud-feed__name ${teamClass(entry.victimTeam, entry.involvesLocal)}`;
    head.el.classList.toggle('hud-feed__row--local', entry.involvesLocal);

    if (entry.weaponId !== head.lastWeapon) {
      head.lastWeapon = entry.weaponId;
      this.paintIcon(head, entry.weaponId);
    }
    if (entry.headshot !== head.lastHeadshot) {
      head.lastHeadshot = entry.headshot;
      head.headshotSlot.replaceChildren();
      if (entry.headshot) {
        head.headshotSlot.appendChild(makeIconSvg(HEADSHOT_PATH, HEADSHOT_VIEWBOX, 'hud-feed__hs-svg'));
      }
    }

    head.lastOpacity = -1;
  }

  /** Called once per rendered frame. */
  update(dt: number): void {
    for (const row of this.rows) {
      if (!row.active) continue;
      row.life -= dt;
      if (row.life <= 0) {
        row.active = false;
        row.el.style.opacity = '0';
        row.lastOpacity = 0;
        continue;
      }
      const fade = row.life > FADE_SECONDS ? 1 : row.life / FADE_SECONDS;
      const opacity = Math.round(fade * 20) / 20;
      if (opacity === row.lastOpacity) continue;
      row.lastOpacity = opacity;
      row.el.style.opacity = opacity.toFixed(2);
    }
  }

  clear(): void {
    for (const row of this.rows) {
      row.active = false;
      row.life = 0;
      row.lastOpacity = 0;
      row.el.style.opacity = '0';
    }
  }

  // -- internals -------------------------------------------------------------

  private copyRow(from: Row, to: Row): void {
    to.active = from.active;
    to.life = from.life;
    to.lastOpacity = -1;

    if (from.lastKiller !== to.lastKiller) {
      to.lastKiller = from.lastKiller;
      to.killer.textContent = from.lastKiller;
    }
    if (from.lastVictim !== to.lastVictim) {
      to.lastVictim = from.lastVictim;
      to.victim.textContent = from.lastVictim;
    }
    to.killer.className = from.killer.className;
    to.victim.className = from.victim.className;
    to.el.className = from.el.className;

    if (from.lastWeapon !== to.lastWeapon) {
      to.lastWeapon = from.lastWeapon;
      this.paintIcon(to, from.lastWeapon);
    }
    if (from.lastHeadshot !== to.lastHeadshot) {
      to.lastHeadshot = from.lastHeadshot;
      to.headshotSlot.replaceChildren();
      if (from.lastHeadshot) {
        to.headshotSlot.appendChild(makeIconSvg(HEADSHOT_PATH, HEADSHOT_VIEWBOX, 'hud-feed__hs-svg'));
      }
    }
  }

  /**
   * Draw the weapon's outline.
   *
   * It used to be *"the outline, or its name when that class has no outline yet"*, and the
   * name was what eleven of the twelve weapons got, because the icons were one hand-drawn AR
   * path keyed by class. `iconFor` is per weapon and projected from the model spec now
   * (playtest round 4, F15), so there is always a shape and it is always this weapon's.
   */
  private paintIcon(row: Row, weaponId: string): void {
    row.iconSlot.replaceChildren();
    const cached = this.iconCache.get(weaponId);
    if (cached === undefined) {
      const svg = makeIconSvg(iconFor(weaponId), ICON_VIEWBOX, 'hud-feed__icon-svg');
      this.iconCache.set(weaponId, svg);
      row.iconSlot.appendChild(svg.cloneNode(true));
      return;
    }
    row.iconSlot.appendChild(cached.cloneNode(true));
  }
}

function teamClass(team: 'A' | 'B' | 'NONE', involvesLocal: boolean): string {
  if (team === 'NONE') return 'hud-feed__name--neutral';
  const base = team === 'A' ? 'hud-feed__name--friendly' : 'hud-feed__name--hostile';
  return involvesLocal ? `${base} hud-feed__name--bright` : base;
}
