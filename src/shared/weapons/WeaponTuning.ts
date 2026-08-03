import type { TunableMeta } from '../player/MovementConfig';
import type { RecoilPattern, ScopeProfile, SpreadProfile, WeaponDef, WeaponVoice } from './WeaponDefs';

/**
 * The live tuning surface for a `WeaponDef` (brief S7).
 *
 * Split out of `WeaponDefs.ts` so the schema and the AR's data stay readable: the two
 * exhaustive switches below are most of this file, and they are machinery, not content.
 *
 * The point of the derivation is that it is checked in both directions. `WeaponNumberKey`
 * is computed *from* the schema, so a numeric field added to `WeaponDef` with no slider
 * metadata is a type error at `WEAPON_TUNABLES`, and a key that no accessor handles is a
 * type error at the switches. The panel cannot drift out of date with the weapon.
 */

/**
 * Keys of `T` whose value is a number.
 *
 * This is what makes the tuning panel compile-checked the same way M1's is: the key
 * union below is *derived* from the schema, so adding a numeric field to `WeaponDef`
 * without giving it slider metadata is a type error at `WEAPON_TUNABLES`, and failing
 * to wire it into the accessors is a type error at the exhaustive switches.
 */
type NumberKeysOf<T> = { [K in keyof T]-?: number extends T[K] ? K : never }[keyof T] & string;

type TopKey = Exclude<NumberKeysOf<WeaponDef>, 'projectileSpeed'>;
type DamageKey = `damage.${NumberKeysOf<WeaponDef['damage']>}`;
type FalloffKey = `falloff.${NumberKeysOf<WeaponDef['damageFalloff']>}`;
type SpreadKey = `spread.${NumberKeysOf<SpreadProfile>}`;
type RecoilKey = `recoil.${NumberKeysOf<RecoilPattern>}`;
type VoiceKey = `voice.${NumberKeysOf<WeaponVoice>}`;
/**
 * The scope's numbers are derived the same way, but from `ScopeProfile` directly rather
 * than through `WeaponDef` — `scope` is optional, so `NumberKeysOf<WeaponDef>` cannot see
 * inside it. Reading a scope key off an unscoped weapon returns 0 and writing one is a
 * no-op; `WeaponDebug` hides the whole group when `def.scope` is undefined rather than
 * showing sliders that do nothing.
 */
type ScopeKey = `scope.${NumberKeysOf<ScopeProfile>}`;

export type WeaponNumberKey =
  | TopKey
  | DamageKey
  | FalloffKey
  | SpreadKey
  | RecoilKey
  | VoiceKey
  | ScopeKey;

/** Keys that only mean anything on a weapon with a `scope`. */
export const SCOPE_KEY_PREFIX = 'scope.';

