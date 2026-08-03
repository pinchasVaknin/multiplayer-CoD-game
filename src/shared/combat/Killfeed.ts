import type { Combatant } from '../ai/Combatant';
import { EV, type GameBus } from '../core/Events';
import { PLAYER_ENTITY_ID } from './DamageSystem';
import type { HitZone } from './HitboxRig';

/**
 * The killfeed's model (brief S6.5).
 *
 * S3 has listed this file since M1 and M2 left it out on the grounds that nothing in the
 * range killed anything with a name worth feeding. It exists now, and it is the *model*
 * only: it turns `entity.killed` — which carries entity ids — into lines that carry names
 * and teams, emits one `killfeed.entry` per line, and keeps the last few so the debug
 * overlay can show the event log S7 asks for.
 *
 * Drawing is `ui/Killfeed.ts`'s job. The split matters because the harness runs whole
 * matches with no DOM, and a killfeed that only existed as HTML would make "did the feed
 * get the right names" a question you could only answer by looking.
 */

const FEED_HISTORY = 32;

export interface KillfeedLine {
  killerId: number;
  victimId: number;
  killerName: string;
  victimName: string;
  killerTeam: 'A' | 'B' | 'NONE';
  victimTeam: 'A' | 'B' | 'NONE';
  weaponId: string;
  zone: HitZone;
  headshot: boolean;
  suicide: boolean;
  involvesLocal: boolean;
  /** Sim tick the kill landed on, so the debug log is ordered by game time. */
  tick: number;
}

function makeLine(): KillfeedLine {
  return {
    killerId: -1,
    victimId: -1,
    killerName: '',
    victimName: '',
    killerTeam: 'NONE',
    victimTeam: 'NONE',
    weaponId: '',
    zone: 'torso',
    headshot: false,
    suicide: false,
    involvesLocal: false,
    tick: 0,
  };
}

const evEntry = {
  killerName: '',
  victimName: '',
  killerTeam: 'NONE' as 'A' | 'B' | 'NONE',
  victimTeam: 'NONE' as 'A' | 'B' | 'NONE',
  weaponId: '',
  headshot: false,
  suicide: false,
  involvesLocal: false,
};

export class Killfeed {
  /** Ring of the most recent lines, newest last. Preallocated; never grows. */
  private readonly ring: KillfeedLine[] = [];
  private writeAt = 0;
  private written = 0;

  constructor(
    private readonly bus: GameBus,
    private readonly roster: readonly Combatant[],
  ) {
    for (let i = 0; i < FEED_HISTORY; i++) this.ring.push(makeLine());
  }

  get count(): number {
    return Math.min(this.written, FEED_HISTORY);
  }

  /** Lines newest-first. Index 0 is the most recent kill. */
  at(index: number): KillfeedLine | undefined {
    if (index >= this.count) return undefined;
    const slot = (this.writeAt - 1 - index + FEED_HISTORY * 2) % FEED_HISTORY;
    return this.ring[slot];
  }

  /**
   * Record a kill and publish the line.
   *
   * Called by `MatchFlow` rather than by a subscription of its own: the flow already
   * resolves the killer and victim against the roster to build its `KillEvent`, and doing
   * it twice would be two places that can disagree about who shot whom.
   */
  push(
    killerId: number,
    victimId: number,
    weaponId: string,
    zone: HitZone,
    tick: number,
  ): void {
    const slot = this.ring[this.writeAt];
    if (slot === undefined) return;
    const killer = this.find(killerId);
    const victim = this.find(victimId);

    slot.killerId = killerId;
    slot.victimId = victimId;
    slot.killerName = killer?.displayName ?? 'WORLD';
    slot.victimName = victim?.displayName ?? 'UNKNOWN';
    slot.killerTeam = killer?.team ?? 'NONE';
    slot.victimTeam = victim?.team ?? 'NONE';
    slot.weaponId = weaponId;
    slot.zone = zone;
    slot.headshot = zone === 'head';
    slot.suicide = killerId === victimId || killer === undefined;
    slot.involvesLocal = killerId === PLAYER_ENTITY_ID || victimId === PLAYER_ENTITY_ID;
    slot.tick = tick;

    this.writeAt = (this.writeAt + 1) % FEED_HISTORY;
    this.written++;

    evEntry.killerName = slot.killerName;
    evEntry.victimName = slot.victimName;
    evEntry.killerTeam = slot.killerTeam;
    evEntry.victimTeam = slot.victimTeam;
    evEntry.weaponId = slot.weaponId;
    evEntry.headshot = slot.headshot;
    evEntry.suicide = slot.suicide;
    evEntry.involvesLocal = slot.involvesLocal;
    this.bus.emit(EV.KillfeedEntry, evEntry);
  }

  reset(): void {
    this.writeAt = 0;
    this.written = 0;
  }

  private find(entityId: number): Combatant | undefined {
    for (const c of this.roster) {
      if (c.entityId === entityId) return c;
    }
    return undefined;
  }
}
