import * as THREE from 'three';
import type { CharacterAnimationId, CharacterDefinition } from './CharacterCatalog';
import { isLowStance, selectDeath, selectLocomotion } from './AnimationSelector';
import type { ActorAnimationInput } from '../../shared/ai/BotVisualState';

const CROSS_FADE_SECONDS = 0.14;

/**
 * Per-avatar animation state. Clips are shared templates, but the mixer and actions in this
 * class are never shared between characters.
 */
export class CharacterAnimator {
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<CharacterAnimationId, THREE.AnimationAction>();
  private active: { id: CharacterAnimationId; action: THREE.AnimationAction } | null = null;
  private transition: THREE.AnimationAction | null = null;
  private pendingLocomotion: CharacterAnimationId | null = null;
  private dead = false;
  private wasLow = false;

  private readonly onFinished = (event: { action?: THREE.AnimationAction }): void => {
    if (event.action !== this.transition) return;
    this.transition = null;
    const next = this.pendingLocomotion;
    this.pendingLocomotion = null;
    if (!this.dead && next !== null) this.playLoop(next);
  };

  constructor(
    private readonly root: THREE.Object3D,
    private readonly definition: CharacterDefinition,
    private readonly clips: ReadonlyMap<CharacterAnimationId, THREE.AnimationClip>,
  ) {
    this.mixer = new THREE.AnimationMixer(root);
    this.mixer.addEventListener('finished', this.onFinished);
  }

  get isDying(): boolean {
    return this.dead;
  }

  /**
   * Only supplied firearm-ready clips may receive the presentation support-hand constraint.
   * Sprint and the authored crouch-to-stand transition are relaxed poses, so forcing a second
   * hand onto a rifle there would bend the arm into a pose the source animation did not author.
   */
  get supportsWeaponSupportGrip(): boolean {
    switch (this.active?.id) {
      case 'idleWeaponReady':
      case 'walkWeaponReady':
      case 'crouchIdleAiming':
      case 'crouchWalkAiming':
      case 'crouchRunAiming':
        return true;
      default:
        return false;
    }
  }

  /** Select a loop from authoritative presentation state; never moves the actor transform. */
  setLocomotion(input: ActorAnimationInput, planarSpeed: number, armed: boolean): void {
    if (this.dead) return;

    const desired = selectLocomotion(input, planarSpeed, armed);
    const low = isLowStance(input);

    // The authored transition is useful only for the one low -> stand edge. All other stance
    // changes cross-fade between loops, which is safer than pretending the asset pack covers
    // slide, mantle, airborne, and every reverse transition.
    if (this.transition !== null) {
      this.pendingLocomotion = desired;
    } else if (this.wasLow && !low && this.hasClip('crouchToStand')) {
      this.pendingLocomotion = desired;
      this.transition = this.playOneShot('crouchToStand');
    } else {
      this.playLoop(desired);
    }

    this.wasLow = low;
  }

  beginDeath(input: ActorAnimationInput): void {
    this.dead = true;
    this.pendingLocomotion = null;
    this.transition = null;
    this.playOneShot(selectDeath(input));
  }

  endDeath(): void {
    if (!this.dead) return;
    this.dead = false;
    this.transition = null;
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
  }

  private hasClip(id: CharacterAnimationId): boolean {
    return this.clips.has(id);
  }

  private actionFor(id: CharacterAnimationId): THREE.AnimationAction {
    const existing = this.actions.get(id);
    if (existing !== undefined) return existing;

    const clip = this.clips.get(id);
    if (clip === undefined) throw new Error(`Character animation "${id}" was not preloaded.`);
    const action = this.mixer.clipAction(clip);
    const loop = this.definition.animations[id].loop;
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = !loop;
    this.actions.set(id, action);
    return action;
  }

  private playLoop(id: CharacterAnimationId): void {
    if (this.active?.id === id && this.transition === null) return;
    const next = this.actionFor(id);
    const previous = this.active?.action ?? null;
    next.reset();
    next.enabled = true;
    next.setEffectiveWeight(1);
    next.setEffectiveTimeScale(1);
    next.play();
    if (previous !== null && previous !== next) next.crossFadeFrom(previous, CROSS_FADE_SECONDS, true);
    this.active = { id, action: next };
  }

  private playOneShot(id: CharacterAnimationId): THREE.AnimationAction {
    const next = this.actionFor(id);
    const previous = this.active?.action ?? null;
    next.reset();
    next.enabled = true;
    next.setEffectiveWeight(1);
    next.setEffectiveTimeScale(1);
    next.play();
    if (previous !== null && previous !== next) next.crossFadeFrom(previous, CROSS_FADE_SECONDS, true);
    this.active = { id, action: next };
    return next;
  }
}
