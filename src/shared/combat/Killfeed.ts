import type { Combatant } from '../ai/Combatant';
import { EV, type GameBus } from '../core/Events';
import { LocalIdentity } from './LocalIdentity';
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

/**
 * Names and teams for entity ids (M10, playtest round 2).
 *
 * The feed used to hold a `readonly Combatant[]` directly, which was right while the only
 * roster was the local one. On a dedicated server the client's roster is **empty** — the bots
 * live in the server process and the other humans are `RemoteActor`s rebuilt from snapshots —
 * so every lookup missed and every line read `WORLD killed UNKNOWN`. It did not crash and it
 * did not warn; it just quietly stopped naming anybody.
 *
 * Narrowing the dependency to the two questions actually asked is what lets a snapshot-backed
 * directory satisfy it without a `RemoteActor` having to become a `Combatant` — which would
 * mean giving a body drawn from interpolated poses a health pool and a damage handler it has
 * no business owning.
 */
export interface CombatantDirectory {
  /** Display name, or null when this id is not known here. */
  nameOf(entityId: number): string | null;
  teamOf(entityId: number): 'A' | 'B' | null;
}

/** The local roster as a directory. The single-player and server-side path, unchanged. */
export function rosterDirectory(roster: readonly Combatant[]): CombatantDirectory {
  return {
    nameOf(entityId) {
      for (const c of roster) if (c.entityId === entityId) return c.displayName;
      return null;
    },
    teamOf(entityId) {
      for (const c of roster) if (c.entityId === entityId) return c.team;
      return null;
    },
  };
}

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

  private directory: CombatantDirectory;

  constructor(
    private readonly bus: GameBus,
    roster: readonly Combatant[] | CombatantDirectory,
    private readonly identity: LocalIdentity = new LocalIdentity(),
  ) {
    this.directory = Array.isArray(roster) ? rosterDirectory(roster) : (roster as CombatantDirectory);
    for (let i = 0; i < FEED_HISTORY; i++) this.ring.push(makeLine());
  }

  /**
   * Swap the name source. Used when a match becomes networked and the bodies stop being local.
   */
  setDirectory(directory: CombatantDirectory): void {
    this.directory = directory;
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
    const killerName = this.directory.nameOf(killerId);
    const victimName = this.directory.nameOf(victimId);

    slot.killerId = killerId;
    slot.victimId = victimId;
    slot.killerName = killerName ?? 'WORLD';
    slot.victimName = victimName ?? 'UNKNOWN';
    slot.killerTeam = this.directory.teamOf(killerId) ?? 'NONE';
    slot.victimTeam = this.directory.teamOf(victimId) ?? 'NONE';
    slot.weaponId = weaponId;
    slot.zone = zone;
    slot.headshot = zone === 'head';
    slot.suicide = killerId === victimId || killerName === null;
    slot.involvesLocal = this.identity.is(killerId) || this.identity.is(victimId);
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

}
