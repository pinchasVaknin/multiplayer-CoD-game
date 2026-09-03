import type { AnnouncerCue } from '../../shared/core/Events';
import { surfaceAtIndex } from '../../shared/world/maps/materials';
import { VotePhase, type VotePhaseId } from '../../shared/net/Skirmish';
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
export type { BusName, NoiseSpec, OcclusionTest, OscSpec, ReverbSpec } from './AudioSpecs';

/** One formant-shaped noise band. `at` is seconds from the start of the phrase. */
interface Syllable {
  readonly at: number;
  readonly freq: number;
  readonly freqEnd: number;
  readonly q: number;
  readonly level: number;
  readonly decay: number;
}

interface AnnouncerPhrase {
  readonly syllables: readonly Syllable[];
  /** Overall level, so an urgent call can be louder than a routine one. */
  readonly level: number;
  /** The low body under the phrase, Hz. */
  readonly bodyFrom: number;
  readonly bodyTo: number;
}

/**
 * The announcer's phrase book.
 *
 * Every call is two or three formant bands and a low body. What separates them is *shape* —
 * a rising pair reads as good news, a falling triple as bad, three short bright ones as
 * urgency. These are the numbers to move if a call lands wrong; there is no other lever.
 */
const ANNOUNCER_PHRASES: Readonly<Record<AnnouncerCue, AnnouncerPhrase>> = {
  matchStart: {
    syllables: [
      { at: 0, freq: 520, freqEnd: 700, q: 5.5, level: 0.5, decay: 0.16 },
      { at: 0.2, freq: 640, freqEnd: 480, q: 6, level: 0.44, decay: 0.2 },
    ],
    level: 0.9,
    bodyFrom: 128,
    bodyTo: 96,
  },
  fight: {
    syllables: [{ at: 0, freq: 780, freqEnd: 1180, q: 7, level: 0.62, decay: 0.19 }],
    level: 1,
    bodyFrom: 170,
    bodyTo: 104,
  },
  twoMinutes: {
    syllables: [
      { at: 0, freq: 600, freqEnd: 760, q: 6, level: 0.42, decay: 0.13 },
      { at: 0.17, freq: 700, freqEnd: 560, q: 6, level: 0.4, decay: 0.16 },
    ],
    level: 0.78,
    bodyFrom: 118,
    bodyTo: 92,
  },
  oneMinute: {
    syllables: [
      { at: 0, freq: 680, freqEnd: 880, q: 6.5, level: 0.46, decay: 0.12 },
      { at: 0.15, freq: 820, freqEnd: 640, q: 6.5, level: 0.44, decay: 0.15 },
    ],
    level: 0.86,
    bodyFrom: 130,
    bodyTo: 98,
  },
  thirtySeconds: {
    syllables: [
      { at: 0, freq: 820, freqEnd: 1020, q: 7, level: 0.48, decay: 0.1 },
      { at: 0.12, freq: 960, freqEnd: 1140, q: 7, level: 0.46, decay: 0.1 },
      { at: 0.24, freq: 1100, freqEnd: 820, q: 7, level: 0.5, decay: 0.15 },
    ],
    level: 0.94,
    bodyFrom: 150,
    bodyTo: 108,
  },
  leadTaken: {
    syllables: [
      { at: 0, freq: 560, freqEnd: 760, q: 5.5, level: 0.4, decay: 0.13 },
      { at: 0.14, freq: 780, freqEnd: 1000, q: 6, level: 0.42, decay: 0.17 },
    ],
    level: 0.72,
    bodyFrom: 120,
    bodyTo: 150,
  },
  leadLost: {
    syllables: [
      { at: 0, freq: 720, freqEnd: 560, q: 5.5, level: 0.4, decay: 0.14 },
      { at: 0.14, freq: 520, freqEnd: 380, q: 6, level: 0.42, decay: 0.19 },
    ],
    level: 0.72,
    bodyFrom: 140,
    bodyTo: 90,
  },
  victory: {
    syllables: [
      { at: 0, freq: 560, freqEnd: 720, q: 5, level: 0.5, decay: 0.18 },
      { at: 0.2, freq: 760, freqEnd: 960, q: 5.5, level: 0.52, decay: 0.2 },
      { at: 0.42, freq: 1000, freqEnd: 1320, q: 6, level: 0.56, decay: 0.3 },
    ],
    level: 1,
    bodyFrom: 110,
    bodyTo: 180,
  },
  defeat: {
    syllables: [
      { at: 0, freq: 620, freqEnd: 500, q: 5, level: 0.46, decay: 0.2 },
      { at: 0.22, freq: 470, freqEnd: 370, q: 5.5, level: 0.46, decay: 0.24 },
      { at: 0.48, freq: 340, freqEnd: 250, q: 6, level: 0.5, decay: 0.36 },
    ],
    level: 1,
    bodyFrom: 130,
    bodyTo: 62,
  },
  draw: {
    syllables: [
      { at: 0, freq: 600, freqEnd: 600, q: 6, level: 0.46, decay: 0.2 },
      { at: 0.24, freq: 600, freqEnd: 540, q: 6, level: 0.46, decay: 0.28 },
    ],
    level: 0.9,
    bodyFrom: 112,
    bodyTo: 100,
  },
};

