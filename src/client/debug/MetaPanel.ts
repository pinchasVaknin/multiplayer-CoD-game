import { EV, type GameBus, type GameEvents } from '../../shared/core/Events';
import type { Match } from '../ClientMatch';
import { levelProgress } from '../../shared/meta/Levels';
import type { Profile } from '../meta/Profile';
import { weaponLevelProgress } from '../../shared/meta/Unlocks';
import { perkDef } from '../../shared/perks/PerkDefs';
import { NO_PERKS } from '../../shared/perks/PerkState';
import { resolveWeaponDef } from '../../shared/weapons/Attachments';
import type { WeaponDef } from '../../shared/weapons/WeaponDefs';
import type { DebugOverlay } from './DebugOverlay';
import { SaveInspector } from './SaveInspector';
import { AVERAGE_MATCH, simulateXp, simulationToLines } from './XpSimulator';

/**
 * The M6 debug panels (brief S7).
 *
 * Four read-outs and one instrument, all on the overlay's existing 15 Hz text hook rather
 * than a timer of their own — the rule since M1, and the reason twenty-odd extra fields do
 * not show up in the frame times the overlay exists to report.
 *
 * **Perk modifiers** is the one that matters. S7 asks for "base value -> resolved value per
 * stat", and the panel gets there the only honest way: it resolves the *base* weapon with
 * no modifiers and the base weapon with the perks and attachments, through
 * `resolveWeaponDef` — the same function the match and the loadout editor call — and
 * prints the rows that differ. It is therefore impossible for this panel to claim a perk
 * does something the weapon does not do.
 *
 * **The EventBus tap** counts every event type this match. It exists because "challenge
 * progress is driven off the EventBus, not by polling" is a claim about plumbing, and the
 * way to check plumbing is to watch what actually came down it.
 */

/** Every event the tap watches. The whole `EV` map, so nothing can fire unseen. */
const TAPPED: readonly (keyof GameEvents)[] = Object.values(EV);

export class MetaPanel {
  private readonly profile: Profile;
  private readonly match: Match;
  private readonly inspector: SaveInspector;
  private readonly unsubscribe: Array<() => void> = [];

  /** Event name -> times fired since the match began. */
  private readonly tap = new Map<string, number>();
  private tapTotal = 0;

  private readonly fLevel: { el: HTMLElement; last: string };
  private readonly fSession: { el: HTMLElement; last: string };
  private readonly fWrites: { el: HTMLElement; last: string };
  private readonly fWeapon: { el: HTMLElement; last: string };
  private readonly fPerks: { el: HTMLElement; last: string };
  private readonly fUpgrade: { el: HTMLElement; last: string };
  private readonly fScavenger: { el: HTMLElement; last: string };
  private readonly fMetaMs: { el: HTMLElement; last: string };

  private readonly modifierBody: HTMLElement;
  private readonly challengeBody: HTMLElement;
  private readonly tapBody: HTMLElement;
  private readonly simBody: HTMLElement;

  constructor(overlay: DebugOverlay, match: Match, profile: Profile, bus: GameBus) {
    this.profile = profile;
    this.match = match;

    // ---- profile ------------------------------------------------------------
    const profileSection = overlay.section('Progression', overlay.leftColumn);
    this.fLevel = profileSection.addField('Level / XP');
    this.fSession = profileSection.addField('This match');
    this.fWrites = profileSection.addField('Save writes');
    this.fWeapon = profileSection.addField('Weapon');
    this.fPerks = profileSection.addField('Perks');
    this.fUpgrade = profileSection.addField('Field upgrade');
    this.fScavenger = profileSection.addField('Pickups / trail');
    this.fMetaMs = profileSection.addField('Meta ms');

    // ---- perk modifiers -----------------------------------------------------
    const modifiers = overlay.section('Perk & attachment modifiers', overlay.leftColumn);
    this.modifierBody = document.createElement('div');
    this.modifierBody.className = 'dbg-table';
    modifiers.addNode(this.modifierBody);

    // ---- challenges ---------------------------------------------------------
    const challenges = overlay.section('Challenges', overlay.leftColumn);
    this.challengeBody = document.createElement('div');
    this.challengeBody.className = 'dbg-table';
    challenges.addNode(this.challengeBody);

    // ---- event tap ----------------------------------------------------------
    const tapSection = overlay.section('EventBus tap', overlay.leftColumn);
    this.tapBody = document.createElement('div');
    this.tapBody.className = 'dbg-table';
    tapSection.addNode(this.tapBody);

    // ---- simulator ----------------------------------------------------------
    const sim = overlay.section('XP simulator', overlay.rightColumn);
    const buttons = document.createElement('div');
    buttons.className = 'dbg-buttons';
    for (const n of [25, 100, 400]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dbg-btn';
      b.textContent = `${n} MATCHES`;
      b.addEventListener('click', () => this.runSimulation(n));
      buttons.appendChild(b);
    }
    const fromHere = document.createElement('button');
    fromHere.type = 'button';
    fromHere.className = 'dbg-btn';
    fromHere.textContent = 'TO LEVEL 55 FROM HERE';
    fromHere.addEventListener('click', () => this.runSimulation(2000, this.profile.xp));
    buttons.appendChild(fromHere);
    sim.addNode(buttons);
    this.simBody = document.createElement('div');
    this.simBody.className = 'dbg-log';
    sim.addNode(this.simBody);

    this.inspector = new SaveInspector(overlay, profile);

    // One subscription per event type, each incrementing a counter. Cheap enough to leave
    // on: `emit` already walks a list, and this adds one integer bump per dispatch.
    for (const name of TAPPED) {
      this.unsubscribe.push(
        bus.on(name, () => {
          this.tap.set(String(name), (this.tap.get(String(name)) ?? 0) + 1);
          this.tapTotal++;
        }),
      );
    }

    overlay.addTextHook(() => this.refresh());
    this.runSimulation(100);
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
  }

