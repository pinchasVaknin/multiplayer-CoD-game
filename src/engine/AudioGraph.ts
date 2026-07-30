import { ObjectPool } from '../core/ObjectPool';
import { Rng } from '../core/Rng';
import {
  buildImpulseResponse,
  buildNoiseBuffer,
  DEFAULT_REVERB,
  makeNoiseSpec,
  makeOscSpec,
  NOISE_SECONDS,
  type BusName,
  type NoiseSpec,
  type OcclusionTest,
  type OscSpec,
  type ReverbSpec,
} from './AudioSpecs';

/**
 * The Web Audio graph and the two synthesis primitives everything else is built from
 * (brief S4.5, S6.7). Synthesis only — no files, no CDN.
 *
 * Graph, built exactly once:
 *
 *   source -> filter -> occlusion -> gain -+-> spatial -> panner -> sfx -+-> master
 *                                          +-> flat ------------> ui  --+
 *                                          `-> send -> reverbSend -> convolver -> master
 *
 * There is exactly ONE ConvolverNode in the process, on a send. Never one per source,
 * never one per shot. The impulse response is generated, not loaded.
 *
 * Voices are pooled. A 700 RPM weapon fires twelve times a second and each shot is four
 * layers; building a node graph per layer is how a browser FPS ends up hitching audibly
 * within a magazine. The only nodes created per sound are the one-shot source and
 * oscillator nodes, which the spec requires to be single-use.
 */

interface Voice {
  filter: BiquadFilterNode;
  occlusion: BiquadFilterNode;
  gain: GainNode;
  spatial: GainNode;
  panner: PannerNode;
  flat: GainNode;
  send: GainNode;
  /** ctx.currentTime at which this voice may be recycled. */
  endsAt: number;
}

/** Preallocated to cover sustained automatic fire plus footsteps and impacts. */
const VOICE_POOL_SIZE = 128;

/**
 * Hard ceiling on voices sounding at once (M3).
 *
 * M2 sized the pool for one shooter. Ten bots at 700 RPM are a different problem: four
 * layers a shot, several bots firing at once, and every voice released on a timestamp
 * taken from `AudioContext.currentTime` — which advances in *wall clock*. The moment the
 * simulation runs faster than real time, which is exactly what S7's harness speed
 * multiplier does, sounds are created faster than they can possibly expire and the pool
 * grows without bound. The ten-minute soak found it: 64 voices to 81,117.
 *
 * A ceiling makes that impossible from either direction. Past it a new sound is dropped
 * rather than allocated, and dropping a gunshot while a hundred are already sounding is
 * inaudible — where an unbounded pool is a leak and, because `update` scans the active
 * list every frame, eventually a frame-time problem too.
 */
const MAX_ACTIVE_VOICES = 112;

/** Cutoff applied when the spatial-hash raycaster says geometry is in the way. */
const OCCLUDED_CUTOFF = 750;
const OPEN_CUTOFF = 20000;

/**
 * The world low-pass, fully muffled (brief S6.4).
 *
 * Below 35 HP the whole world goes behind a wall of wool while your own heartbeat and the
 * announcer stay in front of it. 620 Hz is far enough down that gunfire loses its crack —
 * which is the point: the muffle has to be information, not decoration.
 */
const MUFFLED_CUTOFF = 620;

/** How far the world is pulled down under an announcer sting, and how fast. */
const DUCK_FLOOR = 0.34;
const DUCK_ATTACK = 0.04;
const DUCK_RELEASE = 0.22;

const noiseScratch = makeNoiseSpec();
const oscScratch = makeOscSpec();

export class AudioGraph {
  protected ctx: AudioContext | null = null;
  protected noise: AudioBuffer | null = null;
  protected readonly rng = new Rng(0x5eed_f007);

