import * as THREE from 'three';

import { SKY_LAYER } from '../engine/Renderer';
import { SKY_PROFILE_SAMPLES, skylineProfile } from '../../shared/world/SkyProfile';
import type { MapDef, Vec3Lit } from '../../shared/world/maps/types';

/**
 * The sky (playtest round 5, F2).
 *
 * The report: `scene.background` was the fog colour and nothing else, so looking up on Dunes
 * gave a uniform beige rectangle and flying above the map gave a village in a void. This is a
 * gradient dome, a sun disc placed from the map's own key light, and a ridge line past the
 * boundary — one mesh, one draw call, one material, no textures beyond a 512x1 profile.
 *
 * ## Three decisions that are not obvious
 *
 * **It never moves, and nothing updates it.** The vertex shader drops the translation out of
 * the model-view matrix and writes `gl_Position = pos.xyww`, which puts every fragment at the
 * far plane centred on the camera. So the dome is at infinity by construction rather than by
 * being large, there is no per-frame `position.copy(camera.position)` to forget, and the free
 * camera cannot fly out of it. `Particulate` does the opposite — it recentres on the camera
 * from `Game.draw` — and it is right to, because dust is *near* and its parallax is the
 * effect. A horizon's correct parallax is none.
 *
 * **It is tone-mapped, and that is what removes the seam.** The world's fully-fogged pixel is
 * `fogColor` decoded to linear, ACES-mapped at exposure 1.25 and encoded back to sRGB. A sky
 * that skipped those steps would be the same authored hex and a visibly different pixel, with
 * the join between them drawn across the middle of the screen. So the fragment shader works
 * in linear and ends with three's own `tonemapping_fragment` and `colorspace_fragment`
 * chunks. The gunship shaders in `engine/Renderer.ts` deliberately do not, and that is not a
 * pattern to copy here: an optic is a false-colour readout, and this is the world.
 *
 * **It is on its own layer.** `renderGunship` draws the scene three times with an override
 * material, and an inward-facing sphere pinned to the far plane drawn as thermal terrain is a
 * grey wall over the whole optic. Rather than a fourth visibility toggle in that pass, the
 * dome sits on `SKY_LAYER` and only the world camera enables it — so the thermal camera, the
 * shadow cameras and anything added later see no sky unless they ask, which is the right
 * default for all three.
 */

/** Dome tessellation. The gradient is per fragment, so this only has to be round. */
const DOME_SEGMENTS_H = 24;
const DOME_SEGMENTS_V = 16;

export class SkyDome {
  readonly mesh: THREE.Mesh;

  private readonly geometry: THREE.SphereGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly profile: THREE.DataTexture | null;

  constructor(def: MapDef) {
    const sky = def.ambient.sky;
    const skyline = sky.skyline;

    this.profile = skyline === undefined ? null : buildProfileTexture(skyline);

    const sun = sunDirection(def);
    const disc = sky.disc;
    const discRad = (disc.sizeDeg * Math.PI) / 180;
    const glowRad = (Math.max(disc.glowDeg, disc.sizeDeg) * Math.PI) / 180;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        // `THREE.Color` decodes the authored hex from sRGB into the renderer's linear working
        // space, which is the space the mix below has to happen in for the seam to close.
        uHorizon: { value: new THREE.Color(def.ambient.fogColor) },
        uZenith: { value: new THREE.Color(sky.zenith) },
        uFalloff: { value: Math.max(0.05, sky.falloff) },
        uSunDir: { value: sun === null ? new THREE.Vector3(0, 1, 0) : sun },
        uDiscColor: { value: new THREE.Color(disc.color) },
        uDiscIntensity: { value: sun === null ? 0 : Math.max(0, disc.intensity) },
        // Cosines rather than angles: the shader has a dot product and comparing cosines
        // saves an `acos` per fragment over the whole sky.
        uDiscCos: { value: Math.cos(discRad) },
        uDiscEdge: { value: Math.cos(discRad * 0.55) },
        uGlowCos: { value: Math.cos(glowRad) },
        uProfile: { value: this.profile },
        uSkylineColor: { value: new THREE.Color(skyline?.color ?? 0x000000) },
        uHasSkyline: { value: skyline === undefined ? 0 : 1 },
        // The byte in the profile texture is a fraction of this, so the shader multiplies
        // once rather than the generator baking an angle into a range it cannot represent.
        uSkylinePeak: { value: ((skyline?.heightDeg ?? 0) * Math.PI) / 180 },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      // Nothing may be hidden by the sky. Depth is written by the world pass that follows and
      // the dome's own fragments sit at the far plane, so the comparison always passes and
      // never records anything.
      depthWrite: false,
      // The dome is lit by nothing and fogged by nothing: it *is* the thing fog fades into.
      fog: false,
    });

    this.geometry = new THREE.SphereGeometry(1, DOME_SEGMENTS_H, DOME_SEGMENTS_V);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'sky';
    // A mesh that is always centred on the camera cannot be culled against the camera, and
    // asking three to try costs a bounding-sphere test that can only ever answer "visible".
    this.mesh.frustumCulled = false;
    // Before the world, so the world's depth writes land on top of a filled colour buffer.
    this.mesh.renderOrder = -1;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.layers.set(SKY_LAYER);
  }

  /** Triangles this adds to a frame. Reported by `MapStats` so F2's cost is on the record. */
  get triangleCount(): number {
    return ((this.geometry.getIndex()?.count ?? 0) / 3) | 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.profile?.dispose();
  }
}

