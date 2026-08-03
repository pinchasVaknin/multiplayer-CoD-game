import { Rng } from '../../shared/core/Rng';
import type { ProceduralAudio } from '../engine/ProceduralAudio';
import { surfaceAtIndex } from '../../shared/world/maps/materials';

/**
 * Equipment voices, built from the same two `ProceduralAudio` primitives everything else
 * uses (brief S2, S4.5). Nothing here constructs a node graph and nothing creates a
 * `ConvolverNode`.
 *
 * The explosion is the only sound in the project that needs to read as *big*, and the way
 * it gets there is the same way the weapons do — layer count and tail length rather than
 * volume. Four layers: a crack, a low body that sweeps a long way down, a long wet tail,
 * and a sub thump under all of it.
 */
export class EquipmentAudio {
  private readonly rng = new Rng(0x2b7c_5e01);

  constructor(private readonly audio: ProceduralAudio) {}

  /** The pin, then the throw. Quiet, close, and entirely about telling you it happened. */
  playThrow(x: number, y: number, z: number): void {
    const noise = this.audio.noiseScratch;
    noise.x = x;
    noise.y = y;
    noise.z = z;
    noise.positional = true;
    noise.bus = 'sfx';
    noise.filter = 'bandpass';
    noise.freq = 3800;
    noise.freqEnd = 2200;
    noise.q = 5.0;
    noise.level = 0.2;
    noise.attack = 0.001;
    noise.decay = 0.028;
    noise.wet = 0.06;
    noise.rate = 1;
    this.audio.noiseBurst(noise);
  }

  /** Metal on concrete. Coloured by what it landed on, like every other impact (S6.7). */
  playBounce(x: number, y: number, z: number, speed: number, material: number, stuck: boolean): void {
    const surface = surfaceAtIndex(material);
    const noise = this.audio.noiseScratch;
    noise.x = x;
    noise.y = y;
    noise.z = z;
    noise.positional = true;
    noise.bus = 'sfx';
    noise.filter = stuck ? 'lowpass' : 'bandpass';
    noise.freq = stuck ? 900 : surface.impactFreq * this.rng.range(0.9, 1.15);
    noise.freqEnd = noise.freq * (stuck ? 0.3 : 0.4);
    noise.q = stuck ? 0.8 : surface.impactQ * 1.4;
    noise.level = Math.min(0.34, 0.06 + speed * 0.035);
    noise.attack = 0.001;
    noise.decay = stuck ? 0.09 : 0.045;
    noise.wet = 0.18;
    noise.rate = this.rng.range(0.94, 1.08);
    this.audio.noiseBurst(noise);
  }

  /** A claymore's legs opening and its trigger going live. */
  playArmed(x: number, y: number, z: number): void {
    this.pip(x, y, z, 2400, 0.16, 0.05);
    this.pip(x, y, z, 3200, 0.14, 0.05);
  }

  /**
   * The warning beep for a live grenade near the player (S6.3).
   *
   * Non-positional and on the `ui` bus on purpose: it is not the grenade making a noise,
   * it is the game telling you about it, and it has to cut through the low-health muffle
   * the same way the announcer does.
   */
  playThreatBeep(urgency: number): void {
    this.audio.playUiSweep(1500 + urgency * 900, 1100 + urgency * 700, 0.055, 0.16 + urgency * 0.1);
  }

  /** Four layers. The tail is what makes it a building rather than a firework. */
  playExplosion(x: number, y: number, z: number, scale: number): void {
    const noise = this.audio.noiseScratch;
    noise.x = x;
    noise.y = y;
    noise.z = z;
    noise.positional = true;
    noise.bus = 'sfx';

    // 1. crack
    noise.filter = 'highpass';
    noise.freq = 3400;
    noise.freqEnd = 1600;
    noise.q = 0.7;
    noise.level = 0.5 * scale;
    noise.attack = 0.001;
    noise.decay = 0.05;
    noise.wet = 0.15;
    noise.rate = this.rng.range(0.94, 1.06);
    this.audio.noiseBurst(noise);

    // 2. body
    noise.filter = 'bandpass';
    noise.freq = 260 * this.rng.range(0.9, 1.12);
    noise.freqEnd = 60;
    noise.q = 0.7;
    noise.level = 0.95 * scale;
    noise.attack = 0.003;
    noise.decay = 0.42;
    noise.wet = 0.45;
    noise.rate = 1;
    this.audio.noiseBurst(noise);

    // 3. tail
    noise.filter = 'lowpass';
    noise.freq = 1400;
    noise.freqEnd = 200;
    noise.q = 0.8;
    noise.level = 0.5 * scale;
    noise.attack = 0.02;
    noise.decay = 1.15;
    noise.wet = 0.75;
    noise.rate = 0.7;
    this.audio.noiseBurst(noise);

    // 4. sub
    const osc = this.audio.oscScratch;
    osc.x = x;
    osc.y = y;
    osc.z = z;
    osc.positional = true;
    osc.bus = 'sfx';
    osc.type = 'sine';
    osc.freq = 62;
    osc.freqEnd = 22;
    osc.level = 1.0 * scale;
    osc.attack = 0.004;
    osc.decay = 0.5;
    osc.wet = 0.4;
    osc.filterFreq = 220;
    osc.filterQ = 0.7;
    this.audio.oscHit(osc);
  }

  /**
   * The flash itself: a bright crack with almost no body, and then the ring.
   *
   * The ring is deliberately non-positional and on the `ui` bus, because tinnitus is not
   * a thing happening over there — it is a thing happening to you, and routing it through
   * the world would put it behind the low-pass the flash itself just installed.
   */
  playFlashbang(x: number, y: number, z: number, intensity: number): void {
    const noise = this.audio.noiseScratch;
    noise.x = x;
    noise.y = y;
    noise.z = z;
    noise.positional = true;
    noise.bus = 'sfx';
    noise.filter = 'highpass';
    noise.freq = 5200;
    noise.freqEnd = 2600;
    noise.q = 0.6;
    noise.level = 0.85;
    noise.attack = 0.0008;
    noise.decay = 0.09;
    noise.wet = 0.3;
    noise.rate = 1;
    this.audio.noiseBurst(noise);

    if (intensity <= 0.05) return;
    this.audio.playRing(intensity);
  }

  /** The soft rush of a smoke canister venting. Long, quiet, and unmistakable. */
  playSmoke(x: number, y: number, z: number): void {
    const noise = this.audio.noiseScratch;
    noise.x = x;
    noise.y = y;
    noise.z = z;
    noise.positional = true;
    noise.bus = 'sfx';
    noise.filter = 'bandpass';
    noise.freq = 2600;
    noise.freqEnd = 1200;
    noise.q = 0.5;
    noise.level = 0.3;
    noise.attack = 0.06;
    noise.decay = 1.6;
    noise.wet = 0.35;
    noise.rate = 1;
    this.audio.noiseBurst(noise);
  }

  private pip(x: number, y: number, z: number, freq: number, level: number, decay: number): void {
    const noise = this.audio.noiseScratch;
    noise.x = x;
    noise.y = y;
    noise.z = z;
    noise.positional = true;
    noise.bus = 'sfx';
    noise.filter = 'bandpass';
    noise.freq = freq;
    noise.freqEnd = freq * 0.7;
    noise.q = 6;
    noise.level = level;
    noise.attack = 0.001;
    noise.decay = decay;
    noise.wet = 0.08;
    noise.rate = 1;
    this.audio.noiseBurst(noise);
  }
}
