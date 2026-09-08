import * as THREE from 'three';
import { Rng } from '../../shared/core/Rng';
import { DECAL_HOLE_FRACTION, DECAL_RIM_FRACTION } from '../../shared/world/maps/materials';

/**
 * Generated art for `Fx` (brief S2: zero external assets).
 *
 * Split out of `Fx.ts` because it is content, not behaviour: `Fx` is a pool manager and
 * this is a handful of canvases and a fistful of quads. Every seed here is fixed, so a
 * build always looks identical.
 */

/** Two crossed quads plus a forward-facing star: cheap, and reads from every angle. */
export function buildFlashGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const a = new THREE.PlaneGeometry(0.16, 0.16);
  a.rotateY(Math.PI / 2);
  parts.push(a);
  const b = new THREE.PlaneGeometry(0.16, 0.16);
  parts.push(b);
  const c = new THREE.PlaneGeometry(0.13, 0.13);
  c.rotateX(Math.PI / 2);
  parts.push(c);

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let vertexBase = 0;
  for (const part of parts) {
    const pos = part.getAttribute('position');
    const uv = part.getAttribute('uv');
    const idx = part.getIndex();
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      uvs.push(uv.getX(i), uv.getY(i));
    }
    if (idx !== null) {
      for (let i = 0; i < idx.count; i++) indices.push(vertexBase + idx.getX(i));
    }
    vertexBase += pos.count;
    part.dispose();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

export function buildFlashTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2D canvas context unavailable; cannot build the muzzle flash.');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,224,160,0.85)');
  g.addColorStop(0.6, 'rgba(255,150,50,0.25)');
  g.addColorStop(1, 'rgba(255,120,20,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  // Four spokes so it is a flash rather than a blob.
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = 'rgba(255,236,200,0.5)';
  for (let i = 0; i < 4; i++) {
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.rotate((i * Math.PI) / 4);
    ctx.fillRect(-size / 2, -1.5, size, 3);
    ctx.restore();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export function buildDecalTexture(anisotropy: number): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2D canvas context unavailable; cannot build bullet decals.');
  const rng = new Rng(0x2c9e_a11d);

  /**
   * Radii as fractions of the quad, from the one place they are declared.
   *
   * `DECAL_HOLE_FRACTION` and `DECAL_RIM_FRACTION` are diameters, because that is the useful
   * unit at the call site that converts them to centimetres. Here they are halved back into the
   * radii the canvas wants. They live beside `decalRadius` in `materials.ts` rather than here
   * because they are the units it is denominated in — a metre value for a hole means nothing
   * without them (playtest round 5, F3).
   */
  const holeR = size * (DECAL_HOLE_FRACTION / 2);
  const rimR = size * (DECAL_RIM_FRACTION / 2);

  /**
   * The pale rim, and it is brighter and tighter than it was (F3).
   *
   * The old gradient ran from 0.55 alpha at 12% out to nothing at 48%, which is a *wash* rather
   * than a rim: on a light wall the whole thing disappeared and left the dark hole alone, which
   * is the "soft black blob" the report describes. Displaced material sits in a band just
   * outside the hole, so the peak is moved to the hole's edge, raised, and given somewhere to
   * fall off to — the outer two thirds are nearly clear, which is also what keeps the mark from
   * reading as a smudge the size of the quad.
   */
  const ring = ctx.createRadialGradient(size / 2, size / 2, holeR * 0.9, size / 2, size / 2, rimR);
  ring.addColorStop(0, 'rgba(226,221,210,0.85)');
  ring.addColorStop(0.3, 'rgba(198,192,182,0.5)');
  ring.addColorStop(0.65, 'rgba(150,145,138,0.16)');
  ring.addColorStop(1, 'rgba(150,145,138,0)');
  ctx.fillStyle = ring;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, rimR, 0, Math.PI * 2);
  ctx.fill();

  // The hole itself, dark to its edge rather than fading out into the rim: the boundary between
  // the two is what makes it read as a hole with a lip rather than as a stain.
  const hole = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, holeR);
  hole.addColorStop(0, 'rgba(10,10,12,1)');
  hole.addColorStop(0.78, 'rgba(16,16,18,0.94)');
  hole.addColorStop(1, 'rgba(26,26,28,0)');
  ctx.fillStyle = hole;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, holeR, 0, Math.PI * 2);
  ctx.fill();

  // Chipping, scattered through the rim band rather than across the whole quad.
  for (let i = 0; i < 40; i++) {
    const angle = rng.float() * Math.PI * 2;
    const r = rng.range(holeR * 0.9, rimR * 0.8);
    ctx.fillStyle = `rgba(20,20,22,${rng.range(0.1, 0.4)})`;
    ctx.fillRect(
      size / 2 + Math.cos(angle) * r,
      size / 2 + Math.sin(angle) * r,
      rng.range(1, 3),
      rng.range(1, 3),
    );
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}
