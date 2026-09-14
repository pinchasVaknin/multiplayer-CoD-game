import { inputLabel, type ActionId, type BindingMap } from '../../shared/core/Keybinds';

/**
 * The controls card, built from the player's actual bindings (M8; moved off the main menu
 * into Settings → INFO by M15, A4).
 *
 * It used to be a hard-coded list, which was fine until S6.3 made every key reassignable —
 * at which point a card that still said "W A S D" for a player who had moved to the arrow
 * keys would be worse than no card at all. Each row names the actions it summarises and the
 * card resolves them through `Keybinds`, so it is correct by construction.
 *
 * The last three rows are chords and modifiers rather than single actions, so they are
 * composed from the bindings of their parts.
 *
 * It left the menu because the menu has no room for fourteen rows in the layout M15 gives it,
 * and because a reminder of the keys is a thing a player looks up, not a thing that greets
 * them: the reference screens put nothing of the kind on the front page. Nothing about how
 * the card is built changed with the address.
 */
const CONTROL_ROWS: readonly Readonly<{ actions: readonly ActionId[]; label: string }>[] = [
  { actions: ['moveForward', 'moveLeft', 'moveBack', 'moveRight'], label: 'Move' },
  { actions: ['sprint'], label: 'Sprint (double-tap for tactical)' },
  { actions: ['crouch'], label: 'Crouch (with sprint, slide)' },
  { actions: ['jump'], label: 'Jump / mantle' },
  { actions: ['fire'], label: 'Fire' },
  { actions: ['ads'], label: 'Aim down sights' },
  { actions: ['reload'], label: 'Reload' },
  { actions: ['swapWeapon', 'slot1', 'slot2'], label: 'Swap weapon' },
  { actions: ['lethal', 'tactical'], label: 'Lethal / tactical' },
  { actions: ['fieldUpgrade'], label: 'Field upgrade' },
  { actions: ['streak1', 'streak2', 'streak3'], label: 'Killstreaks' },
  { actions: ['use'], label: 'Use / plant / defuse' },
  { actions: ['scoreboard'], label: 'Scoreboard' },
];

/**
 * `Ctrl+W` closes a browser tab and no amount of `preventDefault` stops it; only the Keyboard
 * Lock API can, and only while the page is fullscreen. Saying so is better than letting a
 * player discover it mid-slide. See PLAN.md.
 */
export const FULLSCREEN_HINT = 'F11 for fullscreen — required to capture Ctrl+W (crouch + forward)';

/** The card: a `<dl>` of key combos and what they do, from the live binding table. */
export function buildKeyCard(bindings: BindingMap): HTMLElement {
  const keys = document.createElement('dl');
  keys.className = 'op-keys';
  for (const row of CONTROL_ROWS) {
    // Only the first binding of each action: the card is a reminder, not the bindings tab,
    // and a row reading "L Ctrl / C / L Shift" helps nobody.
    const combo = row.actions
      .map((id) => bindings[id]?.[0])
      .filter((input): input is string => input !== undefined)
      .map(inputLabel)
      .join(' ');
    if (combo === '') continue;
    const dt = document.createElement('dt');
    dt.textContent = combo;
    const dd = document.createElement('dd');
    dd.textContent = row.label;
    keys.append(dt, dd);
  }
  const esc = document.createElement('dt');
  esc.textContent = 'Esc';
  const escLabel = document.createElement('dd');
  escLabel.textContent = 'Pause';
  keys.append(esc, escLabel);
  return keys;
}
