import { makeNoiseSpec, makeOscSpec, type NoiseSpec, type OscSpec } from '../engine/AudioSpecs';
import type { ProceduralAudio } from '../engine/ProceduralAudio';

/**
 * The killstreak vocabulary, synthesised (M7).
 *
 * A separate composer rather than eleven more methods on `ProceduralAudio`, which is already
 * at S3's size limit and whose subject is the *graph* — one context, one convolver, pooled
 * voices — rather than the catalogue of things the game can sound like. This class owns no
 * nodes: every sound is a handful of `noiseBurst` and `oscHit` calls against the graph that
 * already exists, which is the toolkit M2 left for exactly this (see PLAN.md, M2 notes).
 *
 * Two scratch specs are reused for every call, so firing a sentry sixty times a second
 * allocates nothing (S4.7).
 *
 * Design notes worth keeping:
 *
 * **The UAV sweep is a rising ping, not a beep.** A flat tone reads as a UI notification; a
 * short upward sweep reads as a radar return, and it is the only cue telling the player the
 * beam has come round again.
 *
 * **The mortar has two sounds and the gap between them is the gameplay.** `playMortarInbound`
 * is a descending whistle that starts `mortarDelay` before the first shell; the impact is a
 * low body plus a bright crack. The whistle is the warning the strike is fair.
 */
export class StreakAudio {
  private readonly audio: ProceduralAudio;
  private readonly noise: NoiseSpec = makeNoiseSpec();
  private readonly osc: OscSpec = makeOscSpec();

  constructor(audio: ProceduralAudio) {
    this.audio = audio;
  }

  /** One radar revolution. `phase` only varies the pitch a little so it does not machine-gun. */
  uavSweep(phase: number): void {
    const o = this.osc;
    o.positional = false;
    o.bus = 'ui';
    o.type = 'sine';
    o.freq = 880 + Math.sin(phase * 0.7) * 40;
    o.freqEnd = o.freq * 1.9;
    o.level = 0.16;
    o.attack = 0.004;
    o.decay = 0.13;
    o.wet = 0.1;
    o.filterFreq = 5200;
    o.filterQ = 0.8;
    this.audio.oscHit(o);
  }

  /** Scrambled: a dirty descending buzz, deliberately unpleasant. */
  counterUav(): void {
    const o = this.osc;
    o.positional = false;
    o.bus = 'ui';
    o.type = 'square';
    o.freq = 420;
    o.freqEnd = 120;
    o.level = 0.2;
    o.attack = 0.01;
    o.decay = 0.55;
    o.wet = 0.18;
    o.filterFreq = 1400;
    o.filterQ = 3.5;
    this.audio.oscHit(o);
  }

  packageDrop(x: number, y: number, z: number): void {
    const o = this.osc;
    this.placeOsc(x, y, z);
    o.type = 'sawtooth';
    o.freq = 300;
    o.freqEnd = 150;
    o.level = 0.22;
    o.attack = 0.06;
    o.decay = 1.1;
    o.wet = 0.4;
    o.filterFreq = 900;
    o.filterQ = 1.2;
    this.audio.oscHit(o);
  }

  packageLand(x: number, y: number, z: number): void {
    const n = this.noise;
    this.placeNoise(x, y, z);
    n.filter = 'lowpass';
    n.freq = 700;
    n.freqEnd = 160;
    n.q = 0.9;
    n.level = 0.5;
    n.attack = 0.002;
    n.decay = 0.34;
    n.wet = 0.42;
    n.rate = 0.72;
    this.audio.noiseBurst(n);
  }

  packageClaimed(x: number, y: number, z: number): void {
    const o = this.osc;
    this.placeOsc(x, y, z);
    o.type = 'triangle';
    o.freq = 520;
    o.freqEnd = 1040;
    o.level = 0.24;
    o.attack = 0.005;
    o.decay = 0.3;
    o.wet = 0.2;
    o.filterFreq = 4200;
    o.filterQ = 0.9;
    this.audio.oscHit(o);
  }