export const WEAPON_TUNABLES: Readonly<Record<WeaponNumberKey, TunableMeta>> = {
  'damage.near': { label: 'Near', group: 'Damage', min: 5, max: 120, step: 1, unit: '' },
  'damage.far': { label: 'Far', group: 'Damage', min: 5, max: 120, step: 1, unit: '' },
  'falloff.start': { label: 'Falloff start', group: 'Damage', min: 2, max: 80, step: 0.5, unit: 'm' },
  'falloff.end': { label: 'Falloff end', group: 'Damage', min: 4, max: 140, step: 0.5, unit: 'm' },
  headshotMult: { label: 'Headshot', group: 'Damage', min: 1, max: 4, step: 0.05, unit: 'x' },
  limbMult: { label: 'Limb', group: 'Damage', min: 0.4, max: 1.5, step: 0.05, unit: 'x' },
  upperTorsoMult: { label: 'Upper torso', group: 'Damage', min: 0.8, max: 2, step: 0.01, unit: 'x' },
  penetration: { label: 'Penetration', group: 'Damage', min: 0, max: 2, step: 0.01, unit: 'm' },
  pellets: { label: 'Pellets', group: 'Damage', min: 1, max: 16, step: 1, unit: '' },
  pelletSpread: { label: 'Pellet cone', group: 'Damage', min: 0, max: 10, step: 0.05, unit: '°' },

  rpm: { label: 'RPM', group: 'Handling', min: 60, max: 1400, step: 5, unit: '' },
  magSize: { label: 'Mag size', group: 'Handling', min: 1, max: 200, step: 1, unit: '' },
  reserveAmmo: { label: 'Reserve', group: 'Handling', min: 0, max: 600, step: 10, unit: '' },
  reloadTime: { label: 'Reload', group: 'Handling', min: 0.4, max: 6, step: 0.05, unit: 's' },
  reloadEmptyTime: { label: 'Reload empty', group: 'Handling', min: 0.4, max: 8, step: 0.05, unit: 's' },
  adsTime: { label: 'ADS time', group: 'Handling', min: 0.05, max: 1.2, step: 0.01, unit: 's' },
  sprintOutTime: { label: 'Sprint to fire', group: 'Handling', min: 0, max: 1, step: 0.01, unit: 's' },
  swapInTime: { label: 'Swap in', group: 'Handling', min: 0.1, max: 1.5, step: 0.01, unit: 's' },
  swapOutTime: { label: 'Swap out', group: 'Handling', min: 0.1, max: 1.5, step: 0.01, unit: 's' },

  'spread.hipStand': { label: 'Hip standing', group: 'Spread', min: 0, max: 8, step: 0.05, unit: '°' },
  'spread.hipMove': { label: 'Hip moving', group: 'Spread', min: 0, max: 12, step: 0.05, unit: '°' },
  'spread.ads': { label: 'ADS', group: 'Spread', min: 0, max: 3, step: 0.01, unit: '°' },
  'spread.crouchScale': { label: 'Crouch x', group: 'Spread', min: 0.2, max: 1.2, step: 0.01, unit: 'x' },
  'spread.airScale': { label: 'Airborne x', group: 'Spread', min: 1, max: 5, step: 0.05, unit: 'x' },
  'spread.perShot': { label: 'Bloom / shot', group: 'Spread', min: 0, max: 1, step: 0.005, unit: '°' },
  'spread.perShotMax': { label: 'Bloom cap', group: 'Spread', min: 0, max: 6, step: 0.05, unit: '°' },
  'spread.recover': { label: 'Bloom recover', group: 'Spread', min: 0.1, max: 20, step: 0.1, unit: '°/s' },

  'recoil.verticalScale': { label: 'Vertical x', group: 'Recoil', min: 0, max: 3, step: 0.02, unit: 'x' },
  'recoil.horizontalScale': { label: 'Lateral x', group: 'Recoil', min: 0, max: 3, step: 0.02, unit: 'x' },
  'recoil.firstShotScale': { label: 'First shot x', group: 'Recoil', min: 0.5, max: 3, step: 0.05, unit: 'x' },
  'recoil.recoverFraction': { label: 'Recovered', group: 'Recoil', min: 0, max: 1, step: 0.01, unit: '' },
  'recoil.recoverRate': { label: 'Recover rate', group: 'Recoil', min: 1, max: 30, step: 0.5, unit: '/s' },
  'recoil.recoverDelay': { label: 'Recover delay', group: 'Recoil', min: 0, max: 0.5, step: 0.01, unit: 's' },
  'recoil.adsScale': { label: 'ADS x', group: 'Recoil', min: 0.2, max: 1.5, step: 0.01, unit: 'x' },
  'recoil.visualScale': { label: 'Visual x', group: 'Recoil', min: 0, max: 4, step: 0.05, unit: 'x' },
  'recoil.visualAttack': { label: 'Visual attack', group: 'Recoil', min: 0.005, max: 0.2, step: 0.002, unit: 's' },
  'recoil.visualSettle': { label: 'Visual settle', group: 'Recoil', min: 0.02, max: 0.6, step: 0.005, unit: 's' },

  adsFovScale: { label: 'ADS world FOV', group: 'Optics', min: 0.4, max: 1, step: 0.01, unit: 'x' },
  adsViewmodelFovScale: { label: 'ADS vm FOV', group: 'Optics', min: 0.4, max: 1, step: 0.01, unit: 'x' },
  tracerFraction: { label: 'Tracer rate', group: 'Optics', min: 0, max: 1, step: 0.02, unit: '' },
  shakePerShot: { label: 'Shake / shot', group: 'Optics', min: 0, max: 0.4, step: 0.005, unit: '' },
  muzzleFlashScale: { label: 'Flash size', group: 'Optics', min: 0, max: 3, step: 0.05, unit: 'x' },
  unlockLevel: { label: 'Unlock level', group: 'Optics', min: 1, max: 55, step: 1, unit: '' },

  'voice.level': { label: 'Level', group: 'Voice', min: 0, max: 1.5, step: 0.02, unit: '' },
  'voice.bodyFreq': { label: 'Body freq', group: 'Voice', min: 200, max: 4000, step: 25, unit: 'Hz' },
  'voice.bodyQ': { label: 'Body Q', group: 'Voice', min: 0.2, max: 12, step: 0.05, unit: '' },
  'voice.bodyDecay': { label: 'Body decay', group: 'Voice', min: 0.02, max: 0.4, step: 0.005, unit: 's' },
  'voice.bodyRatio': { label: 'Body sweep', group: 'Voice', min: 0.08, max: 0.9, step: 0.01, unit: 'x' },
  'voice.tailDecay': { label: 'Tail decay', group: 'Voice', min: 0.05, max: 1.2, step: 0.01, unit: 's' },
  'voice.tailLevel': { label: 'Tail level', group: 'Voice', min: 0, max: 1, step: 0.01, unit: '' },
  'voice.tailFreq': { label: 'Tail cutoff', group: 'Voice', min: 600, max: 6000, step: 50, unit: 'Hz' },
  'voice.clickFreq': { label: 'Click freq', group: 'Voice', min: 1000, max: 12000, step: 100, unit: 'Hz' },
  'voice.clickLevel': { label: 'Click level', group: 'Voice', min: 0, max: 1.5, step: 0.02, unit: '' },
  'voice.thumpFreq': { label: 'Thump freq', group: 'Voice', min: 30, max: 300, step: 1, unit: 'Hz' },
  'voice.thumpLevel': { label: 'Thump level', group: 'Voice', min: 0, max: 1.5, step: 0.02, unit: '' },
  'voice.wet': { label: 'Reverb send', group: 'Voice', min: 0, max: 1, step: 0.01, unit: '' },

  'scope.swayDeg': { label: 'Sway', group: 'Scope', min: 0, max: 2, step: 0.01, unit: '°' },
  'scope.swayRate': { label: 'Breath rate', group: 'Scope', min: 0.1, max: 2, step: 0.01, unit: 'Hz' },
  'scope.breathSeconds': { label: 'Hold', group: 'Scope', min: 0.5, max: 8, step: 0.1, unit: 's' },
  'scope.breathRecovery': { label: 'Recover', group: 'Scope', min: 0.5, max: 12, step: 0.1, unit: 's' },
  'scope.breathHoldScale': { label: 'Held sway x', group: 'Scope', min: 0, max: 1, step: 0.01, unit: 'x' },
  'scope.magnification': { label: 'Magnification', group: 'Scope', min: 1, max: 10, step: 0.1, unit: 'x' },
};

