import { makeBotVisualState, type BotVisualState, type RenderableActor } from '../../shared/ai/BotVisualState';
import type { BotTeam } from '../../shared/ai/Combatant';
import { DEATH_VARIANTS, deathVariantFor } from '../../shared/ai/BotVisualState';
import { HitboxRig, HUMANOID_RIG } from '../../shared/combat/HitboxRig';
import {
  makeInterpolatedPose,
  type EntityInterpolator,
  type InterpolatedPose,
} from '../../shared/net/Interpolation';
import { EFlag, weaponIdAt, type EntitySnapshot } from '../../shared/net/Snapshot';
import type { StanceId } from '../../shared/player/Stance';

/**
 * Another player, drawn from snapshots (M10, S6.5).
 *
 * A `RenderableActor`, so `BotRenderer` draws it with the M3 bot mesh, the M3 stance
 * handling and the M3 fall animations — S6.5 forbids a second player model and this is how
 * that is satisfied: there is no second model, only a second *source of poses*.
 *
 * ## Interpolated, never predicted
 *
 * S4.12 splits the two code paths and this is the interpolated one. The pose comes out of an
 * `EntityInterpolator` at a render time ~100 ms in the past; nothing here extrapolates from
 * inputs, because a remote player's inputs are not knowable. The consequence — that everyone
 * else is drawn slightly in the past — is not a defect to be corrected: the server rewinds to
 * exactly this time when resolving shots (S4.13), so what the player aims at is what the
 * server tests against.
 *
 * ## The rig follows the drawn pose
 *
 * A `HitboxRig` is kept in step with what is on screen, and it is used for **nothing
 * authoritative** — the server owns hit registration. It exists so the client can run its own
 * predicted trace for an immediate hitmarker (S6.4) against the same body the player can see,
 * and so the rewind debug panel has something to draw a box around.
 */
export class RemoteActor implements RenderableActor {
  readonly rig = new HitboxRig(HUMANOID_RIG);
  readonly visual: BotVisualState = makeBotVisualState();

  team: BotTeam = 'A';
  displayName = '';
  health = 100;
  weaponId: string | null = null;
  flags = 0;

  /** True when this actor's pose is being extrapolated because the buffer starved (S4.12). */
  extrapolated = false;
  /** True when extrapolation hit its cap and the body is frozen. */
  frozen = false;

  private readonly pose: InterpolatedPose = makeInterpolatedPose();
  private prevX = 0;
  private prevY = 0;
  private prevZ = 0;
  private prevYaw = 0;
  private prevScale = 1;
  private seeded = false;

  /**
   * The spawn serial the *interpolator* has been snapped for.
   *
   * Separate from `visual.spawnSerial`, which `applyLatest` maintains for the renderer's
   * animation triggers, because the two are consumed at different points in the frame — this one
   * has to be acted on **before** the buffer is sampled and that one after. -1 so the first
   * sighting counts as a spawn.
   */
  private spawnSnapped = -1;

  constructor(readonly entityId: number) {}

  get participating(): boolean {
    return (this.flags & EFlag.Alive) !== 0;
  }

  get isBot(): boolean {
    return (this.flags & EFlag.Bot) !== 0;
  }

  get firing(): boolean {
    return (this.flags & EFlag.Firing) !== 0;
  }

  /** S6.5: *"A remote player mid-reload must look mid-reload."* */
  get reloading(): boolean {
    return (this.flags & EFlag.Reloading) !== 0;
  }

  get ads(): boolean {
    return (this.flags & EFlag.Ads) !== 0;
  }

  get stance(): StanceId {
    return this.pose.stance;
  }

  get x(): number {
    return this.pose.x;
  }
  get y(): number {
    return this.pose.y;
  }
  get z(): number {
    return this.pose.z;
  }
  get yaw(): number {
    return this.pose.yaw;
  }
  /** Aim pitch, replicated so a remote looking up the catwalk reads as looking up (S6.5). */
  get pitch(): number {
    return this.pose.pitch;
  }