  /** The whistle. Long, descending, and the reason a mortar is not a cheap shot. */
  mortarInbound(x: number, y: number, z: number): void {
    const o = this.osc;
    this.placeOsc(x, y + 18, z);
    o.type = 'sine';
    o.freq = 1500;
    o.freqEnd = 320;
    o.level = 0.2;
    o.attack = 0.08;
    o.decay = 1.9;
    o.wet = 0.5;
    o.filterFreq = 4800;
    o.filterQ = 1.4;
    this.audio.oscHit(o);
  }

  mortarImpact(x: number, y: number, z: number): void {
    // Low body first, then the crack. Two layers, because one is a thud and two is an explosion.
    const o = this.osc;
    this.placeOsc(x, y, z);
    o.type = 'sine';
    o.freq = 110;
    o.freqEnd = 34;
    o.level = 0.62;
    o.attack = 0.004;
    o.decay = 0.6;
    o.wet = 0.55;
    o.filterFreq = 420;
    o.filterQ = 0.8;
    this.audio.oscHit(o);

    const n = this.noise;
    this.placeNoise(x, y, z);
    n.filter = 'bandpass';
    n.freq = 2600;
    n.freqEnd = 420;
    n.q = 0.7;
    n.level = 0.58;
    n.attack = 0.001;
    n.decay = 0.45;
    n.wet = 0.6;
    n.rate = 1.05;
    this.audio.noiseBurst(n);
  }

  sentryDeploy(x: number, y: number, z: number): void {
    const o = this.osc;
    this.placeOsc(x, y, z);
    o.type = 'square';
    o.freq = 240;
    o.freqEnd = 700;
    o.level = 0.18;
    o.attack = 0.01;
    o.decay = 0.28;
    o.wet = 0.22;
    o.filterFreq = 2200;
    o.filterQ = 2;
    this.audio.oscHit(o);
  }

  /** Thinner and flatter than a rifle: a turret should not sound like a person. */
  sentryShot(x: number, y: number, z: number): void {
    const n = this.noise;
    this.placeNoise(x, y, z);
    n.filter = 'bandpass';
    n.freq = 2100;
    n.freqEnd = 900;
    n.q = 1.4;
    n.level = 0.3;
    n.attack = 0.0008;
    n.decay = 0.075;
    n.wet = 0.3;
    n.rate = 1.25;
    this.audio.noiseBurst(n);
  }

  sentryDestroyed(x: number, y: number, z: number): void {
    const n = this.noise;
    this.placeNoise(x, y, z);
    n.filter = 'lowpass';
    n.freq = 1800;
    n.freqEnd = 180;
    n.q = 1;
    n.level = 0.55;
    n.attack = 0.002;
    n.decay = 0.55;
    n.wet = 0.5;
    n.rate = 0.85;
    this.audio.noiseBurst(n);
  }

  /**
   * The minigun spinning up. `spin` is 0..1 and drives both pitch and level, so holding the
   * trigger audibly winds the barrels rather than switching a loop on.
   */
  chopperSpin(spin: number): void {
    const o = this.osc;
    o.positional = false;
    o.bus = 'sfx';
    o.type = 'sawtooth';
    o.freq = 40 + spin * 90;
    o.freqEnd = o.freq * 1.04;
    o.level = 0.05 + spin * 0.16;
    o.attack = 0.01;
    o.decay = 0.14;
    o.wet = 0.12;
    o.filterFreq = 400 + spin * 1400;
    o.filterQ = 1.6;
    this.audio.oscHit(o);
  }

  /** One round from the chopper. Non-positional: the player *is* the gun. */
  chopperShot(): void {
    const n = this.noise;
    n.positional = false;
    n.bus = 'sfx';
    n.x = 0;
    n.y = 0;
    n.z = 0;
    n.filter = 'bandpass';
    n.freq = 1500;
    n.freqEnd = 620;
    n.q = 1.1;
    n.level = 0.34;
    n.attack = 0.001;
    n.decay = 0.09;
    n.wet = 0.24;
    n.rate = 0.95;
    this.audio.noiseBurst(n);
  }

  private placeNoise(x: number, y: number, z: number): void {
    const n = this.noise;
    n.positional = true;
    n.bus = 'sfx';
    n.x = x;
    n.y = y;
    n.z = z;
  }

  private placeOsc(x: number, y: number, z: number): void {
    const o = this.osc;
    o.positional = true;
    o.bus = 'sfx';
    o.x = x;
    o.y = y;
    o.z = z;
  }
}