export class ProceduralAudio extends AudioGraph {
  /**
   * Footstep: a short band-passed noise burst, coloured by the surface underfoot.
   * Heavy steps sit lower and louder and pick up a body thump, which is what separates
   * a sprint from a walk by ear.
   */
  playFootstep(
    x: number,
    y: number,
    z: number,
    speed: number,
    heavy: boolean,
    material: number,
    gain = 1,
  ): void {
    if (!this.hasContext) return;
    const surface = surfaceAtIndex(material);
    const intensity = Math.min(1, 0.35 + speed / 9) * gain;

    const spec = this.noiseScratch;
    spec.roll = 'footstep';
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
    osc.roll = 'footstep';
    this.oscHit(osc);
  }

  /** Landing: fuller and lower than a footstep, scaled by impact speed. */
  playLanding(
    x: number,
    y: number,
    z: number,
    impactSpeed: number,
    material: number,
    gain = 1,
  ): void {
    if (!this.hasContext) return;
    const t = Math.min(1, impactSpeed / 11) * gain;
    if (t < 0.08) return;
    const surface = surfaceAtIndex(material);

    const spec = this.noiseScratch;
    spec.roll = 'footstep';
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

  /**
   * An announcer sting (brief S6.5).
   *
   * Filtered noise bands in the vocal formant range, sequenced on the audio clock — not
   * speech. Speech synthesis of actual lines is out of reach without assets and worse than
   * nothing when it lands badly, so what the player hears is the *shape* of a call: two
   * short syllables for a time warning, three rising ones for a win, three falling for a
   * loss. A band-passed noise burst with a formant sweep and a Q around six is recognisably
   * voice-shaped without pretending to be a word.
   *
   * Everything goes on the `ui` bus, which is routed around the world's low-pass and the
   * duck — so a call still cuts through when you are on 12 HP and the world has gone woolly.
   * The world ducks under it for the length of the phrase.
   */
  playAnnouncer(cue: AnnouncerCue): void {
    if (!this.hasContext) return;
    const phrase = ANNOUNCER_PHRASES[cue];
    let span = 0;

    for (const syllable of phrase.syllables) {
      const spec = this.noiseScratch;
      spec.x = 0;
      spec.y = 0;
      spec.z = 0;
      spec.positional = false;
      spec.bus = 'ui';
      spec.filter = 'bandpass';
      spec.freq = syllable.freq;
      spec.freqEnd = syllable.freqEnd;
      spec.q = syllable.q;
      spec.level = syllable.level * phrase.level;
      spec.attack = 0.012;
      spec.decay = syllable.decay;
      spec.wet = 0;
      spec.rate = 1;
      this.noiseBurst(spec, syllable.at);
      span = Math.max(span, syllable.at + syllable.decay);
    }

    // A low body under the phrase, so a call has authority rather than sounding like static.
    const body = this.oscScratch;
    body.x = 0;
    body.y = 0;
    body.z = 0;
    body.positional = false;
    body.bus = 'ui';
    body.type = 'sine';
    body.freq = phrase.bodyFrom;
    body.freqEnd = phrase.bodyTo;
    body.level = 0.3 * phrase.level;
    body.attack = 0.01;
    body.decay = Math.max(0.18, span * 0.7);
    body.wet = 0;
    body.filterFreq = 700;
    body.filterQ = 0.7;
    this.oscHit(body);

    this.duckWorld(span + 0.3);
  }

  /**
   * One heartbeat: lub, then dub (brief S6.4).
   *
   * On the `ui` bus and non-positional, because it is inside the player's head rather than
   * somewhere in the room — which is also why it is the one sound that gets *louder* as the
   * world gets quieter. `intensity` is 0..1 and comes from how far below the low-health
   * threshold the player is.
   */
  playHeartbeat(intensity: number): void {
    if (!this.hasContext) return;
    const t = Math.max(0, Math.min(1, intensity));
    const level = 0.34 + 0.4 * t;

    const beat = this.oscScratch;
    beat.x = 0;
    beat.y = 0;
    beat.z = 0;
    beat.positional = false;
    beat.bus = 'ui';
    beat.type = 'sine';
    beat.filterFreq = 220;
    beat.filterQ = 0.9;
    beat.wet = 0;

    beat.freq = 58;
    beat.freqEnd = 36;
    beat.level = level;
    beat.attack = 0.008;
    beat.decay = 0.17;
    this.oscHit(beat);

    // The second beat is quieter and closer than a listener expects, which is what makes
    // two thumps read as one heart rather than two drums.
    beat.freq = 50;
    beat.freqEnd = 32;
    beat.level = level * 0.72;
    beat.attack = 0.008;
    beat.decay = 0.14;
    this.oscHit(beat, 0.155);
  }

  /**
   * The ring after a flashbang (M5, S6.3).
   *
   * A long, quiet, very high sine on the `ui` bus, non-positional. It is inside the head
   * like the heartbeat, and for the same reason it must not be routed through the world:
   * the flash installs a low-pass on everything *else*, and a ring behind that low-pass
   * would be the one sound the effect made inaudible.
   */
  playRing(intensity: number): void {
    if (!this.hasContext) return;
    const t = Math.max(0, Math.min(1, intensity));
    const spec = this.oscScratch;
    spec.x = 0;
    spec.y = 0;
    spec.z = 0;
    spec.positional = false;
    spec.bus = 'ui';
    spec.type = 'sine';
    spec.freq = 4200;
    spec.freqEnd = 3100;
    spec.level = 0.1 + 0.16 * t;
    spec.attack = 0.02;
    spec.decay = 1.2 + 2.4 * t;
    spec.wet = 0;
    spec.filterFreq = 12000;
    spec.filterQ = 0.7;
    this.oscHit(spec);
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

  /**
   * A ballot opening (M11 §6.4; playtest round 4, F13).
   *
   * Two rising notes on the `ui` bus, non-positional, because it is a thing the *interface* just
   * did rather than a thing that happened somewhere in the room. It has to cut through a
   * firefight — §4.20's whole premise is that the ballot arrives while you are still shooting —
   * without reading as a threat: a rising pair asks a question, and every falling cue in the
   * project already means something bad (`playUiSweep(720, 300, ...)` is the dry fire).
   *
   * **One generator, two pitches.** The mode ballot and the map ballot are two stages of one
   * question, so the map's cue is the same figure a fourth higher rather than a different sound:
   * recognisably the same event, and distinguishable without looking up from the fight. A second
   * sound would have to be designed against this one and would drift from it.
   *
   * The second note is delayed with `oscHit`'s own `delay` argument, which is the mechanism this
   * file already has for a multi-part sting. It was a slow `attack` in the first version, and
   * that was wrong: `AudioGraph.oscHit` schedules the voice's release from `decay` alone
   * (`endsAt = now + decay + 0.05`, `osc.stop(now + decay + 0.02)`), so an attack longer than a
   * moment is an envelope the voice is recycled out from under. `delay` moves the whole voice —
   * envelope, sweep and source — onto the audio clock instead.
   *
   * Fired on the phase **edge** and never on the broadcast — see `ballotOpened`, and
   * `VoteOverlay.apply` for where the edge is taken.
   */
  playBallotOpen(phase: VotePhaseId): void {
    if (!this.hasContext) return;
    // A fourth up for the map, which is the second half of the same question.
    const root = phase === VotePhase.MAP_VOTE ? 587 : 440;

    this.playUiSweep(root, root * 4 / 3, 0.22, 0.16);

    const second = this.oscScratch;
    second.x = 0;
    second.y = 0;
    second.z = 0;
    second.positional = false;
    second.bus = 'ui';
    second.type = 'triangle';
    second.freq = root * 4 / 3;
    second.freqEnd = root * 2;
    second.level = 0.16;
    second.attack = 0.006;
    second.decay = 0.28;
    second.wet = 0.12;
    second.filterFreq = 9000;
    second.filterQ = 0.7;
    this.oscHit(second, 0.12);
  }

  /**
   * One XP row landing on the summary screen (M6, S6.1).
   *
   * A short bright blip that climbs a fifth over the first eight rows and then holds. The
   * climb is what makes a long breakdown feel like it is *building* rather than repeating,
   * and it is capped because a twelve-row match should not end on a whistle.
   */
  playXpTick(index: number): void {
    const step = Math.min(index, 7);
    const freq = 880 * Math.pow(2, step / 24);
    this.playUiSweep(freq, freq * 1.35, 0.085, 0.09);
  }

  /**
   * The level-up flourish (M6, S6.1: "give it weight, timing and audio").
   *
   * Three layers, and the low one is the whole point: a rising sine gives the *shape*, a
   * band of filtered noise gives it air, and a low body an octave under gives it the
   * weight that separates a level-up from a menu confirmation. Everything is on the `ui`
   * bus and non-positional, because it happens to you rather than somewhere in the room.
   */
  playLevelUp(): void {
    if (!this.hasContext) return;

    this.playUiSweep(392, 1046, 0.3, 0.62);

    const body = this.oscScratch;
    body.x = 0;
    body.y = 0;
    body.z = 0;
    body.positional = false;
    body.bus = 'ui';
    body.type = 'triangle';
    body.freq = 98;
    body.freqEnd = 196;
    body.level = 0.34;
    body.attack = 0.012;
    body.decay = 0.75;
    body.wet = 0.18;
    body.filterFreq = 2600;
    body.filterQ = 0.9;
    this.oscHit(body);

    const air = this.noiseScratch;
    air.x = 0;
    air.y = 0;
    air.z = 0;
    air.positional = false;
    air.bus = 'ui';
    air.filter = 'bandpass';
    air.freq = 3200;
    air.freqEnd = 6400;
    air.q = 1.4;
    air.level = 0.16;
    air.attack = 0.006;
    air.decay = 0.34;
    air.wet = 0.3;
    air.rate = 1;
    this.noiseBurst(air);
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
