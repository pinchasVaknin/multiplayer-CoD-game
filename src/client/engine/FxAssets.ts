import * as THREE from 'three';
import { Rng } from '../../shared/core/Rng';

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

  // A chipped pale ring around a dark hole, so it reads on both light and dark walls.
  const ring = ctx.createRadialGradient(size / 2, size / 2, size * 0.12, size / 2, size / 2, size * 0.48);
  ring.addColorStop(0, 'rgba(210,205,196,0.55)');
  ring.addColorStop(0.55, 'rgba(150,145,138,0.3)');
  ring.addColorStop(1, 'rgba(150,145,138,0)');
  ctx.fillStyle = ring;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.48, 0, Math.PI * 2);
  ctx.fill();

  const hole = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size * 0.22);
  hole.addColorStop(0, 'rgba(10,10,12,1)');
  hole.addColorStop(0.7, 'rgba(18,18,20,0.9)');
  hole.addColorStop(1, 'rgba(30,30,32,0)');
  ctx.fillStyle = hole;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.22, 0, Math.PI * 2);
  ctx.fill();

  for (let i = 0; i < 40; i++) {
    const angle = rng.float() * Math.PI * 2;
    const r = rng.range(size * 0.16, size * 0.42);
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
