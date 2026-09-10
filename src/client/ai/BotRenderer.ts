import * as THREE from 'three';
import type { RenderableActor } from '../../shared/ai/BotVisualState';
import type { BotTeam } from '../../shared/ai/Combatant';
import { relationTo, type ViewerContext } from '../../shared/ui/TeamColour';
import { BotMesh, buildBotAssets, type BotAssets } from './BotMesh';
import { buildHeldWeaponGeometry, heldWeaponMaterial } from '../weapons/WeaponMesh';
import type { ActorAvatar, TeamVisualTint } from '../characters/ActorAvatar';
import type {
  CharacterAvatarProvider,
  CharacterAvatarProviderResolver,
} from '../characters/CharacterAvatarProvider';
import { palette } from '../ui/Palette';

// Skeleton cloning and material setup are intentionally amortized. A finished preload can make
// an entire roster eligible in one frame, and replacing every fallback at once is a visible hitch.
const MAX_GLTF_AVATAR_CREATIONS_PER_FRAME = 2;
// These are intentionally strong enough to read through the supplied dark tactical texture.
// They remain viewer-relative, so switching to team B never makes your own side look hostile.
const FRIENDLY_SKIN_TINT_BLEND = 0.55;
const HOSTILE_SKIN_TINT_BLEND = 0.72;

/**
 * Draws the bots (M9).
 *
 * Until M9 every `Bot` owned a `BotMesh` and `BotDirector` owned the two scene groups the
 * bodies hung from, so the roster could not exist without a renderer. This class is where
 * all of that went. `shared/ai/` now knows nothing about it.
 *
 * Two things it does that are worth stating, because both are the M9 pattern rather than
 * incidental:
 *
 * **The mesh set is reconciled, not subscribed.** Each frame it walks the actor list and
 * makes its own map agree — a body it has no mesh for gets one, a mesh whose actor has gone
 * is disposed. There is no add/remove callback to miss and nothing to unsubscribe.
 *
 * **M10 made good on that.** The prediction in the paragraph above was that the same loop
 * would one day reconcile against a snapshot roster "with no change of shape", and it does:
 * the list is now a supplier of `RenderableActor`, which a local `Bot` and a remote player
 * rebuilt from snapshots both satisfy. S6.5 forbids authoring a second player model and this
 * is how that is enforced by construction rather than by intention — there is no branch here
 * that could tell the two apart.
 *
 * **Animations are started from serials, not from calls.** `BotVisualState` carries a
 * counter per event; this keeps the last value it saw and starts a fall or a flinch when
 * one moves. A frame that never rendered cannot swallow a death.
 *
 * **The weapons are cached here, per id** (round 5, F4). A held weapon is one merged geometry
 * and the roster repeats itself — ten bots draw from an eleven-weapon arsenal, so four or five
 * distinct geometries cover a match. Caching them on the renderer rather than the body means a
 * bot that swaps weapons, or a mesh rebuilt after a respawn, costs a map lookup; caching them
 * for the process would mean holding geometry across map changes for a saving nobody measured.
 */
export class BotRenderer {
  /** Everything this renderer owns, as one node. Added to the scene by `ClientMatch`. */
  readonly group = new THREE.Group();

  /**
   * The roster split by side, as two scene graph nodes (post-M8).
   *
   * Built for the Chopper Gunner's IFF: the gunship view draws team-mates dark and enemies
   * hot, and doing that per *object* would mean the renderer walking the bot list and knowing
   * what a team is. Two groups means the render pass is handed "these are cold, those are
   * hot" and stays a render pass.
   */
  readonly groupA = new THREE.Group();
  readonly groupB = new THREE.Group();

  private readonly assets: BotAssets;
  /** One merged geometry per weapon id, shared by every body carrying that weapon. */
  private readonly weapons = new Map<string, THREE.BufferGeometry>();
  private readonly weaponMaterial: THREE.Material;
  /** GLB avatars once ready; `BotMesh` instances are the safe procedural fallback. */
  private readonly avatars = new Map<number, ActorAvatar>();
  /** Each actor keeps one skin provider for its entire rendered lifetime. */
  private readonly characterProviders = new Map<number, CharacterAvatarProvider>();
  /** Last serial this renderer acted on, per bot. */
  private readonly seen = new Map<number, { death: number; spawn: number; flinch: number }>();
  private readonly present = new Set<number>();
  private readonly teams = new Map<number, BotTeam>();
  private readonly repaintTeams: () => void;
  private gltfAvatarCreationsRemaining = 0;
  private viewerSignature = '';