  /**
   * Pull this frame's pose out of the buffer.
   *
   * `renderMs` is server time minus the interpolation delay. Called once per rendered frame,
   * before the renderer reads any of the accessors below.
   */
  update(interp: EntityInterpolator, renderMs: number): void {
    /**
     * A respawn is a cut, not a move.
     *
     * Detected **before** sampling, which is the whole point: `applyLatest` below already
     * notices the spawn serial, but it runs *after* `interp.sample` has drawn this frame's pose
     * out of a buffer still holding samples from where the body died. Collapsing the render
     * blend there hides the last few milliseconds of the slide and none of the rest of it —
     * reported as "their model is rapidly pulled across the map from their death position to
     * their new spawn location".
     *
     * The first sighting counts as a spawn too, so a body that has just joined appears where it
     * is rather than travelling there from the origin.
     */
    const spawnSerial = interp.latest.spawnSerial;
    if (spawnSerial !== this.spawnSnapped) {
      this.spawnSnapped = spawnSerial;
      interp.snapTo(renderMs);
      this.seeded = false;
    }

    // The previous pose is kept so the renderer's own `alpha` blend has two states to work
    // between. It is a second, much shorter interpolation on top of the buffer's — the buffer
    // places the body on the server's timeline, this smooths across the display's refresh.
    this.prevX = this.pose.x;
    this.prevY = this.pose.y;
    this.prevZ = this.pose.z;
    this.prevYaw = this.pose.yaw;
    this.prevScale = this.pose.heightScale;

    interp.sample(renderMs, this.pose);
    this.extrapolated = this.pose.extrapolated;
    this.frozen = this.pose.frozen;

    if (!this.seeded) {
      // First frame: collapse the blend so a new body does not fly in from wherever the
      // previous pose happened to be zero-initialised.
      this.prevX = this.pose.x;
      this.prevY = this.pose.y;
      this.prevZ = this.pose.z;
      this.prevYaw = this.pose.yaw;
      this.prevScale = this.pose.heightScale;
      this.seeded = true;
    }

    this.applyLatest(interp.latest);

    this.rig.heightScale = this.pose.heightScale;
    this.rig.setTransform(this.pose.x, this.pose.y, this.pose.z, this.pose.yaw);
  }

  /**
   * Adopt the discrete fields from the newest snapshot.
   *
   * Discrete on purpose — health, weapon, flags and the visual serials are facts that take
   * effect when they arrive, not quantities to blend. Interpolating a weapon index between
   * two values would name a third weapon.
   */
  private applyLatest(latest: EntitySnapshot): void {
    this.team = (latest.flags & EFlag.TeamB) !== 0 ? 'B' : 'A';
    this.health = latest.health;
    this.flags = latest.flags;
    this.weaponId = weaponIdAt(latest.weaponIndex);
    if (latest.displayName !== '') this.displayName = latest.displayName;

    const v = this.visual;
    // Serials are replicated verbatim, so the renderer's existing "start an animation when a
    // serial moves" logic works on a remote player with no change at all. The death variant
    // is *derived* rather than sent, from the same `(entityId, deathSerial)` hash the server
    // used — S4.14's per-event seeding paying for itself: both sides pick the same fall
    // without a byte on the wire.
    if (latest.deathSerial !== v.deathSerial) {
      v.deathSerial = latest.deathSerial;
      v.deathDirX = Math.sin(latest.deathAngle);
      v.deathDirZ = Math.cos(latest.deathAngle);
      v.deathVariant = deathVariantFor(this.entityId, latest.deathSerial, DEATH_VARIANTS);
    }
    if (latest.spawnSerial !== v.spawnSerial) {
      v.spawnSerial = latest.spawnSerial;
      this.seeded = false;
    }
    if (latest.flinchSerial !== v.flinchSerial) {
      v.flinchSerial = latest.flinchSerial;
      v.flinchDirX = Math.sin(latest.flinchAngle);
      v.flinchDirZ = Math.cos(latest.flinchAngle);
    }
  }

  // -- RenderableActor --------------------------------------------------------

  renderX(alpha: number): number {
    return this.prevX + (this.pose.x - this.prevX) * alpha;
  }
  renderY(alpha: number): number {
    return this.prevY + (this.pose.y - this.prevY) * alpha;
  }
  renderZ(alpha: number): number {
    return this.prevZ + (this.pose.z - this.prevZ) * alpha;
  }
  renderYaw(alpha: number): number {
    let d = (this.pose.yaw - this.prevYaw) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d <= -Math.PI) d += Math.PI * 2;
    return this.prevYaw + d * alpha;
  }
  renderScale(alpha: number): number {
    return this.prevScale + (this.pose.heightScale - this.prevScale) * alpha;
  }
}