/**
 * Where the sun is, from the map's key light and from nowhere else.
 *
 * `LightDef.direction` is the direction the light *travels*, so the disc goes at its negation.
 * A map with no directional light gets no disc rather than a default one: an invented sun over
 * a map whose shadows are cast by six floodlights would be a second answer to a question the
 * map has already answered.
 */
function sunDirection(def: MapDef): THREE.Vector3 | null {
  for (const light of def.lights) {
    if (light.kind !== 'directional') continue;
    const d: Vec3Lit = light.direction;
    const v = new THREE.Vector3(-d.x, -d.y, -d.z);
    if (v.lengthSq() < 1e-8) return null;
    return v.normalize();
  }
  return null;
}

/**
 * The ridge, as a one-dimensional texture the shader samples by azimuth.
 *
 * Red channel, one byte per sample: the profile is an elevation between zero and the authored
 * peak, so a byte is 512 steps across at most twenty degrees — finer than the vertical
 * resolution of the screen it is drawn on. `RepeatWrapping` is what makes the azimuth wrap
 * free; `SkyProfile` already guarantees the two ends meet, and `npm run readability` asserts
 * that they do.
 */
function buildProfileTexture(skyline: NonNullable<MapDef['ambient']['sky']['skyline']>): THREE.DataTexture {
  const profile = skylineProfile(skyline, SKY_PROFILE_SAMPLES);
  const peak = (skyline.heightDeg * Math.PI) / 180;
  const data = new Uint8Array(SKY_PROFILE_SAMPLES);
  for (let i = 0; i < SKY_PROFILE_SAMPLES; i++) {
    const v = peak <= 0 ? 0 : (profile[i] ?? 0) / peak;
    data[i] = Math.max(0, Math.min(255, Math.round(v * 255)));
  }

  const texture = new THREE.DataTexture(data, SKY_PROFILE_SAMPLES, 1, THREE.RedFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Direction out of the unit sphere, and the position trick that makes the dome infinite.
 *
 * `mat3(modelViewMatrix)` is the view rotation with the translation dropped, so the dome is
 * drawn as if the camera were at its centre however far the camera has actually walked.
 * `pos.xyww` then forces `z / w` to 1 — the far plane — so no amount of geometry can be
 * behind it and the sphere's radius is irrelevant.
 */
const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 pos = projectionMatrix * mat4(mat3(modelViewMatrix)) * vec4(position, 1.0);
  gl_Position = pos.xyww;
}
`;

/**
 * Gradient, disc and ridge, in linear space, tone-mapped at the end.
 *
 * The elevation term is `sin(elevation)`, which is just `dir.y` on a unit direction — one
 * fewer transcendental per fragment than the angle would be, and the exponent in `uFalloff`
 * is authored against it. The ridge needs the real angle, and only inside the band.
 */
const SKY_FRAG = `
uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform float uFalloff;
uniform vec3 uSunDir;
uniform vec3 uDiscColor;
uniform float uDiscIntensity;
uniform float uDiscCos;
uniform float uDiscEdge;
uniform float uGlowCos;
uniform sampler2D uProfile;
uniform vec3 uSkylineColor;
uniform float uHasSkyline;
uniform float uSkylinePeak;
varying vec3 vDir;

void main() {
  vec3 dir = normalize(vDir);

  // Below the horizon the sky stays at the fog colour rather than continuing the gradient
  // downward. In a match the floor covers it; from the free camera it is the haze the map is
  // standing in, which is the same thing the geometry fades into.
  // pow(0.0, x) is undefined in GLSL and some drivers hand back a NaN, which would put a ring
  // of black pixels exactly along the horizon — the one line this whole feature exists to make
  // invisible. The floor costs nothing and removes the case.
  float up = clamp(dir.y, 1e-5, 1.0);
  vec3 col = mix(uHorizon, uZenith, pow(up, uFalloff));

  // The ridge, sampled by azimuth. Everything is a fraction of the feature's own height, so
  // one expression covers a map whose horizon is twenty degrees and one whose horizon is six.
  if (uHasSkyline > 0.5) {
    float az = atan(dir.z, dir.x) * 0.15915494 + 0.5;
    float peak = texture2D(uProfile, vec2(az, 0.5)).r * uSkylinePeak;
    float elev = asin(clamp(dir.y, -1.0, 1.0));
    float rise = clamp(elev / max(peak, 1e-4), 0.0, 1.0);
    // Inside the silhouette, with a soft top edge so a 512-sample profile does not alias.
    float inside = 1.0 - smoothstep(0.93, 1.0, rise);
    // Aerial perspective, and it is the right way round: the base of a distant ridge washes
    // out into the haze it is standing in and its top stands clear of it. This is also what
    // removes the seam at the horizon line — the silhouette reaches zero opacity exactly
    // where the ground would be.
    float haze = smoothstep(0.0, 0.45, rise);
    col = mix(col, uSkylineColor, inside * haze);
  }

  // Disc and glow. Both are additive: a sun is a light source in the picture, not a painted
  // circle, and adding it lets the tone mapper roll the core off the way it does everything
  // else bright in the frame.
  float c = dot(dir, uSunDir);
  float disc = smoothstep(uDiscCos, uDiscEdge, c);
  float glow = pow(clamp((c - uGlowCos) / max(1.0 - uGlowCos, 1e-4), 0.0, 1.0), 3.0);
  col += uDiscColor * uDiscIntensity * (disc + 0.35 * glow);

  gl_FragColor = vec4(col, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
