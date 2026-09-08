import { ScoreSystem } from '../combat/ScoreSystem';
import { createGameBus } from '../core/Events';
import type { HeaderSlot } from '../modes/GameMode';
import { MAPS, MODES, modesForMap } from '../modes/ModeRegistry';

/**
 * What each mode puts in the header strip, and whether it is telling the truth (round 5, F8).
 *
 * F8 reported that in Domination *"which team holds A, B or C is readable only from the
 * minimap"*. The fix is a header slot the **mode** fills rather than flags the HUD knows how to
 * draw, so the thing worth testing is not a strip of DOM — it is that every mode's answer is a
 * pure function of its own state, that the modes with objectives produce a cell per objective,
 * and that the ones without produce nothing rather than a row of blanks.
 *
 * P12's verification asks for exactly that: *"the header model is a pure function of mode state,
 * tested per mode without a DOM."* Which is the whole reason the model is four plain fields on
 * `GameMode` and not a component.
 *
 * ## What each row asserts, and why the empty ones are the interesting ones
 *
 * A mode with no header must return `[]`, and that has to be checked rather than assumed,
 * because the base class's default is what produces it. If somebody makes `headerSlots` abstract
 * later — which was considered and rejected, see `GameMode.headerSlots` — Kill Confirmed and
 * Team Deathmatch would be forced to invent a cell, and a strip that is always on screen saying
 * nothing is worse than no strip. This audit is what would notice.
 *
 * Pure: a throwaway bus, score and mode per row, no clock, no wire, no DOM. One run is a fact.
 */

export interface HeaderRow {
  readonly modeId: string;
  readonly mapId: string;
  readonly slots: readonly HeaderSlot[];
  /** How many objective zones the mode holds, which the slot count has to match. */
  readonly zones: number;
}

export interface HeaderSlotAudit {
  readonly rows: readonly HeaderRow[];
  readonly problems: string[];
}

export function auditHeaderSlots(): HeaderSlotAudit {
  const rows: HeaderRow[] = [];
  const problems: string[] = [];

  for (const entry of MODES) {
    const map = MAPS.find((m) => modesForMap(m.id).some((mode) => mode.id === entry.id));
    if (map === undefined) continue;

    const bus = createGameBus();
    const score = new ScoreSystem(bus);
    const mode = entry.create({ bus, score, roster: [], mapDef: map.def });

    const slots = mode.headerSlots.map((s) => ({ ...s }));
    const zones = mode.objectiveZones.length;
    rows.push({ modeId: entry.id, mapId: map.id, slots, zones });

    /**
     * **A cell per objective zone. Exactly.**
     *
     * This rule was weaker on the first attempt — *"a cell per zone, or no cells at all"* — and
     * the red control is what found it. Blanking Domination's `headerSlots` left the audit
     * **green**: Domination fell into the "no cells at all" arm, Search & Destroy still filled
     * its two, and the vacuity guard below only fires when *every* mode is empty. An assertion
     * that passes on the exact bug it was written for is worth less than no assertion, because
     * it is also a claim that somebody has checked.
     *
     * The honest rule is the one sentence F8 is about: a mode that has objectives draws them.
     * Modes with no zones draw nothing and satisfy this by arithmetic, which is the default on
     * `GameMode` doing its job rather than an exemption carved out for it here.
     */
    if (slots.length !== zones) {
      problems.push(
        `${entry.id}: ${slots.length} header slot(s) against ${zones} objective zone(s). A mode ` +
          'draws one cell per objective — fewer is a flag the player cannot see, more is a cell ' +
          'about nothing.',
      );
    }

    for (const slot of slots) {
      if (slot.label === '') {
        problems.push(
          `${entry.id}: a header slot with no label. The letters come off the map's authored ` +
            'objectives, so an empty one means the mode built a cell for a zone that has no name.',
        );
      }
      if (slot.progress < 0 || slot.progress > 1) {
        problems.push(
          `${entry.id}: slot "${slot.label}" reports progress ${slot.progress}. The HUD draws ` +
            'this as a scaleX, so anything outside 0..1 is a fill escaping its cell.',
        );
      }
      /*
       * Progress belongs to somebody.
       *
       * A cell filling with `capturing: 'NONE'` would paint a neutral bar creeping across a flag
       * with nobody on it — which is exactly the picture a player would read as "this is being
       * taken" when it is not.
       */
      if (slot.progress > 0 && slot.capturing === 'NONE') {
        problems.push(
          `${entry.id}: slot "${slot.label}" is filling for nobody. Progress is always somebody's.`,
        );
      }
    }

    // Modes are constructed at rest, so nothing should be owned or filling before a tick.
    for (const slot of slots) {
      if (slot.owner !== 'NONE' || slot.progress !== 0) {
        problems.push(
          `${entry.id}: slot "${slot.label}" is already owned or filling on a mode nobody has ` +
            'played. A header at construction is a header describing a match that has not begun.',
        );
      }
    }

    score.dispose();
  }

  /*
   * The rig-liveness guard, and it is only that.
   *
   * With the rule above tightened this can no longer stand in for a real assertion — it exists
   * so a registry that stopped authoring objectives at all makes every row above vacuously true
   * and says so, rather than reporting six green zeroes.
   */
  if (rows.every((r) => r.zones === 0)) {
    problems.push(
      'no registered mode has an objective zone, so every row above is vacuously green. F8 is ' +
        'Domination; a run where nothing has objectives is measuring the registry, not the model.',
    );
  }

  return { rows, problems };
}
