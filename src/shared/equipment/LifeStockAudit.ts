/**
 * What every life started holding (M11 Gate B, playtest round 4, B3).
 *
 * The report said grenades do not come back after a death "in certain modes". A count of
 * throws could not answer that and neither could a count of refills: both measure the thing
 * that was called rather than the thing the player woke up with. So this samples the **stock
 * at the moment a life starts** — every life, every combatant, human and bot — and counts the
 * ones that began with less than a full slot.
 *
 * `partialStock` is the number the session is about, and it must be zero. `lifeStarts` is its
 * denominator and matters just as much: zero partial stocks out of zero lives is what a probe
 * that never fired looks like, and this milestone has already shipped three of those.
 *
 * Deliberately told the full count rather than working it out. What a slot holds when it is
 * full is a fact about a loadout — a class's grenade, a bot's fixed pair — and a probe that
 * re-derived it would be a second opinion about the thing it is auditing.
 */

/** Who the life belonged to. Split because they refill through different doors. */
export type LifeStockOwner = 'human' | 'bot';

export interface LifeStockReport {
  /** Lives observed. The denominator: a zero here makes every other number meaningless. */
  lifeStarts: number;
  humanLifeStarts: number;
  botLifeStarts: number;
  /**
   * Lives that began holding less than a full slot. **Must be 0.**
   *
   * One life counted once however many slots were short, so this reads as "how many players
   * were let down" rather than "how many slots were".
   */
  partialStock: number;
  /** Of those, how many were short a lethal, and how many a tactical. */
  partialLethal: number;
  partialTactical: number;
  /** Lives that began with nothing at all in either slot. A subset of `partialStock`. */
  emptyStock: number;
  /** Grenades a life started with, against `expectedStock` — the same lives, priced full. */
  observedStock: number;
  expectedStock: number;
}

export class LifeStockAudit {
  private readonly totals = blankStockReport();

  /**
   * One life started. `lethal`/`tactical` are what it holds; `lethalFull`/`tacticalFull` what
   * a full one holds.
   */
  note(
    owner: LifeStockOwner,
    lethal: number,
    lethalFull: number,
    tactical: number,
    tacticalFull: number,
  ): void {
    const t = this.totals;
    t.lifeStarts++;
    if (owner === 'human') t.humanLifeStarts++;
    else t.botLifeStarts++;

    t.observedStock += lethal + tactical;
    t.expectedStock += lethalFull + tacticalFull;

    const shortLethal = lethal < lethalFull;
    const shortTactical = tactical < tacticalFull;
    if (shortLethal) t.partialLethal++;
    if (shortTactical) t.partialTactical++;
    if (shortLethal || shortTactical) t.partialStock++;
    if (lethal <= 0 && tactical <= 0) t.emptyStock++;
  }

  report(): LifeStockReport {
    return { ...this.totals };
  }
}

function blankStockReport(): LifeStockReport {
  return {
    lifeStarts: 0,
    humanLifeStarts: 0,
    botLifeStarts: 0,
    partialStock: 0,
    partialLethal: 0,
    partialTactical: 0,
    emptyStock: 0,
    observedStock: 0,
    expectedStock: 0,
  };
}
