import { surfaceAtIndex } from '../world/maps/materials';
import { AudioGraph } from './AudioGraph';

/**
 * The game's own voices, layered out of the two primitives in `AudioGraph` (brief S6.7).
 *
 * Everything audible in OPERATOR is a handful of `noiseBurst` and `oscHit` calls with
 * different numbers — that is the toolkit S6.7 asks for, and it is why M5 can add eleven
 * weapons without adding a synthesis engine. The weapon voices live next to the weapons,
 * in `weapons/WeaponAudio.ts`; what is here is the world: feet, landings and the slide.
 *
 * The bus architecture, the single convolver and the voice pool are all inherited from
 * `AudioGraph`, unchanged since M1.
 */
export type { BusName, NoiseSpec, OcclusionTest, OscSpec } from './AudioSpecs';

export class ProceduralAudio extends AudioGraph {
  /**
   * Footstep: a short band-passed noise burst, coloured by the surface underfoot.
   * Heavy steps sit lower and louder and pick up a body thump, which is what separates
   * a sprint from a walk by ear.
   */
  playFootstep(x: number, y: number, z: number, speed: number, heavy: boolean, material: number): void {
    if (!this.hasContext) return;
    const surface = surfaceAtIndex(material);
    const intensity = Math.min(1, 0.35 + speed / 9);

    const spec = this.noiseScratch;
    spec.x = x;
    spec.y = y;
    spec.z = z;
    spec.positional = true;
    spec.bus = 'sfx';
    spec.filter = 'bandpass';
    spec.freq = surface.stepFreq * (heavy ? 0.62 : 1) * this.random(0.86, 1.16);
    spec.freqEnd = spec.freq * 0.7;
    spec.q = surface.stepQ;
    spec.level = (heavy ? 0.5 : 0.32) * intensity * surface.stepLevel;
    spec.attack = 0.004;
    spec.decay = heavy ? 0.14 : 0.09;
    spec.wet = 0.16;
    spec.rate = 1;
    this.noiseBurst(spec);

    if (!heavy) return;
    const osc = this.oscScratch;
    osc.x = x;
    osc.y = y;
    osc.z = z;
    osc.positional = true;
    osc.bus = 'sfx';
    osc.type = 'sine';
    osc.freq = this.random(115, 150);
    osc.freqEnd = osc.freq * 0.45;
    osc.level = 0.28 * intensity;
    osc.attack = 0.006;
    osc.decay = 0.11;
    osc.wet = 0.1;
    osc.filterFreq = 400;
    osc.filterQ = 0.6;
    this.oscHit(osc);
  }

  /** Landing: fuller and lower than a footstep, scaled by impact speed. */
  playLanding(x: number, y: number, z: number, impactSpeed: number, material: number): void {
    if (!this.hasContext) return;
    const t = Math.min(1, impactSpeed / 11);
    if (t < 0.08) return;
    const surface = surfaceAtIndex(material);

    const spec = this.noiseScratch;
    spec.x = x;
    spec.y = y;
    spec.z = z;
    spec.positional = true;
    spec.bus = 'sfx';
    spec.filter = 'bandpass';
    spec.freq = surface.stepFreq * 0.42 * this.random(0.9, 1.1);
    spec.freqEnd = spec.freq * 0.6;
    spec.q = surface.stepQ * 0.8;
    spec.level = (0.3 + 0.45 * t) * surface.stepLevel;
    spec.attack = 0.004;
    spec.decay = 0.16 + 0.1 * t;
    spec.wet = 0.3;
    spec.rate = 1;
    this.noiseBurst(spec);

    const osc = this.oscScratch;
    osc.x = x;
    osc.y = y;
    osc.z = z;
    osc.positional = true;
    osc.bus = 'sfx';
    osc.type = 'sine';
    osc.freq = this.random(95, 125);
    osc.freqEnd = osc.freq * 0.42;
    osc.level = 0.25 + 0.5 * t;
    osc.attack = 0.006;
    osc.decay = 0.16 + 0.08 * t;
    osc.wet = 0.12;
    osc.filterFreq = 320;
    osc.filterQ = 0.6;
    this.oscHit(osc);
  }

  /**
   * The sustained slide scrape, coloured by the surface being slid across.
   *
   * M1 played ordinary footsteps through a slide, which was a genuine feel bug: the
   * stance machine was right and the audio was lying about it. A slide is one continuous
   * event, so it gets the graph's one sustained bed rather than a stream of bursts.
   */
  setSlide(active: boolean, x: number, y: number, z: number, speed: number, material = 0): void {
    const surface = surfaceAtIndex(material);
    const level = active ? Math.min(0.42, 0.1 + speed * 0.045) * surface.stepLevel : 0;
    this.setSustainedBed(active, x, y, z, level, surface.stepFreq * 0.4);
  }

  /** Short sine sweep. The UI vocabulary (S6.7). */
  playUiSweep(from: number, to: number, level: number, decay: number): void {
    const spec = this.oscScratch;
    spec.x = 0;
    spec.y = 0;
    spec.z = 0;
    spec.positional = false;
    spec.bus = 'ui';
    spec.type = 'sine';
    spec.freq = from;
    spec.freqEnd = to;
    spec.level = level;
    spec.attack = 0.003;
    spec.decay = decay;
    spec.wet = 0;
    spec.filterFreq = 12000;
    spec.filterQ = 0.7;
    this.oscHit(spec);
  }

  /** True once `start()` has built the graph. Guards the composed sounds. */
  private get hasContext(): boolean {
    return this.poolSize > 0;
  }

  /** Seeded jitter, so a recorded session replays identically (S2 bans Math.random). */
  private random(min: number, max: number): number {
    return this.rng.range(min, max);
  }
}