  /** The save inspector, for the console API. */
  get saveInspector(): SaveInspector {
    return this.inspector;
  }

  // -- refresh ----------------------------------------------------------------

  private refresh(): void {
    const profile = this.profile;
    const meta = this.match.meta;
    const progress = levelProgress(profile.xp);

    set(this.fLevel, `${progress.level} · ${Math.floor(progress.into)} / ${progress.span}`);
    set(
      this.fSession,
      `${meta.progression.killCount} kills · ${meta.progression.liveXp} XP pending`,
    );
    set(
      this.fWrites,
      `${profile.writeCount} · ${profile.store.isPersistent ? 'localStorage' : 'memory'}`,
    );

    const def = this.match.weapons.definition;
    const stats = profile.weapon(def.id);
    const level = weaponLevelProgress(stats.xp);
    set(
      this.fWeapon,
      `${def.name} LV${level.level} · ${stats.kills}k ${stats.headshots}hs · ` +
        `${stats.longestShot.toFixed(0)}m best`,
    );

    const state = meta.state;
    set(this.fPerks, state.perks.length === 0 ? 'none' : state.perks.map((p) => perkDef(p).name).join(', '));
    set(
      this.fUpgrade,
      `${meta.fieldUpgrade.name} ${(meta.fieldUpgrade.charge * 100).toFixed(0)}%` +
        `${meta.fieldUpgrade.ready ? ' READY' : ''} · ${meta.fieldUpgrade.uses} used`,
    );
    set(
      this.fScavenger,
      `${meta.perks.pickupsCollected}/${meta.perks.pickupsSpawned} mags · ` +
        `${meta.perks.trailPoints} prints`,
    );
    set(this.fMetaMs, meta.lastMs.toFixed(3));

    this.refreshModifiers();
    this.refreshChallenges();
    this.refreshTap();
  }

