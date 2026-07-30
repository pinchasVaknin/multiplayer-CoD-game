/**
 * Viewmodel proportions, one record per weapon (brief S2: zero external assets).
 *
 * M2 built the AR out of hand-placed primitives. Twelve hand-placed weapons would be
 * twelve files of coordinates that all drift apart, so the geometry became a *function* of
 * the numbers below and the numbers became the content. Every silhouette difference a
 * player can see — barrel length, receiver bulk, magazine shape, stock, optic, bipod, pump
 * — is one field here.
 *
 * The numbers are metres in viewmodel space, where the receiver's centre is the origin and
 * the barrel runs down -Z. They are chosen against each other rather than against reality:
 * what matters is that the LMG reads as heavier than the SMG at a glance, in the lower
 * right corner of a screen, while both are moving.
 */

export type StockKind = 'full' | 'folding' | 'skeleton' | 'none';
export type MagazineKind = 'curved' | 'box' | 'drum' | 'tube' | 'grip';
export type OpticKind = 'irons' | 'reddot' | 'scope';

export interface WeaponModelSpec {
  /** Receiver: the block everything else hangs off. */
  readonly receiverLength: number;
  readonly receiverHeight: number;
  readonly receiverWidth: number;

  /** Handguard, forward of the receiver. */
  readonly handguardLength: number;
  readonly handguardHeight: number;

  /** Exposed barrel beyond the handguard, and how thick it is. */
  readonly barrelLength: number;
  readonly barrelRadius: number;
  /** Flash hider / muzzle brake radius. Bigger reads as bigger calibre. */
  readonly muzzleRadius: number;
  readonly muzzleLength: number;

  readonly stock: StockKind;
  readonly stockLength: number;
  readonly magazine: MagazineKind;
  readonly magazineLength: number;

  readonly optic: OpticKind;
  /** Scope tube length. Ignored unless `optic` is `scope`. */
  readonly opticLength: number;
  /** Height of the sight line above the origin. `ViewmodelConfig.adsY` cancels this. */
  readonly sightHeight: number;

  readonly bipod: boolean;
  /** A pump-action fore-end that slides on the reload. */
  readonly pump: boolean;
  /** Overall scale. The pistol is the only weapon that is genuinely a different size. */
  readonly scale: number;

  /**
   * Per-weapon correction to the shared ADS pose, metres.
   *
   * `ViewmodelConfig.adsY` / `adsZ` are one pose for twelve weapons, and the sight-height
   * compensation already handles the vertical difference — but it puts the *sight line* on
   * the screen centre without saying anything about how much of the screen the rest of the
   * weapon takes. A short weapon aimed at the same distance as a long one has its body and
   * its hands much closer to the eye.
   *
   * Negative pushes the weapon further away. Zero on everything except the pistol.
   *
   * Z only, deliberately. A vertical correction was tried first and it moves the *sights*
   * off the screen centre — the sight-height compensation in `ViewmodelAnim` has already
   * put the sight line on the camera axis, and anything further in Y breaks the one thing
   * ADS has to get right. Moving along Z leaves the axis alone.
   */
  readonly adsOffsetZ: number;
}

const AR_BASE: WeaponModelSpec = {
  receiverLength: 0.3,
  receiverHeight: 0.082,
  receiverWidth: 0.058,
  handguardLength: 0.25,
  handguardHeight: 0.062,
  barrelLength: 0.2,
  barrelRadius: 0.0105,
  muzzleRadius: 0.017,
  muzzleLength: 0.052,
  stock: 'full',
  stockLength: 0.16,
  magazine: 'curved',
  magazineLength: 0.155,
  optic: 'irons',
  opticLength: 0,
  sightHeight: 0.0915,
  bipod: false,
  pump: false,
  scale: 1,
  adsOffsetZ: 0,
};

