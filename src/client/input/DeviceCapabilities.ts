import type { DeviceCapabilities } from '../../shared/ui/Capabilities';

/**
 * Read what this browser says about its pointing devices (playtest round 5, F1).
 *
 * The whole DOM half of the capability gate, deliberately: everything that *decides* anything
 * lives in `shared/ui/Capabilities`, where the harness can run every case without a browser.
 * This is the adapter, and it is the only file in the feature that cannot be tested headlessly —
 * which is exactly the shape P0's verification split asks for.
 *
 * Every probe is defensive, and not out of habit. `matchMedia` is absent in some embedded
 * webviews and throws on a malformed query in older Safari; `navigator.maxTouchPoints` is
 * `undefined` rather than `0` on a few old Androids. A capability *detector* that throws is a
 * game that does not boot, which would be a worse bug than the one it is here to report — so a
 * probe that cannot answer is read as "no information" and the caller's rules decide.
 */

/** `true` when the query matches, `false` when it does not or cannot be asked. */
function media(query: string): boolean {
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

export function readDeviceCapabilities(): DeviceCapabilities {
  const touch = typeof navigator.maxTouchPoints === 'number' ? navigator.maxTouchPoints : 0;
  const fine = media('(pointer: fine)');
  const coarse = media('(pointer: coarse)');

  return {
    maxTouchPoints: touch,
    /**
     * `(pointer: fine)`, or "no pointer media query at all".
     *
     * The fallback is the important half. A browser too old for `matchMedia` is a browser from
     * before touch was common, and treating a missing query as *no mouse* would refuse a desktop
     * over a feature detection rather than over a device. Absent information reads as the
     * permissive answer here, because the failure it protects against — a phone — is exactly the
     * class of device that does support the query.
     */
    finePointer: fine || (!coarse && typeof window.matchMedia !== 'function'),
    coarsePointer: coarse,
    hasPointerLock: typeof Element.prototype.requestPointerLock === 'function',
  };
}
