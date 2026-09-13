import type { Rng } from '../../shared/core/Rng';
import {
  BOT_CHARACTER_IDS,
  DEFAULT_CHARACTER_ID,
  type CharacterId,
} from './CharacterCatalog';

/**
 * Match-scoped cosmetic assignment of skins to rendered actors.
 *
 * Each shuffled deck contains every eligible skin exactly once, so the first roster cycle is
 * visibly varied. The assignment is then retained by entity id for the remainder of the Match;
 * presentation never flickers or changes when a fallback avatar upgrades to its GLB.
 *
 * Not "bot": it deals to whatever `RenderableActor` the renderer asks about, and in a networked
 * match that includes the other humans. A player-chosen appearance will arrive as a replicated
 * `characterId` and override this at the composition root; until it does, everybody draws.
 *
 * Seeded, like every other draw in the client (S2 bans `Math.random`). The seed is the caller's
 * business — `Game` moves it per match, so consecutive matches deal different decks — and it is
 * what makes a given match's roster reproducible from the save rather than from luck. It remains
 * client-only: nothing in the simulation may read it, and separate multiplayer clients will not
 * agree on it until the server replicates the choice.
 */
export class RandomCharacterSelector {
  private readonly assignments = new Map<number, CharacterId>();
  private deck: CharacterId[] = [];

  constructor(private readonly rng: Rng) {}

  characterIdFor(entityId: number): CharacterId {
    const existing = this.assignments.get(entityId);
    if (existing !== undefined) return existing;

    if (this.deck.length === 0) this.deck = shuffledCharacterIds(this.rng);
    const id = this.deck.pop() ?? DEFAULT_CHARACTER_ID;
    this.assignments.set(entityId, id);
    return id;
  }
}

/** Fisher–Yates over the eligible catalog. */
function shuffledCharacterIds(rng: Rng): CharacterId[] {
  const ids = [...BOT_CHARACTER_IDS];
  for (let index = ids.length - 1; index > 0; index--) {
    const other = rng.int(0, index + 1);
    [ids[index], ids[other]] = [ids[other]!, ids[index]!];
  }
  return ids;
}