  /**
   * Base against resolved, per stat.
   *
   * The base is re-resolved with an empty modifier list rather than read off the registry,
   * so both sides of the comparison have been through the same clone and the same code
   * path — a difference here can only come from a modifier.
   */
  private refreshModifiers(): void {
    const loadoutDef = this.match.weapons.definition;
    const base = resolveWeaponDef(this.match.playerBaseDef, []);
    const rows: Array<Readonly<[string, string]>> = [];

    const compare = (label: string, read: (d: WeaponDef) => number, digits: number, unit: string): void => {
      const a = read(base);
      const b = read(loadoutDef);
      if (Math.abs(a - b) < 1e-9) return;
      const delta = ((b - a) / (a === 0 ? 1 : a)) * 100;
      rows.push([
        label,
        `${a.toFixed(digits)}${unit} → ${b.toFixed(digits)}${unit} (${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%)`,
      ]);
    };

    compare('ADS time', (d) => d.adsTime * 1000, 1, 'ms');
    compare('Reload', (d) => d.reloadTime * 1000, 1, 'ms');
    compare('Reload empty', (d) => d.reloadEmptyTime * 1000, 1, 'ms');
    compare('Swap in', (d) => d.swapInTime * 1000, 1, 'ms');
    compare('Swap out', (d) => d.swapOutTime * 1000, 1, 'ms');
    compare('Magazine', (d) => d.magSize, 0, '');
    compare('Range end', (d) => d.damageFalloff.end, 2, 'm');
    compare('Hip spread', (d) => d.spread.hipStand, 3, '°');
    compare('ADS spread', (d) => d.spread.ads, 3, '°');
    compare('Recoil vert', (d) => d.recoil.verticalScale, 3, 'x');

    // The state-side perks cannot be expressed as a weapon field, so they get their own
    // rows against the neutral defaults `NO_PERKS` describes.
    const state = this.match.meta.state;
    if (state.moveSpeedMult !== NO_PERKS.moveSpeedMult) {
      rows.push([
        'Move speed',
        `1.000x → ${state.moveSpeedMult.toFixed(3)}x (sprint ` +
          `${(6.9 * state.moveSpeedMult).toFixed(2)} m/s)`,
      ]);
    }
    if (state.audibleFootsteps !== NO_PERKS.audibleFootsteps) {
      rows.push(['Footstep noise', 'audible → silent to bots']);
    }
    if (state.flashResistMult !== NO_PERKS.flashResistMult) {
      rows.push(['Flash intensity', `1.000x → ${state.flashResistMult.toFixed(3)}x`]);
    }
    if (state.scavenger) rows.push(['Scavenger', 'magazines drop from bodies']);
    if (state.tracker) rows.push(['Tracker', 'enemy footstep trails drawn']);
    if (state.overkill) rows.push(['Overkill', 'secondary slot accepts a primary']);
    if (!state.visibleToUav) rows.push(['Ghost', 'invisible to UAV (inert until M7)']);
    if (!state.targetedByStreaks) rows.push(['Cold-Blooded', 'not targeted (inert until M7)']);
    if (state.streakDiscount > 0) {
      rows.push(['Hardline', `-${state.streakDiscount} kill to streaks (inert until M7)`]);
    }

    if (rows.length === 0) rows.push(['—', 'no modifiers fitted']);
    paintTable(this.modifierBody, rows);
  }

  private refreshChallenges(): void {
    const rows: Array<Readonly<[string, string]>> = [];
    const all = this.profile.challengeRows();
    // In progress first, then nearly-done, then the rest. A thirty-row list nobody can
    // scan is the same as no list.
    const active = all
      .filter((r) => !r.state.completed && r.state.progress > 0)
      .sort((a, b) => b.state.progress / b.def.target - a.state.progress / a.def.target);
    const done = all.filter((r) => r.state.completed);

    for (const row of active.slice(0, 10)) {
      const pct = Math.round((row.state.progress / row.def.target) * 100);
      rows.push([row.def.name, `${row.state.progress} / ${row.def.target} (${pct}%)`]);
    }
    rows.push(['Completed', `${done.length} / ${all.length}`]);
    const camos = Object.entries(this.profile.save.camos).filter(([, owned]) => owned === true);
    rows.push(['Camos owned', camos.length === 0 ? 'none' : camos.map(([id]) => id).join(', ')]);
    paintTable(this.challengeBody, rows);
  }

  private refreshTap(): void {
    const rows: Array<Readonly<[string, string]>> = [];
    const sorted = [...this.tap.entries()].sort((a, b) => b[1] - a[1]);
    for (const [name, count] of sorted.slice(0, 14)) rows.push([name, String(count)]);
    rows.push(['— total —', `${this.tapTotal} across ${this.tap.size} types`]);
    paintTable(this.tapBody, rows);
  }

  private runSimulation(matches: number, startXp = 0): void {
    const sim = simulateXp(matches, startXp, AVERAGE_MATCH);
    this.simBody.replaceChildren();
    const perMatch = document.createElement('div');
    perMatch.textContent = sim.breakdown.map((b) => `${b.label} ${b.xp}`).join(' · ');
    this.simBody.appendChild(perMatch);
    for (const line of simulationToLines(sim)) {
      const el = document.createElement('div');
      el.className = 'dbg-log__line';
      el.textContent = line;
      this.simBody.appendChild(el);
    }
  }
}

function set(field: { el: HTMLElement; last: string }, text: string): void {
  if (field.last === text) return;
  field.last = text;
  field.el.textContent = text;
}

function paintTable(host: HTMLElement, rows: readonly Readonly<[string, string]>[]): void {
  const signature = rows.map((r) => `${r[0]}=${r[1]}`).join('|');
  if (host.dataset['sig'] === signature) return;
  host.dataset['sig'] = signature;
  host.replaceChildren();
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'dbg-row';
    const l = document.createElement('span');
    l.className = 'dbg-row__label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'dbg-row__value op-num';
    v.textContent = value;
    row.append(l, v);
    host.appendChild(row);
  }
}
