import type { ReloadStep } from '../core/Events';
import { Rng } from '../core/Rng';
import type { ProceduralAudio } from '../engine/ProceduralAudio';
import { surfaceAtIndex } from '../world/maps/materials';
import type { WeaponVoice } from './WeaponDefs';

/**
 * Weapon voices, layered out of the `ProceduralAudio` primitives (brief S6.7).
 *
 * A gunshot is four layers, and getting the *balance* between them right is what makes
 * a synthesised shot sound like a rifle rather than a burst of static:
 *
 *   1. transient  — 12 ms of high-passed noise. The crack. Almost all of the "punch".
 *   2. body       — a band-passed burst sweeping down, whose centre frequency and Q are
 *                   the two numbers that separate an AR from an SMG from an LMG.
 *   3. thump      — a sine falling from ~90 Hz. Chest, not ears.
 *   4. tail       — a long, dark, wet burst. The room answering back.
 *
 * M5's eleven other weapons are new `WeaponVoice` records, not new code here.
 *
 * Everything routes through the pooled voices and the single convolver send from S4.5.
 * Nothing in this file creates a node graph.
 */
export class WeaponAudio {
  private readonly rng = new Rng(0x4172_9a10);

  constructor(private readonly audio: ProceduralAudio) {}

  /**
   * The shot. Four layers, all scheduled at the same instant.
   *
   * `gain` is the M8 mix trim (`engine/AudioMix.ts`). The local player's own weapon comes
   * in at `MIX.ownWeapon` so that an enemy rifle thirty metres away has somewhere to be
   * heard — see the measurement in that file. Every layer is scaled by it, so the *balance*
   * between transient, body, thump and tail is untouched and a ducked shot still sounds
   * like the same gun.
   */
  playGunshot(x: number, y: number, z: number, voice: WeaponVoice, gain = 1): void {
    const level = voice.level * gain;
    const noise = this.audio.noiseScratch;

    // 1. transient
    noise.x = x;
    noise.y = y;
    noise.z = z;
    noise.positional = true;
    noise.bus = 'sfx';
    noise.filter = 'highpass';
    noise.freq = voice.clickFreq;
    noise.freqEnd = voice.clickFreq * 0.75;
    noise.q = 0.6;
    noise.level = voice.clickLevel * level;
    noise.attack = 0.001;
    noise.decay = 0.013;
    noise.wet = 0.05;
    noise.roll = 'loud';
    noise.rate = this.rng.range(0.96, 1.05);
    this.audio.noiseBurst(noise);

    // 2. body
    noise.filter = 'bandpass';
    noise.freq = voice.bodyFreq * this.rng.range(0.95, 1.06);
    noise.freqEnd = noise.freq * 0.32;
    noise.q = voice.bodyQ;
    noise.level = level;
    noise.attack = 0.0015;
    noise.decay = voice.bodyDecay;
    noise.wet = voice.wet * 0.5;
    noise.rate = 1;
    this.audio.noiseBurst(noise);

    // 4. tail (scheduled before the thump only because both start now)
    noise.filter = 'lowpass';
    noise.freq = 2600;
    noise.freqEnd = 420;
    noise.q = 0.8;
    noise.level = voice.tailLevel * level;
    noise.attack = 0.006;
    noise.decay = voice.tailDecay;
    noise.wet = voice.wet;
    noise.rate = 0.85;
    this.audio.noiseBurst(noise);

    // 3. thump
    const osc = this.audio.oscScratch;
    osc.x = x;
    osc.y = y;
    osc.z = z;
    osc.positional = true;
    osc.bus = 'sfx';
    osc.type = 'sine';
    osc.freq = voice.thumpFreq * this.rng.range(0.94, 1.07);
    osc.freqEnd = osc.freq * 0.42;
    osc.level = voice.thumpLevel * level;
    osc.attack = 0.002;
    osc.decay = 0.115;
    osc.wet = voice.wet * 0.3;
    osc.filterFreq = 460;
    osc.filterQ = 0.7;
    osc.roll = 'loud';
    this.audio.oscHit(osc);
  }

  /** The click of a hammer falling on nothing. */
  playDryFire(x: number, y: number, z: number): void {
    const noise = this.audio.noiseScratch;
    noise.roll = 'handling';
    noise.x = x;
    noise.y = y;
    noise.z = z;
    noise.positional = true;
    noise.bus = 'sfx';
    noise.filter = 'bandpass';
    noise.freq = 2600;
    noise.freqEnd = 1400;
    noise.q = 3.2;
    noise.level = 0.3;
    noise.attack = 0.001;
    noise.decay = 0.03;
    noise.wet = 0.08;
    noise.rate = 1;
    this.audio.noiseBurst(noise);
  }

