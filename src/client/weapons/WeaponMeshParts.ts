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

/**
 * `lens` and `reticle` are M7's.
 *
 * A red dot's window used to be a `gunmetal` box sitting exactly on the sight line, which is
 * why the M6 playtest reported the SMG optic as "rendering opaque, blocking the target
 * entirely" — it was not a material bug, it was a solid plate across the aperture. The window
 * is glass now and the dot is its own emissive speck, which is the part you actually aim with.
 */
export type SurfaceKey = 'gunmetal' | 'polymer' | 'glove' | 'lens' | 'reticle';

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

/**
 * Centre of the trigger hand in unscaled weapon-local metres. Both the first-person gloves
 * and a third-person character socket use this, so a weapon's grip has one source of truth.
 */
export function triggerHandAnchor(spec: WeaponModelSpec): Readonly<{ x: number; y: number; z: number }> {
  const back = spec.receiverLength * 0.5;
  return {
    x: 0.006,
    y: -spec.receiverHeight * 0.88,
    z: back * 0.48,
  };
}

/**
 * Centre of the support palm in unscaled weapon-local metres. Third-person IK and the
 * first-person glove block deliberately share this datum, so one weapon cannot acquire two
 * incompatible handguard locations.
 */
export function supportHandAnchor(spec: WeaponModelSpec): Readonly<{ x: number; y: number; z: number }> {
  const back = spec.receiverLength * 0.5;
  if (spec.handguardLength <= 0) {
    return {
      x: -0.03,
      y: -spec.receiverHeight * 0.92,
      z: back * 0.42,
    };
  }

  return {
    x: 0,
    y: barrelY(spec) - spec.handguardHeight * 0.62 - 0.006,
    z: receiverFront(spec) - spec.handguardLength * 0.45,
  };
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
  //
  // Everything here is placed relative to `sightHeight` rather than to the rail (M7).
  //
  // The rail-relative version was authored against the AR's 0.082 m receiver with absolute
  // box sizes, and those sizes do not shrink with the weapon. On the pistol — receiver 0.062,
  // sight line 0.042 — the front and rear sight *bases* both ended up straddling the sight
  // line, so aiming meant looking into a solid block of gunmetal. That is the M6 playtest's
  // "pistol viewmodel obscuring the target"; the pose was a symptom, the geometry was the bug.
  //
  // Derived from the sight line, the aperture is clear on all twelve weapons by construction:
  // bases stop below it, posts straddle it and frame it, and only the front blade crosses it,
  // which is the one piece of metal you are supposed to be looking at.
  const railY = spec.receiverHeight * 0.73;
  const lineY = spec.sightHeight;
  switch (spec.optic) {
    case 'irons': {
      const baseTop = lineY - 0.008;
      const baseH = 0.014;
      const baseY = baseTop - baseH * 0.5;
      // Posts rise from the base and stop just past the line, so the notch reads as a notch.
      const postH = 0.012;
      const postY = baseTop + postH * 0.5;
      // The blade is the aiming reference and is allowed to reach the line.
      const bladeH = 0.011;
      const bladeY = baseTop + bladeH * 0.5;

      // Front sight: base and blade, on the barrel end.
      out.push({ surface: 'gunmetal', x: 0, y: baseY, z: hgEnd - 0.01, w: spec.receiverWidth * 0.5, h: baseH, d: 0.03 });
      out.push({ surface: 'gunmetal', x: 0, y: bladeY, z: hgEnd - 0.01, w: 0.007, h: bladeH, d: 0.007 });

      // Rear sight: base and the two notch posts, over the receiver.
      out.push({ surface: 'gunmetal', x: 0, y: baseY, z: back * 0.45, w: spec.receiverWidth * 0.56, h: baseH, d: 0.028 });
      for (const side of [-1, 1]) {
        const postX = Math.min(0.0135, spec.receiverWidth * 0.42);
        out.push({ surface: 'gunmetal', x: side * postX, y: postY, z: back * 0.45, w: 0.008, h: postH, d: 0.024 });
      }
      break;
    }
    case 'reddot': {
      const z = back * 0.2;
      // A U-shaped housing — floor, two walls, a hood — rather than one block. The block
      // *was* the window, and a solid window is the bug this rebuild exists to close.
      out.push({ surface: 'gunmetal', x: 0, y: lineY - 0.021, z, w: 0.036, h: 0.015, d: 0.052 });
      for (const side of [-1, 1]) {
        out.push({ surface: 'gunmetal', x: side * 0.019, y: lineY - 0.002, z, w: 0.006, h: 0.034, d: 0.05 });
      }
      out.push({ surface: 'gunmetal', x: 0, y: lineY + 0.017, z, w: 0.044, h: 0.005, d: 0.05 });
      // The glass, and the dot floating behind it on the sight line.
      out.push({ surface: 'lens', x: 0, y: lineY - 0.002, z: z - 0.021, w: 0.031, h: 0.032, d: 0.002 });
      out.push({ surface: 'reticle', x: 0, y: lineY, z: z - 0.024, w: 0.0032, h: 0.0032, d: 0.0012 });
      break;
    }
    case 'scope': {
      // Two rings and a tube; the objective bell is the give-away at a glance. The rings
      // now bridge the rail to the tube's underside rather than floating below it.
      const tubeBottom = lineY - 0.016;
      const ringH = Math.max(0.008, tubeBottom - railY);
      const ringY = railY + ringH * 0.5;
      for (const dz of [0, -spec.opticLength * 0.62]) {
        out.push({ surface: 'gunmetal', x: 0, y: ringY, z: back * 0.25 + dz, w: 0.026, h: ringH, d: 0.016 });
      }
      break;
    }
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
  //
  // A weapon with no handguard is held in two hands *on the grip*, not with a support hand
  // reaching for furniture that does not exist. That distinction is not cosmetic: the
  // rifle's support arm is a 0.2 m forearm box placed forward of the receiver, and on a
  // 0.17 m pistol it ended up between the sights and the camera, filling most of the screen
  // at ADS. See the M5 hotfix note in PLAN.md.
  const twoHandedGrip = spec.handguardLength <= 0;

  // Trigger hand and its forearm. Always present.
  const triggerHand = triggerHandAnchor(spec);
  const supportHand = supportHandAnchor(spec);
  out.push({
    surface: 'glove',
    x: triggerHand.x,
    y: triggerHand.y,
    z: triggerHand.z,
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

  if (twoHandedGrip) {
    // Support hand wrapped around the firing hand, and its forearm tucked in beside the
    // first rather than reaching forward.
    out.push({
      surface: 'glove',
      x: supportHand.x,
      y: supportHand.y,
      z: supportHand.z,
      w: 0.05,
      h: 0.082,
      d: 0.078,
      rx: -0.28,
    });
    out.push({
      surface: 'glove',
      x: -0.05,
      y: -0.172,
      z: back * 0.42 + 0.13,
      w: 0.066,
      h: 0.072,
      d: 0.19,
      rx: -0.5,
      rz: 0.18,
    });
    return out;
  }

  out.push({
    surface: 'glove',
    x: supportHand.x,
    y: supportHand.y,
    z: supportHand.z,
    w: 0.064,
    h: 0.076,
    d: 0.1,
  });
  out.push({
    surface: 'glove',
    x: -0.056,
    y: by - 0.15,
    z: supportHand.z + 0.094,
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
