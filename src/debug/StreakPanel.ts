import type { GameBus } from '../core/Events';
import { EV } from '../core/Events';
import type { Match } from '../Match';
import { PLAYER_ENTITY_ID } from '../combat/DamageSystem';
import { STREAK_DEFS, type StreakId } from '../streaks/StreakDefs';
import type { DebugOverlay } from './DebugOverlay';

/**
 * The killstreak instrumentation (M7, brief S7).
 *
 * S7 asks for four read-outs by name — **streak state, sentry target selection,
 * care-package contest state**, and (with the mode panel) round and side-swap tracking. All
 * four are here, plus the buttons that make acceptance criteria 1, 2, 7 and 8 reachable
 * without staging a twelve-kill streak first.
 *
 * Everything hangs off the overlay's existing 15 Hz text hook rather than a timer of its own,
 * which is the rule the M4 panels follow and the reason the instrumentation does not appear in
 * the frame times it exists to report. Nothing here is written per frame.
 */

interface Field {
  el: HTMLElement;
  last: string;
}

export class StreakPanel {
  private readonly match: Match;

  private readonly fProgress: Field;
  private readonly fPending: Field;
  private readonly fActive: Field;
  private readonly fPerks: Field;
  private readonly fSentries: Field;
  private readonly fPackages: Field;
  private readonly fChopper: Field;
  private readonly log: HTMLElement;
  private readonly unsubscribe: Array<() => void> = [];

  constructor(overlay: DebugOverlay, match: Match, bus: GameBus) {
    this.match = match;

    const streaks = overlay.section('Killstreaks', overlay.rightColumn);
    this.fProgress = streaks.addField('Streak / next');
    this.fPending = streaks.addField('In hand');
    this.fActive = streaks.addField('Active entities');
    this.fPerks = streaks.addField('Ghost / Cold / Hardline');

    // Acceptance criterion 1 wants every streak exercised; staging twelve consecutive kills
    // to reach the Chopper Gunner would measure the score system rather than the streak.
    for (const def of STREAK_DEFS) {
      streaks.addNode(
        this.button(`Give + use ${def.name}`, () => {
          const sim = match.playerSim;
          match.streaks.debugGrant(PLAYER_ENTITY_ID, def.id);
          this.spend(def.id, sim.x, sim.y, sim.z, sim.yaw);
        }),
      );
    }
    streaks.addNode(
      this.button('End all streaks', () => {
        match.streaks.endAll();
      }),
    );

    const sentries = overlay.section('Sentry targeting', overlay.rightColumn);
    this.fSentries = sentries.addField('Sentries');
    this.fPackages = sentries.addField('Care packages');
    this.fChopper = sentries.addField('Chopper');

    const feed = overlay.section('Streak log', overlay.rightColumn);
    this.log = document.createElement('div');
    this.log.className = 'dbg-log';
    feed.addNode(this.log);

    this.subscribe(bus);
    overlay.addTextHook(() => this.refresh());
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
  }

  // -- internals --------------------------------------------------------------

  /**
   * Spend a streak the way the player would.
   *
   * A sentry goes two metres ahead so it is placed rather than worn, and a mortar takes the
   * overlay's current mark — the same rules `Match.stepStreakInput` uses, because a debug
   * button that placed things differently would be testing a different code path.
   */
  private spend(id: StreakId, x: number, y: number, z: number, yaw: number): void {
    const ahead = id === 'sentry' ? 2 : 0;
    const px = x - Math.sin(yaw) * ahead;
    const pz = z - Math.cos(yaw) * ahead;
    if (id === 'mortar') {
      this.match.streaks.activate(PLAYER_ENTITY_ID, id, this.match.mortarMarkX, y, this.match.mortarMarkZ, yaw);
      return;
    }
    this.match.streaks.activate(PLAYER_ENTITY_ID, id, px, y, pz, yaw);
  }

