import { ObjectPool } from '../core/ObjectPool';
import { Rng } from '../core/Rng';

/**
 * Web Audio synthesis only (brief S2). No files, no CDN.
 *
 * Graph (S4.5), built exactly once:
 *
 *   sources --dry--> {sfx | music | ui} --> master --> destination
 *          \--wet--> reverbSend --> convolver --> reverbReturn --> master
 *
 * There is exactly ONE ConvolverNode in the process, on a send. Never one per source,
 * never one per shot — a convolver per gunshot is how a browser FPS ends up at 12 FPS.
 * The impulse response is generated, not loaded.
 *
 * M1 only plays footsteps and landings (S8), but the bus architecture is the deliverable:
 * M2's weapons plug into the same sends.
 */

export type BusName = 'sfx' | 'music' | 'ui';

interface Voice {
  gain: GainNode;
  filter: BiquadFilterNode;
  panner: PannerNode;
  send: GainNode;
  /** ctx.currentTime at which this voice may be recycled. */
  endsAt: number;
  active: boolean;
}

const VOICE_POOL_SIZE = 24;
const NOISE_SECONDS = 2;

export class ProceduralAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buses = new Map<BusName, GainNode>();
  private noise: AudioBuffer | null = null;

  private pool: ObjectPool<Voice> | null = null;
  private readonly active: Voice[] = [];
  private readonly rng = new Rng(0x5eed_f007);

  private masterVolume = 0.8;
  private started = false;

  get isRunning(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  get voiceCount(): number {
    return this.active.length;
  }

  /**
   * Build the graph. Must be called from a user gesture: browsers refuse to start an
   * AudioContext otherwise. Safe to call repeatedly.
   */
  start(): void {
    if (this.started) {
      void this.ctx?.resume();
      return;
    }
    const Ctor: typeof AudioContext | undefined = window.AudioContext;
    if (Ctor === undefined) {
      console.warn('[Audio] Web Audio unavailable; running silent.');
      this.started = true;
      return;
    }

    const ctx = new Ctor({ latencyHint: 'interactive' });
    this.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = this.masterVolume;
    master.connect(ctx.destination);
    this.master = master;

    for (const name of ['sfx', 'music', 'ui'] as const) {
      const bus = ctx.createGain();
      bus.gain.value = 1;
      bus.connect(master);
      this.buses.set(name, bus);
    }

    // The one and only convolver, on a send.
    const convolver = ctx.createConvolver();
    convolver.buffer = buildImpulseResponse(ctx, this.rng, 1.35, 2.6);
    const reverbSend = ctx.createGain();
    reverbSend.gain.value = 1;
    const reverbReturn = ctx.createGain();
    reverbReturn.gain.value = 0.5;
    reverbSend.connect(convolver);
    convolver.connect(reverbReturn);
    reverbReturn.connect(master);

    this.noise = buildNoiseBuffer(ctx, this.rng, NOISE_SECONDS);

    const sfx = this.buses.get('sfx');
    if (sfx === undefined) throw new Error('[Audio] sfx bus missing');

    this.pool = new ObjectPool<Voice>(
      () => {
        const gain = ctx.createGain();
        const filter = ctx.createBiquadFilter();
        const panner = ctx.createPanner();
        const send = ctx.createGain();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = 1.6;
        panner.maxDistance = 60;
        panner.rolloffFactor = 1.1;
        filter.connect(gain);
        gain.connect(panner);
        panner.connect(sfx);
        gain.connect(send);
        send.connect(reverbSend);
        return { gain, filter, panner, send, endsAt: 0, active: false };
      },
      (v) => {
        v.gain.gain.cancelScheduledValues(0);
        v.gain.gain.value = 0;
        v.active = false;
      },
      VOICE_POOL_SIZE,
      'audio-voice',
    );

    this.started = true;
    void ctx.resume();
  }

  suspend(): void {
    void this.ctx?.suspend();
  }

  resume(): void {
    void this.ctx?.resume();
  }

  setMasterVolume(v: number): void {
    this.masterVolume = Math.max(0, Math.min(1, v));
    if (this.master !== null) this.master.gain.value = this.masterVolume;
  }

  setBusVolume(bus: BusName, v: number): void {
    const node = this.buses.get(bus);
    if (node !== undefined) node.gain.value = Math.max(0, Math.min(1, v));
  }

  /** Update the listener each frame from the camera. `forward` and `up` are unit. */
  setListener(
    px: number,
    py: number,
    pz: number,
    fx: number,
    fy: number,
    fz: number,
    ux: number,
    uy: number,
    uz: number,
  ): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    const l = ctx.listener;
    const t = ctx.currentTime;
    if (l.positionX !== undefined) {
      l.positionX.setValueAtTime(px, t);
      l.positionY.setValueAtTime(py, t);
      l.positionZ.setValueAtTime(pz, t);
      l.forwardX.setValueAtTime(fx, t);
      l.forwardY.setValueAtTime(fy, t);
      l.forwardZ.setValueAtTime(fz, t);
      l.upX.setValueAtTime(ux, t);
      l.upY.setValueAtTime(uy, t);
      l.upZ.setValueAtTime(uz, t);
    }
  }

  /** Recycle finished voices. Called once per frame; allocates nothing. */
  update(): void {
    const ctx = this.ctx;
    const pool = this.pool;
    if (ctx === null || pool === null) return;
    const now = ctx.currentTime;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const v = this.active[i];
      if (v === undefined) continue;
      if (v.endsAt > now) continue;
      const last = this.active.pop();
      if (last !== undefined && i < this.active.length) this.active[i] = last;
      pool.release(v);
    }
  }

  // -- sounds --------------------------------------------------------------

  /**
   * Footstep: a short band-passed noise burst. Heavy steps sit lower and louder and
   * pick up a body thump, which is what separates a sprint from a walk by ear.
   */
  playFootstep(x: number, y: number, z: number, speed: number, heavy: boolean): void {
    const ctx = this.ctx;
    if (ctx === null || this.noise === null) return;

    const intensity = Math.min(1, 0.35 + speed / 9);
    const centre = (heavy ? 900 : 1500) * this.rng.range(0.86, 1.16);
    const decay = heavy ? 0.14 : 0.09;
    const level = (heavy ? 0.5 : 0.32) * intensity;

    this.burst(x, y, z, centre, 0.9, level, decay, 0.16);
    if (heavy) this.thump(x, y, z, this.rng.range(72, 96), level * 0.55, 0.11);
  }

  /** Landing: fuller and lower than a footstep, scaled by impact speed. */
  playLanding(x: number, y: number, z: number, impactSpeed: number): void {
    const ctx = this.ctx;
    if (ctx === null || this.noise === null) return;
    const t = Math.min(1, impactSpeed / 11);
    if (t < 0.08) return;
    this.burst(x, y, z, 620 * this.rng.range(0.9, 1.1), 0.7, 0.3 + 0.45 * t, 0.16 + 0.1 * t, 0.3);
    this.thump(x, y, z, this.rng.range(58, 74), 0.25 + 0.5 * t, 0.16 + 0.08 * t);
  }

  private burst(
    x: number,
    y: number,
    z: number,
    centre: number,
    q: number,
    level: number,
    decay: number,
    wet: number,
  ): void {
    const ctx = this.ctx;
    const pool = this.pool;
    const noise = this.noise;
    if (ctx === null || pool === null || noise === null) return;

    const v = pool.acquire();
    const now = ctx.currentTime;

    v.filter.type = 'bandpass';
    v.filter.frequency.setValueAtTime(centre, now);
    v.filter.Q.setValueAtTime(q, now);
    v.panner.positionX.setValueAtTime(x, now);
    v.panner.positionY.setValueAtTime(y, now);
    v.panner.positionZ.setValueAtTime(z, now);
    v.send.gain.setValueAtTime(wet, now);

    v.gain.gain.cancelScheduledValues(now);
    v.gain.gain.setValueAtTime(0.0001, now);
    v.gain.gain.exponentialRampToValueAtTime(Math.max(level, 0.0002), now + 0.004);
    v.gain.gain.exponentialRampToValueAtTime(0.0001, now + decay);

    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = false;
    const offset = this.rng.float() * (NOISE_SECONDS - decay - 0.05);
    src.connect(v.filter);
    src.start(now, offset, decay + 0.02);
    src.stop(now + decay + 0.03);

    v.endsAt = now + decay + 0.06;
    v.active = true;
    this.active.push(v);
  }

  private thump(x: number, y: number, z: number, freq: number, level: number, decay: number): void {
    const ctx = this.ctx;
    const pool = this.pool;
    if (ctx === null || pool === null) return;

    const v = pool.acquire();
    const now = ctx.currentTime;

    v.filter.type = 'lowpass';
    v.filter.frequency.setValueAtTime(freq * 4, now);
    v.filter.Q.setValueAtTime(0.6, now);
    v.panner.positionX.setValueAtTime(x, now);
    v.panner.positionY.setValueAtTime(y, now);
    v.panner.positionZ.setValueAtTime(z, now);
    v.send.gain.setValueAtTime(0.12, now);

    v.gain.gain.cancelScheduledValues(now);
    v.gain.gain.setValueAtTime(0.0001, now);
    v.gain.gain.exponentialRampToValueAtTime(Math.max(level, 0.0002), now + 0.006);
    v.gain.gain.exponentialRampToValueAtTime(0.0001, now + decay);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * 1.6, now);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.7, now + decay);
    osc.connect(v.filter);
    osc.start(now);
    osc.stop(now + decay + 0.02);

    v.endsAt = now + decay + 0.05;
    v.active = true;
    this.active.push(v);
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.buses.clear();
    this.pool = null;
    this.active.length = 0;
    this.started = false;
  }
}

/** White noise, generated once and shared by every noise-based sound. */
function buildNoiseBuffer(ctx: AudioContext, rng: Rng, seconds: number): AudioBuffer {
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
function buildImpulseResponse(ctx: AudioContext, rng: Rng, seconds: number, decay: number): AudioBuffer {
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
