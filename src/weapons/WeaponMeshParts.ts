import type { WeaponModelSpec } from './WeaponModelSpecs';

/**
 * Where every primitive goes, as a function of a `WeaponModelSpec`.
 *
 * Split out of `WeaponMesh.ts` under S3's size rule: that file is now the *assembly* — merge
 * by material, build the shared surfaces, hand back a `WeaponModel` — and this is the
 * layout. Twelve weapons' worth of proportions is content, and content and machinery had
 * grown into one 800-line file.
 *
 * Coordinates are metres in viewmodel space: +X right, +Y up, **-Z forward**, origin at the
 * centre of the receiver.
 */

export type SurfaceKey = 'gunmetal' | 'polymer' | 'glove';

export interface BoxPart {
  readonly surface: SurfaceKey;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
  readonly h: number;
  readonly d: number;
  readonly rx?: number;
  readonly ry?: number;
  readonly rz?: number;
}

export interface TubePart {
  readonly surface: SurfaceKey;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
  readonly length: number;
  readonly sides?: number;
  /** Runs along Z by default; set for a tube standing on Y. */
  readonly vertical?: boolean;
}

/** Height of the bore above the origin. Everything barrel-shaped hangs off this. */
export function barrelY(spec: WeaponModelSpec): number {
  return spec.receiverHeight * 0.13;
}

/** Front of the receiver. */
export function receiverFront(spec: WeaponModelSpec): number {
  return -spec.receiverLength * 0.5;
}

export function handguardEnd(spec: WeaponModelSpec): number {
  return receiverFront(spec) - spec.handguardLength;
}

export function muzzleZ(spec: WeaponModelSpec): number {
  return handguardEnd(spec) - spec.barrelLength - spec.muzzleLength * 0.5;
}

