import * as THREE from 'three';
import type { CharacterAnimationDefinition, CharacterAnimationId, CharacterDefinition } from './CharacterCatalog';
import { isLowStance, selectAction, selectDeath, selectLocomotion } from './AnimationSelector';
import { variantFor } from './AnimationVariant';
import type { ActorAnimationInput } from '../../shared/ai/BotVisualState';

const CROSS_FADE_SECONDS = 0.14;

/** One variant of one slot, resolved: the action and the catalogue entry it came from. */
interface Playing {
  readonly id: CharacterAnimationId;
  readonly definition: CharacterAnimationDefinition;
  readonly action: THREE.AnimationAction;
}

/**
 * Per-avatar animation state. Clips are shared templates, but the mixer and actions in this
 * class are never shared between characters.
 *
 * Four kinds of thing play here, in priority order:
 *
 * 1. a **death**, which ends everything else until `endDeath`;
 * 2. a **transition** (`standToCrouch` / `crouchToStand`) when the stance crosses the crouch
 *    edge — the requested loop waits for it to finish;
 * 3. an **action** one-shot (a reload) that stands in for the locomotion loop while the input
 *    says the actor is doing it, then hands back to the loop;
 * 4. the **locomotion loop** the selector names.
 *
 * Which variant of a slot plays is `variantFor`'s answer from `setLife` (M13 Phase D); this
 * class never chooses one itself.
 */
export class CharacterAnimator {
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private active: Playing | null = null;
  private transition: Playing | null = null;
  private action: Playing | null = null;
  private pendingLocomotion: CharacterAnimationId | null = null;
  private dead = false;
  private wasLow = false;
  private entityId = 0;
  private spawnSerial = 0;

  private readonly onFinished = (event: { action?: THREE.AnimationAction }): void => {
    if (event.action !== this.transition?.action) return;
    this.transition = null;
    const next = this.pendingLocomotion;
    this.pendingLocomotion = null;
    if (!this.dead && next !== null) this.playLoop(next);
  };

  constructor(
    private readonly root: THREE.Object3D,
    private readonly definition: CharacterDefinition,
    private readonly clips: ReadonlyMap<CharacterAnimationId, readonly THREE.AnimationClip[]>,
  ) {
    this.mixer = new THREE.AnimationMixer(root);
    this.mixer.addEventListener('finished', this.onFinished);
  }

  get isDying(): boolean {
    return this.dead;
  }

  /**
   * Whether the clip playing now holds a firearm, and so may receive the presentation
   * support-hand constraint. The answer is the catalog's — see
   * `CharacterAnimationDefinition.weaponReady` — not a list kept here.
   */
  get supportsWeaponSupportGrip(): boolean {
    const active = this.active;
    return active !== null && active.definition.weaponReady;
  }

  /**
   * Which life this body is on. Locomotion variants are dealt from it, so they are re-dealt
   * at every respawn and identical on every client (see `variantFor`).
   */
  setLife(entityId: number, spawnSerial: number): void {
    this.entityId = entityId;
    this.spawnSerial = spawnSerial;
  }

  /** Select a loop from authoritative presentation state; never moves the actor transform. */
  setLocomotion(input: ActorAnimationInput, planarSpeed: number, armed: boolean): void {
    if (this.dead) return;

    const desired = selectLocomotion(input, planarSpeed, armed);
    const low = isLowStance(input);

    // The crouch edge has an authored transition in each direction (M13 D; before the
    // library had `standToCrouch`, the way down was `crouchToStand` played backwards, and the
    // trap in that — the cross-fade's time warp divides by the time scale and flips a negative
    // one — is on record in PLAN.md, Phase C3). The loop that was asked for waits until the
    // transition finishes. Every other stance change cross-fades between loops, which is
    // safer than pretending the asset pack covers slide, mantle and airborne.
    if (this.transition !== null) {
      this.pendingLocomotion = desired;
    } else if (this.wasLow !== low) {
      this.pendingLocomotion = desired;
      this.action = null;
      this.transition = this.playOneShot(low ? 'standToCrouch' : 'crouchToStand', 0);
    } else {
      const action = selectAction(input, planarSpeed);
      if (action !== null) {
        if (this.action?.id !== action) {
          this.action = this.playOneShot(action, 0);
          fitToSeconds(this.action.action, input.reloadSeconds);
        }
      } else {
        this.action = null;
        this.playLoop(desired);
      }
    }

    this.wasLow = low;
  }