export const WEAPON_NUMBER_KEYS = Object.keys(WEAPON_TUNABLES) as WeaponNumberKey[];

export function readWeaponNumber(def: WeaponDef, key: WeaponNumberKey): number {
  switch (key) {
    case 'damage.near':
      return def.damage.near;
    case 'damage.far':
      return def.damage.far;
    case 'falloff.start':
      return def.damageFalloff.start;
    case 'falloff.end':
      return def.damageFalloff.end;
    case 'headshotMult':
      return def.headshotMult;
    case 'limbMult':
      return def.limbMult;
    case 'upperTorsoMult':
      return def.upperTorsoMult;
    case 'penetration':
      return def.penetration;
    case 'pellets':
      return def.pellets;
    case 'pelletSpread':
      return def.pelletSpread;
    case 'rpm':
      return def.rpm;
    case 'magSize':
      return def.magSize;
    case 'reserveAmmo':
      return def.reserveAmmo;
    case 'reloadTime':
      return def.reloadTime;
    case 'reloadEmptyTime':
      return def.reloadEmptyTime;
    case 'adsTime':
      return def.adsTime;
    case 'sprintOutTime':
      return def.sprintOutTime;
    case 'swapInTime':
      return def.swapInTime;
    case 'swapOutTime':
      return def.swapOutTime;
    case 'spread.hipStand':
      return def.spread.hipStand;
    case 'spread.hipMove':
      return def.spread.hipMove;
    case 'spread.ads':
      return def.spread.ads;
    case 'spread.crouchScale':
      return def.spread.crouchScale;
    case 'spread.airScale':
      return def.spread.airScale;
    case 'spread.perShot':
      return def.spread.perShot;
    case 'spread.perShotMax':
      return def.spread.perShotMax;
    case 'spread.recover':
      return def.spread.recover;
    case 'recoil.verticalScale':
      return def.recoil.verticalScale;
    case 'recoil.horizontalScale':
      return def.recoil.horizontalScale;
    case 'recoil.firstShotScale':
      return def.recoil.firstShotScale;
    case 'recoil.recoverFraction':
      return def.recoil.recoverFraction;
    case 'recoil.recoverRate':
      return def.recoil.recoverRate;
    case 'recoil.recoverDelay':
      return def.recoil.recoverDelay;
    case 'recoil.adsScale':
      return def.recoil.adsScale;
    case 'recoil.visualScale':
      return def.recoil.visualScale;
    case 'recoil.visualAttack':
      return def.recoil.visualAttack;
    case 'recoil.visualSettle':
      return def.recoil.visualSettle;
    case 'adsFovScale':
      return def.adsFovScale;
    case 'adsViewmodelFovScale':
      return def.adsViewmodelFovScale;
    case 'tracerFraction':
      return def.tracerFraction;
    case 'shakePerShot':
      return def.shakePerShot;
    case 'muzzleFlashScale':
      return def.muzzleFlashScale;
    case 'unlockLevel':
      return def.unlockLevel;
    case 'voice.level':
      return def.voice.level;
    case 'voice.bodyFreq':
      return def.voice.bodyFreq;
    case 'voice.bodyQ':
      return def.voice.bodyQ;
    case 'voice.bodyDecay':
      return def.voice.bodyDecay;
    case 'voice.bodyRatio':
      return def.voice.bodyRatio;
    case 'voice.tailDecay':
      return def.voice.tailDecay;
    case 'voice.tailLevel':
      return def.voice.tailLevel;
    case 'voice.tailFreq':
      return def.voice.tailFreq;
    case 'voice.clickFreq':
      return def.voice.clickFreq;
    case 'voice.clickLevel':
      return def.voice.clickLevel;
    case 'voice.thumpFreq':
      return def.voice.thumpFreq;
    case 'voice.thumpLevel':
      return def.voice.thumpLevel;
    case 'voice.wet':
      return def.voice.wet;
    case 'scope.swayDeg':
      return def.scope?.swayDeg ?? 0;
    case 'scope.swayRate':
      return def.scope?.swayRate ?? 0;
    case 'scope.breathSeconds':
      return def.scope?.breathSeconds ?? 0;
    case 'scope.breathRecovery':
      return def.scope?.breathRecovery ?? 0;
    case 'scope.breathHoldScale':
      return def.scope?.breathHoldScale ?? 0;
    case 'scope.magnification':
      return def.scope?.magnification ?? 1;
  }
}