  private master: GainNode | null = null;
  private readonly buses = new Map<BusName, GainNode>();
  private reverbSend: GainNode | null = null;
  /** The one convolver, retained so a map can swap its buffer without a second one. */
  private convolver: ConvolverNode | null = null;
  /** World duck, automated under announcer stings. `ui` bypasses it deliberately. */
  private duckGain: GainNode | null = null;
  /** World low-pass, for the low-health muffle. Also bypassed by `ui`. */
  private worldFilter: BiquadFilterNode | null = null;
  private duckUntil = 0;
  private muffle = 0;

  private pool: ObjectPool<Voice> | null = null;
  private readonly active: Voice[] = [];

  private slideSource: AudioBufferSourceNode | null = null;
  private slideGain: GainNode | null = null;
  private slidePanner: PannerNode | null = null;

  private occlusionTest: OcclusionTest | null = null;
  private masterVolume = 0.8;
  private started = false;

  /** Diagnostics: one-shot source nodes started since load. A rate, not a leak. */
  sourcesStarted = 0;
  /** Sounds refused because `MAX_ACTIVE_VOICES` was already sounding. Reported in F1. */
  voicesDropped = 0;

  get isRunning(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  get voiceCount(): number {
    return this.active.length;
  }

  /** Pooled voices ever constructed. Must stay at VOICE_POOL_SIZE (S8.6). */
  get poolSize(): number {
    return this.pool?.size ?? 0;
  }

  get poolPeak(): number {
    return this.pool?.peak ?? 0;
  }

  /** A reusable spec, so callers do not allocate one per sound. */
  get noiseScratch(): NoiseSpec {
    return noiseScratch;
  }

  get oscScratch(): OscSpec {
    return oscScratch;
  }

  /** Wire the spatial-hash raycaster in for occlusion (S6.7). */
  setOccluder(test: OcclusionTest | null): void {
    this.occlusionTest = test;
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

    /**
     * Two nodes sit between the world and the master, and `ui` is routed around both:
     *
     *   sfx --------+-> worldFilter -> duck -> master
     *   reverbReturn +
     *   music -----------------------------> master
     *   ui --------------------------------> master
     *
     * `worldFilter` is the low-health muffle and `duck` is the announcer duck, so a sting
     * and your own heartbeat stay in front of a world that has gone quiet and woolly. Both
     * are built once here — there is no per-source filtering added by either (S4.5).
     */
    const duckGain = ctx.createGain();
    duckGain.gain.value = 1;
    duckGain.connect(master);
    this.duckGain = duckGain;

    const worldFilter = ctx.createBiquadFilter();
    worldFilter.type = 'lowpass';
    worldFilter.frequency.value = OPEN_CUTOFF;
    worldFilter.Q.value = 0.5;
    worldFilter.connect(duckGain);
    this.worldFilter = worldFilter;

    for (const name of ['sfx', 'music', 'ui'] as const) {
      const bus = ctx.createGain();
      bus.gain.value = 1;
      bus.connect(name === 'sfx' ? worldFilter : master);
      this.buses.set(name, bus);
    }

    // The one and only convolver, on a send.
    const convolver = ctx.createConvolver();
    convolver.buffer = buildImpulseResponse(ctx, this.rng, DEFAULT_REVERB);
    this.convolver = convolver;
    const reverbSend = ctx.createGain();
    reverbSend.gain.value = 1;
    const reverbReturn = ctx.createGain();
    reverbReturn.gain.value = 0.5;
    reverbSend.connect(convolver);
    convolver.connect(reverbReturn);
    reverbReturn.connect(worldFilter);
    this.reverbSend = reverbSend;

    this.noise = buildNoiseBuffer(ctx, this.rng, NOISE_SECONDS);

    const sfx = this.buses.get('sfx');
    const ui = this.buses.get('ui');
    if (sfx === undefined || ui === undefined) throw new Error('[Audio] buses missing');

    this.pool = new ObjectPool<Voice>(
      () => this.buildVoice(ctx, sfx, ui, reverbSend),
      (v) => {
        v.gain.gain.cancelScheduledValues(0);
        v.gain.gain.value = 0;
      },
      VOICE_POOL_SIZE,
      'audio-voice',
    );

    this.buildSlideVoice(ctx, sfx);

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

  /**
   * Swap the room the single convolver is modelling (brief S6.6).
   *
   * Assigns a new buffer to the convolver that already exists. This is the whole mechanism
   * for per-map reverb, and it is the reason `MAX_ACTIVE_VOICES` and the one-convolver rule
   * survive a map change: nothing is constructed.
   */
  setReverb(spec: ReverbSpec | null): void {
    const ctx = this.ctx;
    const convolver = this.convolver;
    if (ctx === null || convolver === null) return;
    convolver.buffer = buildImpulseResponse(ctx, this.rng, spec ?? DEFAULT_REVERB);
  }

  /**
   * Duck the world for `seconds` (brief S6.5).
   *
   * Overlapping stings extend the hold rather than restarting the ramp, so two cues 200 ms
   * apart are one duck and not an audible pump.
   */
  duckWorld(seconds: number): void {
    const ctx = this.ctx;
    const duck = this.duckGain;
    if (ctx === null || duck === null) return;
    const now = ctx.currentTime;
    const until = now + Math.max(0.05, seconds);
    if (until <= this.duckUntil) return;
    this.duckUntil = until;
    duck.gain.cancelScheduledValues(now);
    duck.gain.setTargetAtTime(DUCK_FLOOR, now, DUCK_ATTACK);
    duck.gain.setTargetAtTime(1, until, DUCK_RELEASE);
  }

  /**
   * Muffle the world, 0..1 (brief S6.4).
   *
   * Driven per frame from the player's health rather than fired as an event, because it is a
   * *state* and not a moment: a linear cutoff sweep on one filter, exponential in frequency
   * so the change is audible across the whole range rather than only near the top.
   */
  setMuffle(amount: number): void {
    const filter = this.worldFilter;
    const ctx = this.ctx;
    if (filter === null || ctx === null) return;
    const clamped = Math.max(0, Math.min(1, amount));
    if (Math.abs(clamped - this.muffle) < 0.01) return;
    this.muffle = clamped;
    const cutoff = OPEN_CUTOFF * Math.pow(MUFFLED_CUTOFF / OPEN_CUTOFF, clamped);
    filter.frequency.setTargetAtTime(cutoff, ctx.currentTime, 0.12);
  }

  get muffleAmount(): number {
    return this.muffle;
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

  // -- the two primitives ----------------------------------------------------

  /**
   * Filtered noise burst with an optional filter sweep. The workhorse.
   *
   * `delay` schedules the whole voice — envelope, sweep and source — `delay` seconds into
   * the future on the audio clock. That is what lets a multi-syllable announcer sting be
   * three calls rather than three `setTimeout`s racing the render loop.
   */
  noiseBurst(spec: NoiseSpec, delay = 0): void {
    const ctx = this.ctx;
    const pool = this.pool;
    const noise = this.noise;
    if (ctx === null || pool === null || noise === null) return;
    // A suspended context's `currentTime` is frozen, so nothing could ever be recycled.
    if (ctx.state !== 'running') return;
    if (this.active.length >= MAX_ACTIVE_VOICES) {
      this.voicesDropped++;
      return;
    }

    const v = pool.acquire();
    const now = ctx.currentTime + Math.max(0, delay);
    const decay = Math.max(spec.decay, 0.005);

    v.filter.type = spec.filter;
    v.filter.frequency.cancelScheduledValues(now);
    v.filter.frequency.setValueAtTime(Math.max(spec.freq, 20), now);
    if (Math.abs(spec.freqEnd - spec.freq) > 1) {
      v.filter.frequency.exponentialRampToValueAtTime(Math.max(spec.freqEnd, 20), now + decay);
    }
    v.filter.Q.setValueAtTime(Math.max(spec.q, 0.0001), now);

    this.routeVoice(v, spec.positional, spec.bus, spec.x, spec.y, spec.z, spec.wet, now);
    this.envelope(v, now, spec.level, spec.attack, decay);

    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.playbackRate.value = Math.max(0.25, spec.rate);
    const span = decay + 0.02;
    const maxOffset = Math.max(0, NOISE_SECONDS - span * src.playbackRate.value - 0.05);
    src.connect(v.filter);
    src.start(now, this.rng.float() * maxOffset, span);
    src.stop(now + span + 0.01);
    this.sourcesStarted++;

    v.endsAt = now + decay + 0.06;
    this.active.push(v);
  }

  /** Oscillator with a pitch sweep. Body thumps, mechanical clicks, UI blips. */
  oscHit(spec: OscSpec, delay = 0): void {
    const ctx = this.ctx;
    const pool = this.pool;
    if (ctx === null || pool === null) return;
    // See `noiseBurst`: no voice may be acquired while the clock that frees it is stopped.
    if (ctx.state !== 'running') return;
    if (this.active.length >= MAX_ACTIVE_VOICES) {
      this.voicesDropped++;
      return;
    }

    const v = pool.acquire();
    const now = ctx.currentTime + Math.max(0, delay);
    const decay = Math.max(spec.decay, 0.005);

    v.filter.type = 'lowpass';
    v.filter.frequency.cancelScheduledValues(now);
    v.filter.frequency.setValueAtTime(Math.max(spec.filterFreq, 40), now);
    v.filter.Q.setValueAtTime(Math.max(spec.filterQ, 0.0001), now);

    this.routeVoice(v, spec.positional, spec.bus, spec.x, spec.y, spec.z, spec.wet, now);
    this.envelope(v, now, spec.level, spec.attack, decay);

    const osc = ctx.createOscillator();
    osc.type = spec.type;
    osc.frequency.setValueAtTime(Math.max(spec.freq, 1), now);
    if (Math.abs(spec.freqEnd - spec.freq) > 0.5) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(spec.freqEnd, 1), now + decay);
    }
    osc.connect(v.filter);
    osc.start(now);
    osc.stop(now + decay + 0.02);
    this.sourcesStarted++;

    v.endsAt = now + decay + 0.05;
    this.active.push(v);
  }

  /**
   * The one sustained source in the graph: a looping, band-passed noise bed used for the
   * slide scrape. Bursts cannot express a continuous event, and M1 played footsteps
   * through a slide because of it (see PLAN.md).
   */
  setSustainedBed(active: boolean, x: number, y: number, z: number, level: number, freq: number): void {
    const ctx = this.ctx;
    const gain = this.slideGain;
    const panner = this.slidePanner;
    if (ctx === null || gain === null || panner === null || this.slideSource === null) return;
    const now = ctx.currentTime;
    panner.positionX.setValueAtTime(x, now);
    panner.positionY.setValueAtTime(y, now);
    panner.positionZ.setValueAtTime(z, now);
    this.slideFilter?.frequency.setTargetAtTime(freq, now, 0.05);
    gain.gain.cancelScheduledValues(now);
    gain.gain.setTargetAtTime(active ? level : 0.0001, now, active ? 0.02 : 0.06);
  }

  dispose(): void {
    this.slideSource?.disconnect();
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.buses.clear();
    this.pool = null;
    this.active.length = 0;
    this.slideSource = null;
    this.slideGain = null;
    this.slidePanner = null;
    this.slideFilter = null;
    this.convolver = null;
    this.duckGain = null;
    this.worldFilter = null;
    this.started = false;
  }

  /**
   * Reset the per-match audio state without touching the graph.
   *
   * Called on match teardown. The muffle and the duck are *match* state — leaving a 620 Hz
   * low-pass on the world because the player happened to die on 12 HP is exactly the kind of
   * leaked state S6.3 is warning about.
   */
  resetMatchState(): void {
    const ctx = this.ctx;
    this.duckUntil = 0;
    this.muffle = 0;
    if (ctx === null) return;
    const now = ctx.currentTime;
    this.duckGain?.gain.cancelScheduledValues(now);
    if (this.duckGain !== null) this.duckGain.gain.setValueAtTime(1, now);
    this.worldFilter?.frequency.cancelScheduledValues(now);
    this.worldFilter?.frequency.setValueAtTime(OPEN_CUTOFF, now);
  }

  // -- internals -------------------------------------------------------------

  private slideFilter: BiquadFilterNode | null = null;

  private buildVoice(ctx: AudioContext, sfx: GainNode, ui: GainNode, reverbSend: GainNode): Voice {
    const filter = ctx.createBiquadFilter();
    const occlusion = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    const spatial = ctx.createGain();
    const panner = ctx.createPanner();
    const flat = ctx.createGain();
    const send = ctx.createGain();

    occlusion.type = 'lowpass';
    occlusion.frequency.value = OPEN_CUTOFF;
    occlusion.Q.value = 0.7;

    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1.6;
    panner.maxDistance = 90;
    panner.rolloffFactor = 1.1;

    gain.gain.value = 0;
    spatial.gain.value = 1;
    flat.gain.value = 0;

    filter.connect(occlusion);
    occlusion.connect(gain);
    gain.connect(spatial);
    spatial.connect(panner);
    panner.connect(sfx);
    gain.connect(flat);
    flat.connect(ui);
    gain.connect(send);
    send.connect(reverbSend);

    return { filter, occlusion, gain, spatial, panner, flat, send, endsAt: 0 };
  }

  private buildSlideVoice(ctx: AudioContext, sfx: GainNode): void {
    const noise = this.noise;
    const reverbSend = this.reverbSend;
    if (noise === null || reverbSend === null) return;

    const source = ctx.createBufferSource();
    source.buffer = noise;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 640;
    filter.Q.value = 0.9;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1.6;
    panner.maxDistance = 60;
    const send = ctx.createGain();
    send.gain.value = 0.18;

    source.connect(filter);
    filter.connect(gain);
    gain.connect(panner);
    panner.connect(sfx);
    gain.connect(send);
    send.connect(reverbSend);
    source.start();

    this.slideSource = source;
    this.slideGain = gain;
    this.slidePanner = panner;
    this.slideFilter = filter;
  }

  private routeVoice(
    v: Voice,
    positional: boolean,
    bus: BusName,
    x: number,
    y: number,
    z: number,
    wet: number,
    now: number,
  ): void {
    // `music` has no voice path of its own yet; a caller asking for it gets the flat
    // route, which is the honest answer rather than silently playing on sfx.
    const flatRoute = !positional || bus !== 'sfx';
    v.spatial.gain.setValueAtTime(flatRoute ? 0 : 1, now);
    v.flat.gain.setValueAtTime(flatRoute ? 1 : 0, now);
    v.send.gain.setValueAtTime(Math.max(0, wet), now);

    if (flatRoute) {
      v.occlusion.frequency.setValueAtTime(OPEN_CUTOFF, now);
      return;
    }

    v.panner.positionX.setValueAtTime(x, now);
    v.panner.positionY.setValueAtTime(y, now);
    v.panner.positionZ.setValueAtTime(z, now);

    // Occlusion: one raycast against the same 4 m hash the broadphase uses.
    const blocked = this.occlusionTest !== null && this.occlusionTest(x, y, z);
    v.occlusion.frequency.setValueAtTime(blocked ? OCCLUDED_CUTOFF : OPEN_CUTOFF, now);
  }

  private envelope(v: Voice, now: number, level: number, attack: number, decay: number): void {
    const peak = Math.max(level, 0.0002);
    const rise = Math.max(attack, 0.001);
    v.gain.gain.cancelScheduledValues(now);
    v.gain.gain.setValueAtTime(0.0001, now);
    v.gain.gain.exponentialRampToValueAtTime(peak, now + rise);
    v.gain.gain.exponentialRampToValueAtTime(0.0001, now + rise + decay);
  }
}
