import type { ScoreTeam } from '../combat/ScoreSystem';

/**
 * Colour is a function of (viewer's team, subject's team) — never of the team id alone
 * (playtest round 4, B12).
 *
 * ## The report, and why the palette was not the bug
 *
 * *"In multiplayer I can end up on the red side, which is confusing because red normally means
 * enemy."* `ui/Palette.ts` has been right since M8: it exposes `friendly` and `hostile` and has
 * no concept of a team A colour or a team B colour, in any of its three colourblind modes.
 * There is no absolute team colour in it to leak.
 *
 * The leak was one level up, in the three surfaces that *chose* which of the two to ask for:
 *
 *   Scoreboard.ts    `team === 'A' ? 'friendly' : 'hostile'`, and `'ALLIES' : 'AXIS'`
 *   Killfeed.ts      `team === 'A' ? '…--friendly' : '…--hostile'`
 *   HudBanner.ts     slot A built with `--friendly`, slot B with `--hostile`, at construction
 *
 * Each is correct for the player the game was built by, who is entity 1 and therefore team A.
 * `Match.smallerTeam` sends the **second human to join** to team B, and from that seat the
 * scoreboard paints your own side hostile red and labels it AXIS, the killfeed paints your
 * team-mates as enemies, and the banner shows your score in the enemy's colour. Everything the
 * report describes, from one expression written three times.
 *
 * ## Why a type rather than a comment
 *
 * The brief asked for enforcement by types if it could be had, on the grounds that a rule three
 * files broke identically is a rule the fourth file will break too. So the only way to obtain a
 * colour class in this codebase is now `relationClass`, and the only way to obtain a
 * `TeamRelation` to hand it is `relationTo(viewer, subject)`. A raw `ScoreTeam` will not
 * type-check anywhere a colour is chosen, so the broken expression can no longer be written:
 * there is nothing for `team === 'A' ? …` to return that a caller can use.
 *
 * That is stronger than an audit, and the audit agrees with it — after this change `grep` finds
 * no `=== 'A'` in `client/ui` at all.
 *
 * ## Free-for-All
 *
 * FFA keeps the two-team substrate deliberately (see `modes/FreeForAll.ts`), so half of every
 * lobby shares a `ScoreTeam` with any given player and none of them is a team-mate. Post-M8
 * closed that seam in the minimap and the gunfire ping and left the killfeed inside it. Passing
 * `freeForAll` here closes it in the same place as everything else: with no teams, nobody is
 * friendly and the viewer's own line is the only one that is not hostile.
 */
export type TeamRelation = 'FRIENDLY' | 'HOSTILE' | 'NEUTRAL';

/** The three suffixes the stylesheets are keyed on. One per relation, and no other source. */
export type RelationClass = 'friendly' | 'hostile' | 'neutral';

export interface ViewerContext {
  /** The side the server put this client on. */
  readonly team: ScoreTeam;
  /** No teams: everybody but the viewer is hostile. */
  readonly freeForAll: boolean;
}

/**
 * What `subject` is to `viewer`.
 *
 * `'NONE'` is a real subject, not a missing one — a world kill, a neutral flag, the killfeed's
 * entry for somebody who fell — and it is the reason this returns three values rather than a
 * boolean. A boolean would have forced every caller to invent what to do with the third case,
 * which is how `hud-feed__name--neutral` came to exist beside an absolute two-way test.
 */
export function relationTo(viewer: ViewerContext, subject: ScoreTeam | 'NONE'): TeamRelation {
  if (subject === 'NONE') return 'NEUTRAL';
  if (viewer.freeForAll) return 'HOSTILE';
  return subject === viewer.team ? 'FRIENDLY' : 'HOSTILE';
}

/**
 * The relation of a subject who is the viewer themselves.
 *
 * Separate from `relationTo` because in Free-for-All the viewer's own row must not come back
 * `HOSTILE`, and the substrate side cannot distinguish it — every FFA opponent that shares the
 * viewer's `ScoreTeam` would answer identically. Callers that know they are painting the local
 * player's own line use this; everybody else uses `relationTo`.
 */
export function relationToSelf(): TeamRelation {
  return 'FRIENDLY';
}

/** The stylesheet suffix for a relation. The only door from a relation to a colour. */
export function relationClass(relation: TeamRelation): RelationClass {
  switch (relation) {
    case 'FRIENDLY':
      return 'friendly';
    case 'HOSTILE':
      return 'hostile';
    case 'NEUTRAL':
      return 'neutral';
  }
}

/**
 * The two team blocks in reading order: the viewer's side first.
 *
 * The scoreboard and the score banner are both two fixed slots, and B12 is as much about
 * *position* as about colour — a player on team B was reading their own score on the right, in
 * red, under a heading that said AXIS. Ordering by relation puts your side on the left and
 * green in every seat, which is the whole of what the report asks for.
 *
 * In Free-for-All the order is still viewer-first, and the banner relabels both slots anyway
 * (leader on the left, you on the right), so this decides nothing there.
 */
export function teamsInViewOrder(viewer: ViewerContext): readonly [ScoreTeam, ScoreTeam] {
  return viewer.team === 'A' ? ['A', 'B'] : ['B', 'A'];
}

/**
 * What a team block is called, from this viewer's seat.
 *
 * `ALLIES` and `AXIS` were the absolute pair, and they carry the same defect the colours did:
 * a player on team B was told they were the Axis in every match they happened to be seated
 * into. They are relative now, which is also what every game this one is modelled on does.
 */
export function teamLabel(relation: TeamRelation): string {
  switch (relation) {
    case 'FRIENDLY':
      return 'ALLIES';
    case 'HOSTILE':
      return 'AXIS';
    case 'NEUTRAL':
      return 'NEUTRAL';
  }
}