  /**
   * The knife coming round (post-M8).
   *
   * A downward noise sweep — air moving, not metal ringing — and it plays whether or not the
   * swing connected. A miss you cannot hear is a miss you learn nothing from: the whoosh is
   * how a player finds out they were half a metre short. A connection is *additionally*
   * reported by the ordinary hitmarker path, because a melee applies damage through the same
   * door everything else does and gets that feedback for free.
   */
  playMeleeSwing(x: number, y: number, z: number, connected: boolean): void {
    const noise = this.audio.noiseScratch;
    noise.roll = 'handling';
    noise.x = x;
    noise.y = y;
    noise.z = z;
    noise.positional = true;
    noise.bus = 'sfx';
    noise.filter = 'bandpass';
    // Sweeping down rather than up: the blade is accelerating away from the ear, and a rising
    // sweep reads as something being drawn instead of something being swung.
    noise.freq = connected ? 2200 : 3000;
    noise.freqEnd = connected ? 520 : 900;
    noise.q = connected ? 1.6 : 0.9;
    noise.level = connected ? 0.42 : 0.24;
    noise.attack = 0.002;
    noise.decay = connected ? 0.1 : 0.13;
    noise.wet = 0.12;
    noise.rate = 1;
    this.audio.noiseBurst(noise);
  }

  /**
   * Reload mechanics. Each step is a different piece of metal doing a different thing,
   * and they have to be distinguishable with your eyes on the enemy.
   */
  playReloadStep(x: number, y: number, z: number, step: ReloadStep): void {
    const noise = this.audio.noiseScratch;
    noise.roll = 'handling';
    noise.x = x;
    noise.y = y;
    noise.z = z;
    noise.positional = true;
    noise.bus = 'sfx';
    noise.filter = 'bandpass';
    noise.wet = 0.1;
    noise.attack = 0.001;
    noise.rate = 1;

    switch (step) {
      case 'down':
        // Cloth and a hand shifting grip: soft, low, short.
        noise.filter = 'lowpass';
        noise.freq = 900;
        noise.freqEnd = 450;
        noise.q = 0.7;
        noise.level = 0.16;
        noise.decay = 0.07;
        break;
      case 'magOut':
        // Release catch, then the magazine leaving the well.
        noise.freq = 3100;
        noise.freqEnd = 1800;
        noise.q = 4.5;
        noise.level = 0.32;
        noise.decay = 0.035;
        break;
      case 'magIn':
        // Seating a magazine is the heaviest sound in the sequence.
        noise.freq = 1500;
        noise.freqEnd = 600;
        noise.q = 2.2;
        noise.level = 0.4;
        noise.decay = 0.075;
        break;
      case 'charge':
        noise.freq = 2300;
        noise.freqEnd = 3600;
        noise.q = 3.0;
        noise.level = 0.36;
        noise.decay = 0.09;
        break;
      case 'raise':
        noise.filter = 'lowpass';
        noise.freq = 1400;
        noise.freqEnd = 700;
        noise.q = 0.8;
        noise.level = 0.14;
        noise.decay = 0.06;
        break;
    }
    this.audio.noiseBurst(noise);

    if (step !== 'magIn') return;
    const osc = this.audio.oscScratch;
    osc.x = x;
    osc.y = y;
    osc.z = z;
    osc.positional = true;
    osc.bus = 'sfx';
    osc.type = 'sine';
    osc.freq = 190;
    osc.freqEnd = 90;
    osc.level = 0.24;
    osc.attack = 0.002;
    osc.decay = 0.08;
    osc.wet = 0.08;
    osc.filterFreq = 700;
    osc.filterQ = 0.7;
    this.audio.oscHit(osc);
  }

  /** The rustle of the weapon coming to the eye. Quiet, but it sells the transition. */
  playAdsRustle(x: number, y: number, z: number, aiming: boolean): void {
    const noise = this.audio.noiseScratch;
    noise.roll = 'handling';
    noise.x = x;
    noise.y = y;
    noise.z = z;
    noise.positional = true;
    noise.bus = 'sfx';
    noise.filter = 'bandpass';
    noise.freq = aiming ? 2200 : 1700;
    noise.freqEnd = aiming ? 1100 : 850;
    noise.q = 1.1;
    noise.level = 0.09;
    noise.attack = 0.008;
    noise.decay = 0.075;
    noise.wet = 0.05;
    noise.rate = 1;
    this.audio.noiseBurst(noise);
  }