  private refresh(): void {
    const streaks = this.match.streaks;
    const row = this.match.score.row(PLAYER_ENTITY_ID);
    const next = streaks.nextFor(PLAYER_ENTITY_ID);
    set(
      this.fProgress,
      next === null
        ? `${row?.streak ?? 0} · all earned`
        : `${row?.streak ?? 0} -> ${next.requirement} ${next.def.name}`,
    );

    const held = streaks.pendingFor(PLAYER_ENTITY_ID);
    set(this.fPending, held.length === 0 ? '—' : held.join(', '));
    set(this.fActive, `${streaks.active.length} · ${streaks.lastMs.toFixed(2)} ms`);

    // The three M6 hooks, as the streak system actually sees them.
    const perks = this.match.meta.state;
    set(
      this.fPerks,
      `${perks.visibleToUav ? 'visible' : 'GHOST'} / ${perks.targetedByStreaks ? 'targetable' : 'COLD'} / -${perks.streakDiscount}`,
    );

    // Sentry target selection — S7 names this one explicitly.
    const sentries = streaks.sentries();
    set(
      this.fSentries,
      sentries.length === 0
        ? '—'
        : sentries
            .map((s) => {
              const rate = s.shotsFired > 0 ? ((s.shotsHit / s.shotsFired) * 100).toFixed(0) : '—';
              return `#${s.instanceId}->${s.targetId < 0 ? 'none' : s.targetId} ${s.shotsHit}/${s.shotsFired} (${rate}%) hp${s.health.current.toFixed(0)}`;
            })
            .join(' | '),
    );

    // Care-package contest state — likewise.
    const packages = streaks.packages();
    set(
      this.fPackages,
      packages.length === 0
        ? '—'
        : packages
            .map((p) => {
              const who = p.claimantId < 0 ? 'unclaimed' : `#${p.claimantId} ${(p.claimFraction * 100).toFixed(0)}%`;
              return `${p.contents.name} ${p.landed ? who : 'falling'}`;
            })
            .join(' | '),
    );

    const chopper = streaks.activeChopperFor(PLAYER_ENTITY_ID);
    set(
      this.fChopper,
      chopper === null
        ? '—'
        : `spin ${(chopper.spin * 100).toFixed(0)}% · ${chopper.shotsHit}/${chopper.shotsFired} · ${chopper.secondsRemaining.toFixed(1)}s`,
    );
  }

  private subscribe(bus: GameBus): void {
    const push = (text: string): void => {
      const line = document.createElement('div');
      line.className = 'dbg-log__line';
      line.textContent = text;
      this.log.prepend(line);
      while (this.log.childElementCount > 14) this.log.lastElementChild?.remove();
    };

    this.unsubscribe.push(
      bus.on(EV.StreakEarned, (p) => push(`EARNED ${p.name} (${p.requirement}) by ${p.entityId}`)),
    );
    this.unsubscribe.push(
      bus.on(EV.StreakActivated, (p) => push(`ACTIVE ${p.name} #${p.instanceId} by ${p.entityId}`)),
    );
    this.unsubscribe.push(
      bus.on(EV.StreakExpired, (p) => push(`EXPIRED ${p.streakId} #${p.instanceId}`)),
    );
    this.unsubscribe.push(
      bus.on(EV.StreakDestroyed, (p) => push(`DESTROYED ${p.streakId} #${p.instanceId} by ${p.byId}`)),
    );
    this.unsubscribe.push(
      bus.on(EV.CarePackageDropped, (p) => push(`PACKAGE dropped #${p.packageId} (${p.ownerTeam})`)),
    );
    this.unsubscribe.push(
      bus.on(EV.CarePackageClaimed, (p) => push(`PACKAGE #${p.packageId} -> ${p.entityId}: ${p.name}`)),
    );
  }

  private button(label: string, onClick: () => void): HTMLElement {
    const el = document.createElement('button');
    el.className = 'dbg-btn';
    el.type = 'button';
    el.textContent = label;
    el.addEventListener('click', onClick);
    return el;
  }
}

function set(field: Field, text: string): void {
  if (field.last === text) return;
  field.last = text;
  field.el.textContent = text;
}
