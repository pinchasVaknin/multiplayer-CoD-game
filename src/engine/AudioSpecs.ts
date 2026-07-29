import type { Rng } from '../core/Rng';

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
 * Impulse response for the single convolver: decaying noise with a slight
 * high-frequency roll-off, which reads as a medium concrete space.
 */
export function buildImpulseResponse(
  ctx: AudioContext,
  rng: Rng,
  seconds: number,
  decay: number,
): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const envelope = Math.pow(1 - t, decay);
      // One-pole low pass so the tail darkens as it decays, like a real room.
      lp += (rng.spread() - lp) * (0.35 - 0.25 * t);
      data[i] = lp * envelope;
    }
  }
  return buffer;
}