  /**
   * `actors` is a supplier rather than an array so the caller can decide per frame what is
   * drawable — the bot director's roster in single-player, the snapshot's remote set when
   * networked — without this class knowing which world it is in.
   */
  constructor(
    private readonly actors: () => Iterable<RenderableActor>,
    private readonly viewer: () => ViewerContext,
    anisotropy = 1,
    private readonly characterProviderFor: CharacterAvatarProviderResolver,
  ) {
    this.assets = buildBotAssets();
    // The viewmodel's own gunmetal, already built for the process. A held weapon allocates no
    // material of its own — see `heldWeaponMaterial`.
    this.weaponMaterial = heldWeaponMaterial(anisotropy);
    this.group.name = 'bots';
    this.groupA.name = 'bots:A';
    this.groupB.name = 'bots:B';
    this.group.add(this.groupA, this.groupB);

    this.repaintTeams = palette.onChange(() => this.reapplyTeamTints());
  }

  /** The scene node holding one side's bodies. See `groupA`. */
  groupFor(team: BotTeam): THREE.Group {
    return team === 'A' ? this.groupA : this.groupB;
  }

  /** Render pass: reconcile the mesh set, apply poses, advance animations. */
  update(alpha: number, dt: number): void {
    this.present.clear();
    this.gltfAvatarCreationsRemaining = MAX_GLTF_AVATAR_CREATIONS_PER_FRAME;
    const viewer = this.viewer();
    const viewerSignature = `${viewer.team}:${viewer.freeForAll}`;
    if (viewerSignature !== this.viewerSignature) {
      this.viewerSignature = viewerSignature;
      this.reapplyTeamTints(viewer);
    }

    for (const actor of this.actors()) {
      this.present.add(actor.entityId);
      const mesh = this.avatarFor(actor);
      const animation = actor.animation;
      this.applyEvents(actor, mesh, animation);
      // Cheap and idempotent: `setWeapon` returns immediately unless the id actually moved,
      // which it does once per body per life rather than once per frame.
      mesh.setWeapon(actor.weaponId, this.weaponGeometry(actor.weaponId), this.weaponMaterial);
      mesh.update(
        animation,
        actor.renderX(alpha),
        actor.renderY(alpha),
        actor.renderZ(alpha),
        actor.renderYaw(alpha),
        actor.renderScale(alpha),
        dt,
      );
    }

    if (this.avatars.size !== this.present.size) this.retireAbsent();
  }

  private avatarFor(bot: RenderableActor): ActorAvatar {
    const characterProvider = this.characterProviderForActor(bot);
    const existing = this.avatars.get(bot.entityId);
    if (existing !== undefined) {
      this.applyTeamTint(bot.entityId, bot.team, existing);
      if (
        existing instanceof BotMesh &&
        this.gltfAvatarCreationsRemaining > 0 &&
        characterProvider.isReady
      ) {
        return this.replaceFallback(bot, existing, characterProvider);
      }
      return existing;
    }

    const avatar = this.createAvatar(bot, characterProvider);
    this.avatars.set(bot.entityId, avatar);
    this.teams.set(bot.entityId, bot.team);
    this.groupFor(bot.team).add(avatar.group);
    avatar.setTeamTint(this.tintFor(bot.team));

    // Adopt the bot's current serials rather than zero, so a renderer built mid-match does
    // not replay every death the roster has already had.
    const v = bot.visual;
    this.seen.set(bot.entityId, { death: v.deathSerial, spawn: v.spawnSerial, flinch: v.flinchSerial });
    if (!bot.participating) avatar.beginDeath(v.deathDirX, v.deathDirZ, v.deathVariant, bot.animation);
    return avatar;
  }

  private characterProviderForActor(actor: RenderableActor): CharacterAvatarProvider {
    const existing = this.characterProviders.get(actor.entityId);
    if (existing !== undefined) return existing;

    const provider = this.characterProviderFor(actor);
    this.characterProviders.set(actor.entityId, provider);
    return provider;
  }

  private applyEvents(bot: RenderableActor, mesh: ActorAvatar, animation: RenderableActor['animation']): void {
    const v = bot.visual;
    const seen = this.seen.get(bot.entityId);
    if (seen === undefined) return;

    if (v.spawnSerial !== seen.spawn) {
      seen.spawn = v.spawnSerial;
      mesh.endDeath();
      mesh.setVisible(true);
    }
    if (v.deathSerial !== seen.death) {
      seen.death = v.deathSerial;
      mesh.beginDeath(v.deathDirX, v.deathDirZ, v.deathVariant, animation);
    }
    if (v.flinchSerial !== seen.flinch) {
      seen.flinch = v.flinchSerial;
      mesh.flinch(v.flinchDirX, v.flinchDirZ);
    }

    /**
     * The authoritative bit has the last word.
     *
     * Both branches above are edge-triggered, and over the network **both edges routinely
     * arrive in the same frame**: snapshots are delta-compressed at 20 Hz against a 60 Hz sim,
     * so a body that died and respawned between two snapshots presents a changed death serial
     * *and* a changed spawn serial at once. With the death check second the mesh ends up
     * face-down on a player who is alive, running around and shooting.
     *
     * Reordering cannot fix it — spawn-then-die inside one frame is equally possible and would
     * leave a corpse standing up. The serials carry no ordering relative to *each other*, so no
     * order is right. `participating` — `EFlag.Alive` off the newest snapshot — does.
     *
     * The animations stay edge-triggered for their *effects* (fall direction, variant) and the
     * final state is reconciled against the fact. Single-player reaches this with the same
     * `Combatant.participating` it always had, so the two paths agree by construction rather
     * than by coincidence.
     */
    if (bot.participating && mesh.isDying) {
      mesh.endDeath();
      mesh.setVisible(true);
    } else if (!bot.participating && !mesh.isDying) {
      mesh.beginDeath(v.deathDirX, v.deathDirZ, v.deathVariant, animation);
    }
  }