  /**
   * `variant` is the simulation's `deathVariant`, already dealt from `(entityId, deathSerial)`
   * and identical on the server, so the slot's clips are indexed by it rather than dealt again
   * here; `DEATH_VARIANTS` stays the simulation's count and the catalogue's is folded into it
   * (`check:animations` keeps the two dividing).
   */
  beginDeath(input: ActorAnimationInput, variant: number): void {
    this.dead = true;
    this.pendingLocomotion = null;
    this.transition = null;
    this.action = null;
    const id = selectDeath(input);
    const count = this.clips.get(id)?.length ?? 0;
    this.playOneShot(id, count > 0 ? ((variant % count) + count) % count : 0);
  }

  endDeath(): void {
    if (!this.dead) return;
    this.dead = false;
    this.transition = null;
    this.action = null;
    this.pendingLocomotion = null;
    this.wasLow = false;
    this.active = null;
    this.mixer.stopAllAction();
    // Flush property bindings so the respawn starts from its bind pose, not the final death
    // frame. The next `setLocomotion` call starts the correct loop.
    this.mixer.update(0);
  }

  update(dt: number): void {
    if (dt > 0) this.mixer.update(dt);
  }

  dispose(): void {
    this.mixer.removeEventListener('finished', this.onFinished);
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    this.actions.clear();
    this.active = null;
    this.transition = null;
    this.action = null;
  }

  /** The variant of a locomotion slot this life wears. */
  private lifeVariant(id: CharacterAnimationId): number {
    return variantFor(id, this.entityId, this.spawnSerial, this.clips.get(id)?.length ?? 0);
  }

  private resolve(id: CharacterAnimationId, variant: number): Playing {
    const variants = this.clips.get(id);
    const clip = variants?.[variant];
    const definition = this.definition.animations[id][variant];
    if (clip === undefined || definition === undefined) {
      throw new Error(`Character animation "${id}" variant ${variant} was not preloaded.`);
    }
    const key = `${id}/${variant}`;
    let action = this.actions.get(key);
    if (action === undefined) {
      action = this.mixer.clipAction(clip);
      action.setLoop(definition.loop ? THREE.LoopRepeat : THREE.LoopOnce, definition.loop ? Infinity : 1);
      action.clampWhenFinished = !definition.loop;
      this.actions.set(key, action);
    }
    return { id, definition, action };
  }

  private playLoop(id: CharacterAnimationId): void {
    if (this.active?.id === id && this.transition === null) return;
    const next = this.resolve(id, this.lifeVariant(id));
    const previous = this.active?.action ?? null;
    next.action.reset();
    next.action.enabled = true;
    next.action.setEffectiveWeight(1);
    next.action.setEffectiveTimeScale(1);
    next.action.play();
    if (previous !== null && previous !== next.action) next.action.crossFadeFrom(previous, CROSS_FADE_SECONDS, true);
    this.active = next;
  }

  private playOneShot(id: CharacterAnimationId, variant: number): Playing {
    const next = this.resolve(id, variant);
    const previous = this.active?.action ?? null;
    next.action.reset();
    next.action.enabled = true;
    next.action.setEffectiveWeight(1);
    next.action.setEffectiveTimeScale(1);
    next.action.play();
    if (previous !== null && previous !== next.action) next.action.crossFadeFrom(previous, CROSS_FADE_SECONDS, true);
    this.active = next;
    return next;
  }
}

/**
 * Play a one-shot so it ends when the thing it depicts does. A 3.3 s reload clip on a 1.7 s
 * SMG plays at ×1.95 and is over when the magazine is; on a 4.4 s LMG it plays at ×0.75. Left
 * alone when the duration is unknown (0), and never made absurd: a clip is not stretched past
 * three times its length or squeezed under a third.
 */
function fitToSeconds(action: THREE.AnimationAction, seconds: number): void {
  if (!(seconds > 0)) return;
  const duration = action.getClip().duration;
  if (!(duration > 0)) return;
  const scale = THREE.MathUtils.clamp(duration / seconds, 1 / 3, 3);
  action.setEffectiveTimeScale(scale);
}