export function bodyBoxes(spec: WeaponModelSpec): BoxPart[] {
  const out: BoxPart[] = [];
  const by = barrelY(spec);
  const front = receiverFront(spec);
  const back = spec.receiverLength * 0.5;
  const hgEnd = handguardEnd(spec);

  // -- receiver ------------------------------------------------------------
  out.push({
    surface: 'gunmetal',
    x: 0,
    y: 0,
    z: 0,
    w: spec.receiverWidth,
    h: spec.receiverHeight,
    d: spec.receiverLength,
  });
  // Top rail. Every weapon has one; it is what the optic sits on.
  out.push({
    surface: 'gunmetal',
    x: 0,
    y: spec.receiverHeight * 0.6,
    z: -spec.receiverLength * 0.07,
    w: spec.receiverWidth * 0.62,
    h: spec.receiverHeight * 0.26,
    d: spec.receiverLength,
  });
  // Ejection port, so the receiver has a right-hand side you can read.
  out.push({
    surface: 'gunmetal',
    x: spec.receiverWidth * 0.53,
    y: spec.receiverHeight * 0.22,
    z: -spec.receiverLength * 0.15,
    w: 0.005,
    h: spec.receiverHeight * 0.36,
    d: spec.receiverLength * 0.24,
  });

  // -- handguard -----------------------------------------------------------
  if (spec.handguardLength > 0) {
    out.push({
      surface: 'polymer',
      x: 0,
      y: by,
      z: front - spec.handguardLength * 0.5,
      w: spec.receiverWidth * 0.96,
      h: spec.handguardHeight,
      d: spec.handguardLength,
    });
  }

  // -- grip and trigger guard ----------------------------------------------
  out.push({
    surface: 'polymer',
    x: 0,
    y: -spec.receiverHeight * 1.1,
    z: back * 0.5,
    w: spec.receiverWidth * 0.62,
    h: 0.12,
    d: 0.055,
    rx: -0.28,
  });
  out.push({
    surface: 'gunmetal',
    x: 0,
    y: -spec.receiverHeight * 0.58,
    z: back * 0.26,
    w: 0.008,
    h: 0.024,
    d: 0.01,
  });

  // -- stock ---------------------------------------------------------------
  switch (spec.stock) {
    case 'full':
      out.push({
        surface: 'polymer',
        x: 0,
        y: -spec.receiverHeight * 0.15,
        z: back + spec.stockLength * 0.5,
        w: spec.receiverWidth * 0.86,
        h: spec.receiverHeight * 1.15,
        d: spec.stockLength,
      });
      out.push({
        surface: 'polymer',
        x: 0,
        y: spec.receiverHeight * 0.37,
        z: back + spec.stockLength * 0.35,
        w: spec.receiverWidth * 0.62,
        h: spec.receiverHeight * 0.36,
        d: spec.stockLength * 0.7,
      });
      break;
    case 'skeleton':
      // Two rails and a cheek piece. Reads as lightweight rather than as missing.
      out.push({
        surface: 'gunmetal',
        x: 0,
        y: spec.receiverHeight * 0.3,
        z: back + spec.stockLength * 0.5,
        w: spec.receiverWidth * 0.5,
        h: 0.012,
        d: spec.stockLength,
      });
      out.push({
        surface: 'gunmetal',
        x: 0,
        y: -spec.receiverHeight * 0.35,
        z: back + spec.stockLength * 0.5,
        w: spec.receiverWidth * 0.5,
        h: 0.012,
        d: spec.stockLength,
      });
      out.push({
        surface: 'polymer',
        x: 0,
        y: 0,
        z: back + spec.stockLength * 0.95,
        w: spec.receiverWidth * 0.8,
        h: spec.receiverHeight * 1.2,
        d: 0.03,
      });
      break;
    case 'folding':
      // Folded along the right side of the receiver.
      out.push({
        surface: 'gunmetal',
        x: spec.receiverWidth * 0.66,
        y: spec.receiverHeight * 0.1,
        z: back * 0.2,
        w: 0.014,
        h: 0.028,
        d: spec.stockLength,
      });
      break;
    case 'none':
      break;
  }

  // -- optic ---------------------------------------------------------------
  const railY = spec.receiverHeight * 0.73;
  switch (spec.optic) {
    case 'irons':
      // Front post on the barrel end, rear notch over the receiver.
      out.push({
        surface: 'gunmetal',
        x: 0,
        y: railY + 0.006,
        z: hgEnd - 0.01,
        w: spec.receiverWidth * 0.5,
        h: 0.026,
        d: 0.03,
      });
      out.push({
        surface: 'gunmetal',
        x: 0,
        y: spec.sightHeight - 0.006,
        z: hgEnd - 0.01,
        w: 0.007,
        h: 0.03,
        d: 0.007,
      });
      out.push({
        surface: 'gunmetal',
        x: 0,
        y: railY,
        z: back * 0.45,
        w: spec.receiverWidth * 0.56,
        h: 0.02,
        d: 0.028,
      });
      out.push({
        surface: 'gunmetal',
        x: -0.0135,
        y: spec.sightHeight - 0.004,
        z: back * 0.45,
        w: 0.008,
        h: 0.026,
        d: 0.024,
      });
      out.push({
        surface: 'gunmetal',
        x: 0.0135,
        y: spec.sightHeight - 0.004,
        z: back * 0.45,
        w: 0.008,
        h: 0.026,
        d: 0.024,
      });
      break;
    case 'reddot':
      out.push({
        surface: 'gunmetal',
        x: 0,
        y: railY + 0.012,
        z: back * 0.2,
        w: 0.03,
        h: 0.026,
        d: 0.052,
      });
      out.push({
        surface: 'gunmetal',
        x: 0,
        y: spec.sightHeight,
        z: back * 0.2,
        w: 0.038,
        h: 0.036,
        d: 0.006,
      });
      break;
    case 'scope':
      // Two rings and a tube; the objective bell is the give-away at a glance.
      out.push({
        surface: 'gunmetal',
        x: 0,
        y: railY + 0.01,
        z: back * 0.25,
        w: 0.026,
        h: 0.022,
        d: 0.016,
      });
      out.push({
        surface: 'gunmetal',
        x: 0,
        y: railY + 0.01,
        z: back * 0.25 - spec.opticLength * 0.62,
        w: 0.026,
        h: 0.022,
        d: 0.016,
      });
      break;
  }

  // -- bipod ---------------------------------------------------------------
  if (spec.bipod) {
    const legZ = hgEnd + 0.03;
    for (const side of [-1, 1]) {
      out.push({
        surface: 'gunmetal',
        x: side * 0.026,
        y: by - 0.075,
        z: legZ,
        w: 0.008,
        h: 0.11,
        d: 0.008,
        rz: side * 0.34,
      });
    }
  }

  // -- hands ---------------------------------------------------------------
  // Grey-box, but a viewmodel with no hands reads as a floating prop.
  const supportZ = spec.handguardLength > 0 ? front - spec.handguardLength * 0.45 : front - 0.02;
  out.push({
    surface: 'glove',
    x: 0.006,
    y: -spec.receiverHeight * 0.88,
    z: back * 0.48,
    w: 0.058,
    h: 0.085,
    d: 0.088,
    rx: -0.28,
  });
  out.push({
    surface: 'glove',
    x: 0.036,
    y: -0.166,
    z: back * 0.48 + 0.124,
    w: 0.072,
    h: 0.078,
    d: 0.2,
    rx: -0.5,
  });
  out.push({
    surface: 'glove',
    x: 0,
    y: by - spec.handguardHeight * 0.62 - 0.006,
    z: supportZ,
    w: 0.064,
    h: 0.076,
    d: 0.1,
  });
  out.push({
    surface: 'glove',
    x: -0.056,
    y: by - 0.15,
    z: supportZ + 0.094,
    w: 0.076,
    h: 0.076,
    d: 0.19,
    rx: 0.42,
    rz: -0.5,
  });

  return out;
}