  /**
   * The hitmarker click — the single most important piece of feedback in the game
   * (S6.5), so it is deliberately dry, non-positional, on the UI bus, and scheduled at
   * `currentTime` with no send. Nothing about it waits for anything.
   */
  playHitmarker(kill: boolean): void {
    const noise = this.audio.noiseScratch;
    noise.x = 0;
    noise.y = 0;
    noise.z = 0;
    noise.positional = false;
    noise.bus = 'ui';
    noise.filter = 'bandpass';
    noise.freq = kill ? 1500 : 3400;
    noise.freqEnd = kill ? 700 : 2100;
    noise.q = kill ? 2.4 : 5.0;
    noise.level = kill ? 0.34 : 0.24;
    noise.attack = 0.0008;
    noise.decay = kill ? 0.055 : 0.022;
    noise.wet = 0;
    noise.rate = 1;
    this.audio.noiseBurst(noise);

    if (!kill) return;
    // A kill gets a second, lower note so it is unmistakable without being a jingle.
    this.audio.playUiSweep(720, 300, 0.2, 0.13);
  }

  /**
   * A round landing on a body (S6.8).
   *
   * Deliberately the opposite shape to every surface impact above: no transient crack,
   * a low centre frequency and a fast decay, so flesh reads as *soft* against concrete
   * and steel without needing a sample. A headshot is tighter, higher and shorter — it
   * has to be identifiable by ear alone, because that is how a player learns to aim.
   */
  playFleshImpact(x: number, y: number, z: number, headshot: boolean): void {
    const noise = this.audio.noiseScratch;
    noise.roll = 'impact';
    noise.x = x;
    noise.y = y;
    noise.z = z;
    noise.positional = true;
    noise.bus = 'sfx';
    noise.filter = 'lowpass';
    noise.freq = headshot ? 1500 : 620;
    noise.freqEnd = headshot ? 500 : 190;
    noise.q = headshot ? 2.6 : 0.9;
    noise.level = headshot ? 0.3 : 0.24;
    noise.attack = 0.001;
    noise.decay = headshot ? 0.05 : 0.075;
    noise.wet = 0.16;
    noise.rate = this.rng.range(0.92, 1.09);
    this.audio.noiseBurst(noise);

    const osc = this.audio.oscScratch;
    osc.x = x;
    osc.y = y;
    osc.z = z;
    osc.positional = true;
    osc.bus = 'sfx';
    osc.type = 'sine';
    osc.freq = headshot ? 260 : 150;
    osc.freqEnd = osc.freq * 0.45;
    osc.level = 0.18;
    osc.attack = 0.001;
    osc.decay = 0.06;
    osc.wet = 0.1;
    osc.filterFreq = 420;
    osc.filterQ = 0.7;
    this.audio.oscHit(osc);
  }

  /**
   * A body arriving on the floor (S6.8). Two layers a fifth of a second apart: the drop,
   * then the settle. One thud reads as dropping a crate; two reads as a person falling.
   */
  playDeath(x: number, y: number, z: number): void {
    const osc = this.audio.oscScratch;
    osc.roll = 'world';
    osc.x = x;
    osc.y = y;
    osc.z = z;
    osc.positional = true;
    osc.bus = 'sfx';
    osc.type = 'sine';
    osc.freq = 118;
    osc.freqEnd = 48;
    osc.level = 0.4;
    osc.attack = 0.003;
    osc.decay = 0.2;
    osc.wet = 0.24;
    osc.filterFreq = 340;
    osc.filterQ = 0.7;
    this.audio.oscHit(osc);

    // Gear and cloth going down with it.
    const noise = this.audio.noiseScratch;
    noise.x = x;
    noise.y = y;
    noise.z = z;
    noise.positional = true;
    noise.bus = 'sfx';
    noise.filter = 'lowpass';
    noise.freq = 1250;
    noise.freqEnd = 300;
    noise.q = 0.8;
    noise.level = 0.22;
    noise.attack = 0.004;
    noise.decay = 0.26;
    noise.wet = 0.3;
    noise.rate = this.rng.range(0.9, 1.1);
    this.audio.noiseBurst(noise);
  }

  /** Impact report from the far end of the shot, coloured by what was hit. */
  playImpact(x: number, y: number, z: number, material: number, penetrated: boolean): void {
    const surface = surfaceAtIndex(material);
    const noise = this.audio.noiseScratch;
    noise.roll = 'impact';
    noise.x = x;
    noise.y = y;
    noise.z = z;
    noise.positional = true;
    noise.bus = 'sfx';
    noise.filter = 'bandpass';
    noise.freq = surface.impactFreq * this.rng.range(0.88, 1.14);
    noise.freqEnd = noise.freq * 0.45;
    noise.q = surface.impactQ;
    noise.level = penetrated ? 0.16 : 0.26;
    noise.attack = 0.001;
    noise.decay = surface.impactDecay;
    noise.wet = 0.22;
    noise.rate = 1;
    this.audio.noiseBurst(noise);
  }
}