export function writeWeaponNumber(def: WeaponDef, key: WeaponNumberKey, v: number): void {
  switch (key) {
    case 'damage.near':
      def.damage.near = v;
      return;
    case 'damage.far':
      def.damage.far = v;
      return;
    case 'falloff.start':
      def.damageFalloff.start = v;
      return;
    case 'falloff.end':
      def.damageFalloff.end = v;
      return;
    case 'headshotMult':
      def.headshotMult = v;
      return;
    case 'limbMult':
      def.limbMult = v;
      return;
    case 'upperTorsoMult':
      def.upperTorsoMult = v;
      return;
    case 'penetration':
      def.penetration = v;
      return;
    case 'pellets':
      def.pellets = v;
      return;
    case 'pelletSpread':
      def.pelletSpread = v;
      return;
    case 'rpm':
      def.rpm = v;
      return;
    case 'magSize':
      def.magSize = v;
      return;
    case 'reserveAmmo':
      def.reserveAmmo = v;
      return;
    case 'reloadTime':
      def.reloadTime = v;
      return;
    case 'reloadEmptyTime':
      def.reloadEmptyTime = v;
      return;
    case 'adsTime':
      def.adsTime = v;
      return;
    case 'sprintOutTime':
      def.sprintOutTime = v;
      return;
    case 'swapInTime':
      def.swapInTime = v;
      return;
    case 'swapOutTime':
      def.swapOutTime = v;
      return;
    case 'spread.hipStand':
      def.spread.hipStand = v;
      return;
    case 'spread.hipMove':
      def.spread.hipMove = v;
      return;
    case 'spread.ads':
      def.spread.ads = v;
      return;
    case 'spread.crouchScale':
      def.spread.crouchScale = v;
      return;
    case 'spread.airScale':
      def.spread.airScale = v;
      return;
    case 'spread.perShot':
      def.spread.perShot = v;
      return;
    case 'spread.perShotMax':
      def.spread.perShotMax = v;
      return;
    case 'spread.recover':
      def.spread.recover = v;
      return;
    case 'recoil.verticalScale':
      def.recoil.verticalScale = v;
      return;
    case 'recoil.horizontalScale':
      def.recoil.horizontalScale = v;
      return;
    case 'recoil.firstShotScale':
      def.recoil.firstShotScale = v;
      return;
    case 'recoil.recoverFraction':
      def.recoil.recoverFraction = v;
      return;
    case 'recoil.recoverRate':
      def.recoil.recoverRate = v;
      return;
    case 'recoil.recoverDelay':
      def.recoil.recoverDelay = v;
      return;
    case 'recoil.adsScale':
      def.recoil.adsScale = v;
      return;
    case 'recoil.visualScale':
      def.recoil.visualScale = v;
      return;
    case 'recoil.visualAttack':
      def.recoil.visualAttack = v;
      return;
    case 'recoil.visualSettle':
      def.recoil.visualSettle = v;
      return;
    case 'adsFovScale':
      def.adsFovScale = v;
      return;
    case 'adsViewmodelFovScale':
      def.adsViewmodelFovScale = v;
      return;
    case 'tracerFraction':
      def.tracerFraction = v;
      return;
    case 'shakePerShot':
      def.shakePerShot = v;
      return;
    case 'muzzleFlashScale':
      def.muzzleFlashScale = v;
      return;
    case 'unlockLevel':
      def.unlockLevel = v;
      return;
    case 'voice.level':
      def.voice.level = v;
      return;
    case 'voice.bodyFreq':
      def.voice.bodyFreq = v;
      return;
    case 'voice.bodyQ':
      def.voice.bodyQ = v;
      return;
    case 'voice.bodyDecay':
      def.voice.bodyDecay = v;
      return;
    case 'voice.bodyRatio':
      def.voice.bodyRatio = v;
      return;
    case 'voice.tailDecay':
      def.voice.tailDecay = v;
      return;
    case 'voice.tailLevel':
      def.voice.tailLevel = v;
      return;
    case 'voice.tailFreq':
      def.voice.tailFreq = v;
      return;
    case 'voice.clickFreq':
      def.voice.clickFreq = v;
      return;
    case 'voice.clickLevel':
      def.voice.clickLevel = v;
      return;
    case 'voice.thumpFreq':
      def.voice.thumpFreq = v;
      return;
    case 'voice.thumpLevel':
      def.voice.thumpLevel = v;
      return;
    case 'voice.wet':
      def.voice.wet = v;
      return;
    // Writing a scope number on a weapon that has no scope is a no-op rather than an
    // error: the panel hides the group, but the copy-config path walks every key.
    case 'scope.swayDeg':
      if (def.scope !== undefined) def.scope.swayDeg = v;
      return;
    case 'scope.swayRate':
      if (def.scope !== undefined) def.scope.swayRate = v;
      return;
    case 'scope.breathSeconds':
      if (def.scope !== undefined) def.scope.breathSeconds = v;
      return;
    case 'scope.breathRecovery':
      if (def.scope !== undefined) def.scope.breathRecovery = v;
      return;
    case 'scope.breathHoldScale':
      if (def.scope !== undefined) def.scope.breathHoldScale = v;
      return;
    case 'scope.magnification':
      if (def.scope !== undefined) def.scope.magnification = v;
      return;
  }
}

/** Serialise a tuned weapon back into pasteable TypeScript source. */
export function weaponDefToSource(def: WeaponDef): string {
  const lines: string[] = [`// ${def.name} (${def.id}) — tuned values`, 'const tuned = {'];
  let lastGroup = '';
  for (const key of WEAPON_NUMBER_KEYS) {
    const meta = WEAPON_TUNABLES[key];
    // A pistol has no scope numbers to paste back.
    if (def.scope === undefined && key.startsWith(SCOPE_KEY_PREFIX)) continue;
    if (meta.group !== lastGroup) {
      if (lastGroup !== '') lines.push('');
      lines.push(`  // -- ${meta.group.toLowerCase()} --`);
      lastGroup = meta.group;
    }
    lines.push(`  '${key}': ${Math.round(readWeaponNumber(def, key) * 1e4) / 1e4},`);
  }
  lines.push('};');
  return lines.join('\n');
}
