import type { Rng } from '../../shared/core/Rng';
import type { DistanceProfileName } from './AudioMix';

/**
 * The parameter records the audio toolkit takes, and the two buffers it is built on.
 *
 * Split out of the graph and the voices because these are the vocabulary the rest of the
 * project speaks to the audio system in: a weapon, a footstep and a UI blip are all just
 * a few of these, filled in and handed over. M5's eleven extra weapon voices are new
 * numbers in these shapes, not new code.
 *
 * Callers reuse a single spec instance rather than allocating one per sound — see
 * `ProceduralAudio.noiseScratch`.
 */

export type BusName = 'sfx' | 'music' | 'ui';

/** Seconds of shared white noise every noise-based sound reads from. */
export const NOISE_SECONDS = 2;

export interface NoiseSpec {
  x: number;
  y: number;
  z: number;
  positional: boolean;
  bus: BusName;
  filter: BiquadFilterType;
  /** Filter frequency at the attack. */
  freq: number;
  /** Filter frequency at the end of the decay. Equal to `freq` means no sweep. */
  freqEnd: number;
  q: number;
  level: number;
  attack: number;
  decay: number;
  /** Reverb send, 0..1. */
  wet: number;
  /** Playback rate of the shared noise buffer; shifts the perceived grain. */
  rate: number;
  /**
   * M8. Which distance-falloff curve this sound uses (`engine/AudioMix.ts`).
   *
   * A property of the sound rather than of the graph, because a rifle and a footstep are
   * not the same size of source and one global curve cannot be right for both. See
   * `AudioMix` for the measurement that forced this.
   */
  roll: DistanceProfileName;
}

export function makeNoiseSpec(): NoiseSpec {
  return {
    x: 0,
    y: 0,
    z: 0,
    positional: true,
    bus: 'sfx',
    filter: 'bandpass',
    freq: 1000,
    freqEnd: 1000,
    q: 1,
    level: 0.4,
    attack: 0.004,
    decay: 0.1,
    wet: 0.15,
    rate: 1,
    roll: 'world',
  };
}

export interface OscSpec {
  x: number;
  y: number;
  z: number;
  positional: boolean;
  bus: BusName;
  type: OscillatorType;
  freq: number;
  freqEnd: number;
  level: number;
  attack: number;
  decay: number;
  wet: number;
  /** Low-pass applied after the oscillator, so a square can be softened. */
  filterFreq: number;
  filterQ: number;
  /** M8. See `NoiseSpec.roll`. */
  roll: DistanceProfileName;
}

export function makeOscSpec(): OscSpec {
  return {
    x: 0,
    y: 0,
    z: 0,
    positional: false,
    bus: 'ui',
    type: 'sine',
    freq: 440,
    freqEnd: 440,
    level: 0.2,
    attack: 0.004,
    decay: 0.1,
    wet: 0,
    filterFreq: 8000,
    filterQ: 0.7,
    roll: 'world',
  };
}

/** True when world geometry blocks the straight line from a point to the listener. */
export type OcclusionTest = (x: number, y: number, z: number) => boolean;

/** White noise, generated once and shared by every noise-based sound. */
export function buildNoiseBuffer(ctx: AudioContext, rng: Rng, seconds: number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = rng.spread();
  return buffer;
}

/**
 * The room, as the audio graph hears it. Maps carry one of these from M4 (`MapDef.reverb`).
 *
 * Structurally identical to `world/maps/types.ts`'s `ReverbDef` and written out again rather
 * than imported: `engine/` has no business depending on the map format, and an impulse
 * response is a property of a space whether or not a map file described it.
 */
export interface ReverbSpec {
  /** Tail length, seconds. */
  readonly seconds: number;
  /** Decay exponent. Higher is a faster, drier fall-off. */
  readonly decay: number;
  /** Brightness of the early part, 0..1. High reads as bare steel and concrete. */
  readonly brightness: number;
  /** Discrete early reflections: delay in seconds and amplitude, 0..1. */
  readonly earlyTaps: readonly Readonly<{ delay: number; gain: number }>[];
}

/** The room M1 shipped with, and the fallback for a map that does not describe one. */
export const DEFAULT_REVERB: ReverbSpec = {
  seconds: 1.35,
  decay: 2.6,
  brightness: 0.35,
  earlyTaps: [],
};

/**
 * Impulse response for the single convolver (brief S6.6).
 *
 * A noise burst under an exponential decay envelope, a one-pole low pass that darkens the
 * tail the way a real room does, and a few **discrete early taps** — the slaps off nearby
 * hard surfaces that arrive before the diffuse tail and are most of what makes a space
 * identifiable. A big shed and a small office differ far more in their first 100 ms than in
 * the length of their tail.
 *
 * `brightness` sets how much high frequency survives into the early part: 0.72 is bare steel
 * and concrete, 0.35 is the softer default room.
 *
 * This builds a *buffer*. It is assigned to the one `ConvolverNode` the process owns, and
 * calling it again to change rooms is how S6.6's per-map reverb happens without ever
 * creating a second convolver (S4.5).
 */
export function buildImpulseResponse(ctx: AudioContext, rng: Rng, spec: ReverbSpec): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * spec.seconds));
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  // Bright rooms let more of the noise straight through the one-pole; dark ones smear it.
  const openness = 0.18 + 0.42 * Math.min(1, Math.max(0, spec.brightness));

  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const envelope = Math.pow(1 - t, spec.decay);
      lp += (rng.spread() - lp) * (openness - (openness - 0.1) * t);
      data[i] = lp * envelope;
    }

    // Early reflections, offset per channel so the two ears do not hear the same wall.
    const skew = ch === 0 ? 1 : 1.14;
    for (const tap of spec.earlyTaps) {
      const at = Math.floor(tap.delay * skew * ctx.sampleRate);
      if (at <= 0 || at >= length) continue;
      const width = Math.max(2, Math.floor(0.0012 * ctx.sampleRate));
      for (let k = 0; k < width; k++) {
        const index = at + k;
        if (index >= length) break;
        const shape = 1 - k / width;
        data[index] = (data[index] ?? 0) + rng.spread() * tap.gain * shape * 2;
      }
    }
  }
  return buffer;
}