export function bodyTubes(spec: WeaponModelSpec): TubePart[] {
  const out: TubePart[] = [];
  const by = barrelY(spec);
  const hgEnd = handguardEnd(spec);

  if (spec.barrelLength > 0) {
    out.push({
      surface: 'gunmetal',
      x: 0,
      y: by,
      z: hgEnd - spec.barrelLength * 0.5,
      radius: spec.barrelRadius,
      length: spec.barrelLength,
    });
  }
  out.push({
    surface: 'gunmetal',
    x: 0,
    y: by,
    z: muzzleZ(spec),
    radius: spec.muzzleRadius,
    length: spec.muzzleLength,
    sides: 10,
  });

  if (spec.optic === 'scope') {
    out.push({
      surface: 'gunmetal',
      x: 0,
      y: spec.sightHeight,
      z: spec.receiverLength * 0.5 * 0.25 - spec.opticLength * 0.3,
      radius: 0.016,
      length: spec.opticLength,
      sides: 12,
    });
    // Objective bell.
    out.push({
      surface: 'gunmetal',
      x: 0,
      y: spec.sightHeight,
      z: spec.receiverLength * 0.5 * 0.25 - spec.opticLength * 0.85,
      radius: 0.024,
      length: spec.opticLength * 0.22,
      sides: 12,
    });
  }

  return out;
}

/** The magazine group. Animated independently, so it is built on its own. */
export function magazineBoxes(spec: WeaponModelSpec): BoxPart[] {
  const wellZ = spec.magazine === 'grip' ? spec.receiverLength * 0.24 : -spec.receiverLength * 0.04;
  switch (spec.magazine) {
    case 'curved':
      return [
        {
          surface: 'polymer',
          x: 0,
          y: -spec.receiverHeight * 0.55 - spec.magazineLength * 0.5,
          z: wellZ,
          w: 0.03,
          h: spec.magazineLength,
          d: 0.078,
          rx: 0.12,
        },
        {
          surface: 'polymer',
          x: 0,
          y: -spec.receiverHeight * 0.55 - spec.magazineLength - 0.006,
          z: wellZ + 0.01,
          w: 0.036,
          h: 0.014,
          d: 0.086,
          rx: 0.12,
        },
      ];
    case 'box':
      return [
        {
          surface: 'polymer',
          x: 0,
          y: -spec.receiverHeight * 0.55 - spec.magazineLength * 0.5,
          z: wellZ,
          w: 0.034,
          h: spec.magazineLength,
          d: 0.07,
        },
      ];
    case 'drum':
      // A drum is drawn as a wide flat box plus a cylinder below; the box is the housing.
      return [
        {
          surface: 'polymer',
          x: 0,
          y: -spec.receiverHeight * 0.55 - spec.magazineLength * 0.3,
          z: wellZ,
          w: 0.05,
          h: spec.magazineLength * 0.5,
          d: 0.09,
        },
      ];
    case 'tube':
      // The tube lives under the barrel, so there is no box.
      return [];
    case 'grip':
      // A pistol's magazine is the grip. Drawn as the grip's front face so the reload has
      // something visible to drop.
      return [
        {
          surface: 'polymer',
          x: 0,
          y: -spec.receiverHeight * 1.05,
          z: wellZ,
          w: spec.receiverWidth * 0.9,
          h: spec.magazineLength,
          d: 0.038,
          rx: -0.16,
        },
      ];
  }
}

export function magazineTubes(spec: WeaponModelSpec): TubePart[] {
  if (spec.magazine === 'drum') {
    return [
      {
        surface: 'polymer',
        x: 0,
        y: -spec.receiverHeight * 0.55 - spec.magazineLength * 0.85,
        z: -spec.receiverLength * 0.04,
        radius: spec.magazineLength * 0.42,
        length: 0.06,
        sides: 14,
      },
    ];
  }
  if (spec.magazine === 'tube') {
    return [
      {
        surface: 'gunmetal',
        x: 0,
        y: barrelY(spec) - spec.barrelRadius - 0.014,
        z: handguardEnd(spec) - spec.magazineLength * 0.5 + spec.handguardLength * 0.5,
        radius: 0.013,
        length: spec.magazineLength,
        sides: 10,
      },
    ];
  }
  return [];
}

/** The charging handle, or a shotgun's pump. Same group, different shape. */
export function chargingBoxes(spec: WeaponModelSpec): BoxPart[] {
  if (spec.pump) {
    return [
      {
        surface: 'polymer',
        x: 0,
        y: barrelY(spec) - 0.03,
        z: handguardEnd(spec) + spec.handguardLength * 0.35,
        w: spec.receiverWidth * 0.82,
        h: 0.048,
        d: spec.handguardLength * 0.55,
      },
    ];
  }
  const back = spec.receiverLength * 0.5;
  return [
    {
      surface: 'gunmetal',
      x: 0,
      y: spec.receiverHeight * 0.57,
      z: back * 0.92,
      w: spec.receiverWidth,
      h: 0.016,
      d: 0.03,
    },
    {
      surface: 'gunmetal',
      x: 0,
      y: spec.receiverHeight * 0.57,
      z: back * 0.78,
      w: 0.02,
      h: 0.012,
      d: 0.05,
    },
  ];
}
