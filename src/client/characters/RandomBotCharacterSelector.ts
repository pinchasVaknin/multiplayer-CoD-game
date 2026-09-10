import {
  BOT_CHARACTER_IDS,
  DEFAULT_CHARACTER_ID,
  type CharacterId,
} from './CharacterCatalog';

/**
 * Match-scoped cosmetic assignment for bots.
 *
 * Each shuffled deck contains every eligible skin exactly once, so the first
 * roster cycle is visibly varied. The assignment is then retained by entity id
 * for the remainder of the Match; presentation never flickers or changes when
 * a fallback avatar upgrades to its GLB.
 *
 * This is intentionally client-only and nondeterministic. It must not be used
 * for simulation decisions or for player-selected cosmetics that need to agree
 * between multiplayer clients.
 */
export class RandomBotCharacterSelector {
  private readonly assignments = new Map<number, CharacterId>();
  private deck: CharacterId[] = [];

  constructor(private readonly random: () => number = Math.random) {}

  characterIdFor(entityId: number): CharacterId {
    const existing = this.assignments.get(entityId);
    if (existing !== undefined) return existing;

    if (this.deck.length === 0) this.deck = shuffledCharacterIds(this.random);
    const id = this.deck.pop() ?? DEFAULT_CHARACTER_ID;
    this.assignments.set(entityId, id);
    return id;
  }
}

function shuffledCharacterIds(random: () => number): CharacterId[] {
  const ids = [...BOT_CHARACTER_IDS];
  for (let index = ids.length - 1; index > 0; index--) {
    const other = randomIndex(random(), index + 1);
    [ids[index], ids[other]] = [ids[other]!, ids[index]!];
  }
  return ids;
}

function randomIndex(value: number, upperExclusive: number): number {
  // A custom test source may accidentally return its inclusive upper bound.
  // Clamp it before flooring so it never produces an invalid deck index.
  const normalized = Math.min(Math.max(value, 0), 1 - Number.EPSILON);
  return Math.floor(normalized * upperExclusive);
}