  /** Create a GLB avatar if its already-preloaded template is trustworthy; otherwise fallback. */
  private createAvatar(bot: RenderableActor, characterProvider: CharacterAvatarProvider): ActorAvatar {
    if (this.gltfAvatarCreationsRemaining > 0) {
      const character = characterProvider.create();
      if (character !== null) {
        this.gltfAvatarCreationsRemaining--;
        return character;
      }
    }
    // `freeForAll` is fixed for a match. Preserve the old material-based IFF fallback while a
    // GLB template is loading or unavailable.
    return new BotMesh(bot.team, this.assets, this.viewer().freeForAll);
  }

  /** Swap an existing fallback only at a frame boundary, preserving serial/event semantics. */
  private replaceFallback(
    bot: RenderableActor,
    fallback: BotMesh,
    characterProvider: CharacterAvatarProvider,
  ): ActorAvatar {
    const avatar = characterProvider.create();
    if (avatar === null) return fallback;

    this.gltfAvatarCreationsRemaining--;

    fallback.group.removeFromParent();
    fallback.dispose();
    this.avatars.set(bot.entityId, avatar);
    this.groupFor(bot.team).add(avatar.group);
    avatar.setTeamTint(this.tintFor(bot.team));
    if (!bot.participating) {
      const visual = bot.visual;
      avatar.beginDeath(visual.deathDirX, visual.deathDirZ, visual.deathVariant, bot.animation);
    }
    return avatar;
  }

  /** The merged geometry for a weapon id, built once and kept. Null for an unknown id. */
  private weaponGeometry(weaponId: string | null): THREE.BufferGeometry | null {
    if (weaponId === null) return null;
    const existing = this.weapons.get(weaponId);
    if (existing !== undefined) return existing;
    const built = buildHeldWeaponGeometry(weaponId);
    this.weapons.set(weaponId, built);
    return built;
  }

  /** Only walked when the counts disagree, which is a roster change and not a frame event. */
  private retireAbsent(): void {
    for (const [id, mesh] of this.avatars) {
      if (this.present.has(id)) continue;
      mesh.group.removeFromParent();
      mesh.dispose();
      this.avatars.delete(id);
      this.seen.delete(id);
      this.teams.delete(id);
      this.characterProviders.get(id)?.dispose();
      this.characterProviders.delete(id);
    }
  }

  dispose(): void {
    this.repaintTeams();
    for (const mesh of this.avatars.values()) {
      mesh.group.removeFromParent();
      mesh.dispose();
    }
    this.avatars.clear();
    for (const provider of this.characterProviders.values()) provider.dispose();
    this.characterProviders.clear();
    this.seen.clear();
    this.teams.clear();
    this.group.removeFromParent();
    this.group.clear();
    // The bodies reference these and are already gone; the weapon material is the viewmodel's
    // and belongs to `disposeWeaponSurfaces`, which the page teardown owns.
    for (const geometry of this.weapons.values()) geometry.dispose();
    this.weapons.clear();
    this.assets.dispose();
  }

  private applyTeamTint(entityId: number, team: BotTeam, avatar: ActorAvatar): void {
    if (this.teams.get(entityId) === team) return;
    this.teams.set(entityId, team);
    avatar.setTeamTint(this.tintFor(team));
  }

  private reapplyTeamTints(viewer = this.viewer()): void {
    for (const [id, avatar] of this.avatars) {
      const team = this.teams.get(id);
      if (team !== undefined) avatar.setTeamTint(this.tintFor(team, viewer));
    }
  }

  private tintFor(team: BotTeam, viewer = this.viewer()): TeamVisualTint {
    if (relationTo(viewer, team) === 'HOSTILE') {
      return { color: palette.current.hostile, blend: HOSTILE_SKIN_TINT_BLEND };
    }
    return { color: palette.current.friendly, blend: FRIENDLY_SKIN_TINT_BLEND };
  }
}