export const WEAPON_MODEL_SPECS: Readonly<Record<string, WeaponModelSpec>> = {
  // -- assault rifles ------------------------------------------------------
  ar_carbine: AR_BASE,
  /** Longer receiver, stubby handguard, a visibly fatter magazine: the AK read. */
  ar_vulcan: {
    ...AR_BASE,
    receiverLength: 0.33,
    receiverHeight: 0.09,
    handguardLength: 0.2,
    barrelLength: 0.24,
    barrelRadius: 0.0122,
    muzzleRadius: 0.021,
    magazineLength: 0.185,
    stockLength: 0.185,
  },
  /** Bullpup: no stock behind the receiver, magazine well far back, short overall. */
  ar_halcyon: {
    ...AR_BASE,
    receiverLength: 0.36,
    receiverHeight: 0.086,
    receiverWidth: 0.062,
    handguardLength: 0.16,
    barrelLength: 0.14,
    stock: 'none',
    stockLength: 0,
    magazine: 'box',
    magazineLength: 0.12,
    optic: 'reddot',
    sightHeight: 0.098,
  },
  /** Long, thin, scoped: reads as a marksman rifle from across the screen. */
  ar_longbow: {
    ...AR_BASE,
    receiverLength: 0.34,
    handguardLength: 0.3,
    barrelLength: 0.3,
    barrelRadius: 0.0115,
    muzzleRadius: 0.019,
    magazineLength: 0.13,
    stock: 'skeleton',
    stockLength: 0.2,
    optic: 'scope',
    opticLength: 0.19,
    sightHeight: 0.106,
  },

  // -- SMGs ----------------------------------------------------------------
  smg_wasp: {
    ...AR_BASE,
    receiverLength: 0.22,
    receiverHeight: 0.07,
    receiverWidth: 0.05,
    handguardLength: 0.14,
    handguardHeight: 0.05,
    barrelLength: 0.08,
    barrelRadius: 0.008,
    muzzleRadius: 0.013,
    muzzleLength: 0.035,
    stock: 'folding',
    stockLength: 0.11,
    magazineLength: 0.14,
    optic: 'reddot',
    sightHeight: 0.085,
    scale: 0.94,
  },
  smg_meridian: {
    ...AR_BASE,
    receiverLength: 0.26,
    receiverHeight: 0.074,
    receiverWidth: 0.052,
    handguardLength: 0.17,
    handguardHeight: 0.054,
    barrelLength: 0.1,
    barrelRadius: 0.0085,
    muzzleRadius: 0.014,
    stock: 'skeleton',
    stockLength: 0.14,
    magazineLength: 0.18,
    optic: 'reddot',
    sightHeight: 0.088,
    scale: 0.97,
  },

  // -- shotgun -------------------------------------------------------------
  /** Tube magazine under the barrel and a sliding fore-end. Nothing else has either. */
  shotgun_breacher: {
    ...AR_BASE,
    receiverLength: 0.26,
    receiverHeight: 0.088,
    receiverWidth: 0.062,
    handguardLength: 0.24,
    handguardHeight: 0.055,
    barrelLength: 0.26,
    barrelRadius: 0.019,
    muzzleRadius: 0.023,
    muzzleLength: 0.03,
    stock: 'full',
    stockLength: 0.18,
    magazine: 'tube',
    magazineLength: 0.36,
    optic: 'irons',
    sightHeight: 0.094,
    pump: true,
  },

  // -- LMGs ----------------------------------------------------------------
  /** Drum, bipod, heavy barrel. Should look like it weighs something. */
  lmg_bastion: {
    ...AR_BASE,
    receiverLength: 0.4,
    receiverHeight: 0.1,
    receiverWidth: 0.072,
    handguardLength: 0.22,
    handguardHeight: 0.07,
    barrelLength: 0.34,
    barrelRadius: 0.015,
    muzzleRadius: 0.024,
    muzzleLength: 0.06,
    stock: 'full',
    stockLength: 0.2,
    magazine: 'drum',
    magazineLength: 0.2,
    optic: 'irons',
    sightHeight: 0.108,
    bipod: true,
    scale: 1.06,
  },
  lmg_monolith: {
    ...AR_BASE,
    receiverLength: 0.44,
    receiverHeight: 0.104,
    receiverWidth: 0.078,
    handguardLength: 0.26,
    handguardHeight: 0.072,
    barrelLength: 0.3,
    barrelRadius: 0.014,
    muzzleRadius: 0.022,
    muzzleLength: 0.055,
    stock: 'full',
    stockLength: 0.21,
    magazine: 'drum',
    magazineLength: 0.23,
    optic: 'reddot',
    sightHeight: 0.112,
    bipod: true,
    scale: 1.08,
  },

  // -- snipers -------------------------------------------------------------
  /** The longest barrel and the longest scope in the game. */
  sniper_kestrel: {
    ...AR_BASE,
    receiverLength: 0.36,
    receiverHeight: 0.086,
    receiverWidth: 0.056,
    handguardLength: 0.3,
    handguardHeight: 0.056,
    barrelLength: 0.42,
    barrelRadius: 0.013,
    muzzleRadius: 0.024,
    muzzleLength: 0.07,
    stock: 'skeleton',
    stockLength: 0.24,
    magazine: 'box',
    magazineLength: 0.09,
    optic: 'scope',
    opticLength: 0.28,
    sightHeight: 0.118,
    bipod: true,
    scale: 1.04,
  },
  sniper_vantage: {
    ...AR_BASE,
    receiverLength: 0.38,
    receiverHeight: 0.09,
    receiverWidth: 0.06,
    handguardLength: 0.26,
    handguardHeight: 0.06,
    barrelLength: 0.34,
    barrelRadius: 0.0125,
    muzzleRadius: 0.022,
    muzzleLength: 0.06,
    stock: 'full',
    stockLength: 0.2,
    magazine: 'curved',
    magazineLength: 0.15,
    optic: 'scope',
    opticLength: 0.23,
    sightHeight: 0.114,
    scale: 1.02,
  },

  // -- pistol --------------------------------------------------------------
  /**
   * No stock, no handguard, magazine in the grip. Genuinely a different size.
   *
   * The only weapon that needs an ADS correction. At the shared pose its receiver centre
   * sits where a rifle's does, which for a 0.17 m weapon puts the slide, the grip and both
   * hands far closer to the eye than any rifle's — reported in playtesting as the pistol
   * blocking the screen while aiming. Pushed 0.13 m further out; the sight
   * line is unaffected because the sight-height compensation puts it on the camera axis and
   * moving along that axis does not leave it. The other half of the fix is the two-handed
   * grip in `WeaponMeshParts` — a rifle's support forearm reached forward past the pistol's
   * muzzle and sat between the sights and the eye.
   */
  pistol_talon: {
    ...AR_BASE,
    adsOffsetZ: -0.13,
    receiverLength: 0.17,
    receiverHeight: 0.062,
    receiverWidth: 0.03,
    handguardLength: 0,
    handguardHeight: 0,
    barrelLength: 0.03,
    barrelRadius: 0.008,
    muzzleRadius: 0.009,
    muzzleLength: 0.012,
    stock: 'none',
    stockLength: 0,
    magazine: 'grip',
    magazineLength: 0.1,
    optic: 'irons',
    sightHeight: 0.042,
    scale: 1,
  },
};

/** Falls back to the carbine so a weapon added without a spec still draws something. */
export function modelSpecFor(weaponId: string): WeaponModelSpec {
  return WEAPON_MODEL_SPECS[weaponId] ?? AR_BASE;
}
