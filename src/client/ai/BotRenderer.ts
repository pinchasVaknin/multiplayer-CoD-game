import * as THREE from 'three';
import type { Bot } from '../../shared/ai/Bot';
import type { BotDirector } from '../../shared/ai/BotDirector';
import type { BotTeam } from '../../shared/ai/Combatant';
import { BotMesh, buildBotMaterials, type BotMaterials } from './BotMesh';

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
 * **The mesh set is reconciled, not subscribed.** Each frame it walks `director.bots` and
 * makes its own map agree — a body it has no mesh for gets one, a mesh whose bot has gone
 * is disposed. There is no add/remove callback to miss and nothing to unsubscribe. At ten
 * bots the walk is free, and at M10 the same loop will be reconciling against a snapshot
 * roster rather than a local one, with no change of shape.
 *
 * **Animations are started from serials, not from calls.** `BotVisualState` carries a
 * counter per event; this keeps the last value it saw and starts a fall or a flinch when
 * one moves. A frame that never rendered cannot swallow a death.
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

  private readonly materials: BotMaterials;
  private readonly meshes = new Map<number, BotMesh>();
  /** Last serial this renderer acted on, per bot. */
  private readonly seen = new Map<number, { death: number; spawn: number; flinch: number }>();
  private readonly present = new Set<number>();

  constructor(private readonly director: BotDirector) {
    this.materials = buildBotMaterials();
    this.group.name = 'bots';
    this.groupA.name = 'bots:A';
    this.groupB.name = 'bots:B';
    this.group.add(this.groupA, this.groupB);
  }

  /** The scene node holding one side's bodies. See `groupA`. */
  groupFor(team: BotTeam): THREE.Group {
    return team === 'A' ? this.groupA : this.groupB;
  }

  /** Render pass: reconcile the mesh set, apply poses, advance animations. */
  update(alpha: number, dt: number): void {
    this.present.clear();

    for (const bot of this.director.bots) {
      this.present.add(bot.entityId);
      const mesh = this.meshFor(bot);
      this.applyEvents(bot, mesh);
      mesh.advance(dt);
      mesh.apply(
        bot.renderX(alpha),
        bot.renderY(alpha),
        bot.renderZ(alpha),
        bot.renderYaw(alpha),
        bot.renderScale(alpha),
      );
    }

    if (this.meshes.size !== this.present.size) this.retireAbsent();
  }

  private meshFor(bot: Bot): BotMesh {
    const existing = this.meshes.get(bot.entityId);
    if (existing !== undefined) return existing;

    // `freeForAll` cannot change during a match — a mode is FFA or it is not — so the
    // hostile look is decided once, here, exactly as it was at construction before M9.
    const mesh = new BotMesh(bot.team, this.materials, this.director.freeForAll);
    this.meshes.set(bot.entityId, mesh);
    this.groupFor(bot.team).add(mesh.group);

    // Adopt the bot's current serials rather than zero, so a renderer built mid-match does
    // not replay every death the roster has already had.
    const v = bot.visual;
    this.seen.set(bot.entityId, { death: v.deathSerial, spawn: v.spawnSerial, flinch: v.flinchSerial });
    if (!bot.participating) mesh.beginDeath(v.deathDirX, v.deathDirZ, v.deathVariant);
    return mesh;
  }

  private applyEvents(bot: Bot, mesh: BotMesh): void {
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
      mesh.beginDeath(v.deathDirX, v.deathDirZ, v.deathVariant);
    }
    if (v.flinchSerial !== seen.flinch) {
      seen.flinch = v.flinchSerial;
      mesh.flinch(v.flinchDirX, v.flinchDirZ);
    }
  }

  /** Only walked when the counts disagree, which is a roster change and not a frame event. */
  private retireAbsent(): void {
    for (const [id, mesh] of this.meshes) {
      if (this.present.has(id)) continue;
      mesh.group.removeFromParent();
      mesh.dispose();
      this.meshes.delete(id);
      this.seen.delete(id);
    }
  }

  dispose(): void {
    for (const mesh of this.meshes.values()) {
      mesh.group.removeFromParent();
      mesh.dispose();
    }
    this.meshes.clear();
    this.seen.clear();
    this.group.removeFromParent();
    this.group.clear();
    this.materials.dispose();
  }
}
