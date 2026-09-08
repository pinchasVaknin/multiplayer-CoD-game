import { aimWarning, playability, type DeviceCapabilities } from '../ui/Capabilities';

/**
 * Whether the game says what it needs, and whether it says when it cannot be played (round 5).
 *
 * **B8**: pointer lock is refused, `Input` writes a console line, and the match runs on
 * unaimable — full HUD, running clock, nothing on screen. **F1**: no touch input exists anywhere
 * in the client, and yet a phone loads the menu, is shown a table of keyboard bindings and a
 * note about F11, and can start a match. One missing step twice: the game never asks whether it
 * can be played here, and never says so when it cannot.
 *
 * P6's verification asks for exactly this — *"the capability predicates are pure functions of
 * `navigator`/`document` state and are tested as such, without a DOM"* — and that is the whole
 * design of `shared/ui/Capabilities`: the DOM half is one adapter that fills a record in, and
 * everything that decides anything takes the record. So both rules are answerable over their
 * entire domain in a process with no browser, which is the half `HeadlessClient` can otherwise
 * never reach. It builds no DOM at all and has no pointer to lock, so the aim warning is
 * structurally silent in every harness run; this is where the rule is actually exercised.
 *
 * ## The domain is small enough to sweep completely
 *
 * The aim warning is a function of three booleans, so all **eight** combinations are run rather
 * than the two anybody would think to write. That is not thoroughness for its own sake: the
 * decision B8 turns on is that a refusal must **not** raise the banner while paused, and the
 * only way to state that as a fact rather than as an intention is to run the case where
 * `lockRefused` is true and `wantsPointerLock` is false and assert silence.
 */

export interface DeviceRow {
  readonly shape: string;
  readonly caps: DeviceCapabilities;
  readonly id: string;
  readonly ok: boolean;
}

export interface WarningRow {
  readonly wantsPointerLock: boolean;
  readonly pointerLocked: boolean;
  readonly lockRefused: boolean;
  readonly warns: boolean;
}

export interface CapabilityAudit {
  readonly devices: readonly DeviceRow[];
  readonly warnings: readonly WarningRow[];
  readonly problems: string[];
}

/** The four shapes that matter, and the one in the middle is the reason touch is not the test. */
const DEVICES: ReadonlyArray<{ shape: string; caps: DeviceCapabilities; want: string }> = [
  {
    shape: 'desktop',
    caps: { maxTouchPoints: 0, finePointer: true, coarsePointer: false, hasPointerLock: true },
    want: 'ok',
  },
  {
    /*
     * The row that decides the rule.
     *
     * A laptop with a touchscreen reports a non-zero `maxTouchPoints` and a coarse pointer
     * *alongside* a fine one, and it plays perfectly well. Gating on touch — which is the
     * obvious reading of F1's "no touch input exists" — would refuse it. The question is not
     * whether this device has a finger; it is whether it has something to aim with.
     */
    shape: 'touchscreen laptop',
    caps: { maxTouchPoints: 10, finePointer: true, coarsePointer: true, hasPointerLock: true },
    want: 'ok',
  },
  {
    shape: 'phone',
    caps: { maxTouchPoints: 5, finePointer: false, coarsePointer: true, hasPointerLock: false },
    want: 'no-pointer-lock',
  },
  {
    /*
     * A phone whose browser happens to expose the API. The lock test comes first, so this is
     * the row that proves the *second* rule is reachable at all — without it, `no-fine-pointer`
     * would be dead code that no case ever produced.
     */
    shape: 'tablet with pointer lock',
    caps: { maxTouchPoints: 5, finePointer: false, coarsePointer: true, hasPointerLock: true },
    want: 'no-fine-pointer',
  },
  {
    shape: 'desktop, no lock API',
    caps: { maxTouchPoints: 0, finePointer: true, coarsePointer: false, hasPointerLock: false },
    want: 'no-pointer-lock',
  },
];

export function auditCapabilities(): CapabilityAudit {
  const problems: string[] = [];

  const devices: DeviceRow[] = DEVICES.map((entry) => {
    const verdict = playability(entry.caps);
    if (verdict.id !== entry.want) {
      problems.push(
        `${entry.shape}: playability returned "${verdict.id}", expected "${entry.want}". ` +
          'The rule is a fine pointer and an API to lock it — touch is not a disqualifier, ' +
          'because a laptop with a trackpad and a touchscreen has both.',
      );
    }
    if (!verdict.ok && (verdict.headline === '' || verdict.detail === '')) {
      problems.push(
        `${entry.shape}: refused with an empty headline or detail. F1 asks for the honest ` +
          'version — a screen that says what the game needs — and a blank one is the silence ' +
          'it is replacing.',
      );
    }
    if (verdict.ok && verdict.headline !== '') {
      problems.push(`${entry.shape}: playable but carrying a headline. Nothing should be shown.`);
    }
    return { shape: entry.shape, caps: entry.caps, id: verdict.id, ok: verdict.ok };
  });

  // Every combination of the three booleans, so the "not while paused" case is run and not assumed.
  const warnings: WarningRow[] = [];
  for (const wantsPointerLock of [false, true]) {
    for (const pointerLocked of [false, true]) {
      for (const lockRefused of [false, true]) {
        const state = { wantsPointerLock, pointerLocked, lockRefused };
        const warns = aimWarning(state) !== '';
        warnings.push({ ...state, warns });

        const should = wantsPointerLock && !pointerLocked && lockRefused;
        if (warns !== should) {
          problems.push(
            `aim warning: wants=${wantsPointerLock} locked=${pointerLocked} ` +
              `refused=${lockRefused} gave ${warns}, expected ${should}.`,
          );
        }
      }
    }
  }

  /*
   * The three properties the decision rests on, asserted by name rather than left to be read
   * out of the table above. Each one is a sentence from the brief turned into a case.
   */
  if (aimWarning({ wantsPointerLock: false, pointerLocked: false, lockRefused: true }) !== '') {
    problems.push(
      'a refusal raised the banner with the lock disarmed. That is the pause screen: the cursor ' +
        'is released because the player asked, and B8 chose a banner precisely because it must ' +
        'not fire on the commonest path in the game.',
    );
  }
  if (aimWarning({ wantsPointerLock: true, pointerLocked: false, lockRefused: false }) !== '') {
    problems.push(
      'the banner fired on an in-flight request. The refusal term is what stops it flashing ' +
        'between arming and the lock landing, and it is evidence rather than a timer.',
    );
  }
  if (aimWarning({ wantsPointerLock: true, pointerLocked: true, lockRefused: true }) !== '') {
    problems.push(
      'the banner stayed up after the lock was acquired. A stale refusal is exactly what the ' +
        'old flag was, and clearing it on success rather than on the next attempt is the fix.',
    );
  }

  return { devices, warnings, problems };
}
