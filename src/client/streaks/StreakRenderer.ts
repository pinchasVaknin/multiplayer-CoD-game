import * as THREE from 'three';
import { CarePackage } from '../../shared/streaks/CarePackage';
import { SentryGun } from '../../shared/streaks/SentryGun';
import type { StreakSystem } from '../../shared/streaks/StreakSystem';
import { STREAK_DEFS } from '../../shared/streaks/StreakDefs';
import { OBJ_TEAM_B, type StreakEntityState } from '../../shared/net/Skirmish';
import {
  relationTo,
  relationToSelf,
  type TeamRelation,
  type ViewerContext,
} from '../../shared/ui/TeamColour';
import { CarePackageMesh, SentryMesh } from './StreakMeshes';

/**
 * Draws the killstreaks that have a body (M9).
 *
 * Two of the six do: the sentry and the care package. Before M9 each built its own meshes
 * into a `THREE.Scene` handed to it through `StreakContext`, which is what made `streaks/`
 * impossible to load in Node.
 *
 * The reconcile-against-the-live-list shape is the same one `BotRenderer` uses, for the
 * same reasons: nothing to subscribe to, nothing to unsubscribe, and a streak that expired
 * between two frames still gets its mesh disposed. `StreakSystem.active` is at most a
 * handful of entries, so the walk is free.
 *
 * The heap harness's "a streak that leaves a mesh in the scene" test still applies — it
 * just applies to this class now, which is the thing that made the mesh.
 */
export class StreakRenderer {
  readonly group = new THREE.Group();

  private readonly sentries = new Map<number, SentryMesh>();
  private readonly packages = new Map<number, CarePackageMesh>();
  private readonly present = new Set<number>();

  /**
   * `viewer` and `isLocal` are the two halves of "what is this sentry to me" (M13 Phase A):
   * the side it is on is a relation to the viewer's seat, and in Free-for-All — where every
   * side is hostile — the owner's id is the only thing that says it is *yours*. Read at mesh
   * creation, not construction: a networked seat arrives after this object exists.
   */
  constructor(
    private readonly streaks: StreakSystem,
    private readonly viewer: () => ViewerContext,
    private readonly isLocal: (entityId: number) => boolean,
  ) {
    this.group.name = 'streaks';
  }

  /** The local simulation's streaks. Single-player, and the arena before a migration. */
  update(): void {
    this.present.clear();

    for (const streak of this.streaks.active) {
      if (streak instanceof SentryGun) {
        this.syncSentry(
          streak.instanceId,
          streak.x,
          streak.y,
          streak.z,
          streak.restYaw,
          this.relationOf(streak.ownerId, streak.team),
          streak.turretYaw,
          streak.turretPitch,
        );
      } else if (streak instanceof CarePackage) {
        this.syncPackage(streak.instanceId, streak.x, streak.y, streak.z);
      }
    }

    this.sweep();
  }

  /**
   * The server's streaks (M11 Gate B, §8.22).
   *
   * The same reconcile against a different source. A networked client does not own these
   * objects — `StreakSystem` on the server does — so there is nothing here to simulate and the
   * whole of the client's job is to keep a mesh pointed at each replicated record.
   *
   * Kinds without a body are skipped rather than special-cased: they are in the list because
   * *"a UAV is up"* is something the HUD needs to know, and a UAV has nothing to draw here.
   */
  updateReplicated(entities: readonly StreakEntityState[]): void {
    this.present.clear();

    for (const e of entities) {
      const def = STREAK_DEFS[e.kind];
      if (def === undefined) continue;
      if (def.id === 'sentry') {
        this.syncSentry(
          e.instanceId,
          e.x,
          e.y,
          e.z,
          // The mesh takes a rest yaw once, at construction, and is aimed every frame after.
          // The turret's current bearing is the best available answer on the frame it appears.
          e.yaw,
          this.relationOf(e.ownerId, e.team === OBJ_TEAM_B ? 'B' : 'A'),
          e.yaw,
          e.pitch,
        );
      } else if (def.id === 'care_package') {
        this.syncPackage(e.instanceId, e.x, e.y, e.z);
      }
    }

    this.sweep();
  }

  /** What a sentry is to this viewer. Yours is friendly in every mode, FFA included. */
  private relationOf(ownerId: number, team: 'A' | 'B'): TeamRelation {
    return this.isLocal(ownerId) ? relationToSelf() : relationTo(this.viewer(), team);
  }

  private syncSentry(
    instanceId: number,
    x: number,
    y: number,
    z: number,
    restYaw: number,
    relation: TeamRelation,
    turretYaw: number,
    turretPitch: number,
  ): void {
    this.present.add(instanceId);
    let mesh = this.sentries.get(instanceId);
    if (mesh === undefined) {
      mesh = new SentryMesh(x, y, z, restYaw, relation);
      this.sentries.set(instanceId, mesh);
      this.group.add(mesh.group);
    }
    mesh.aim(turretYaw, turretPitch);
  }

  private syncPackage(instanceId: number, x: number, y: number, z: number): void {
    this.present.add(instanceId);
    let mesh = this.packages.get(instanceId);
    if (mesh === undefined) {
      mesh = new CarePackageMesh(x, y, z);
      this.packages.set(instanceId, mesh);
      this.group.add(mesh.group);
    }
    mesh.setHeight(y);
  }

  private sweep(): void {
    if (this.sentries.size + this.packages.size !== this.present.size) this.retireAbsent();
  }

  private retireAbsent(): void {
    for (const [id, mesh] of this.sentries) {
      if (this.present.has(id)) continue;
      mesh.dispose();
      this.sentries.delete(id);
    }
    for (const [id, mesh] of this.packages) {
      if (this.present.has(id)) continue;
      mesh.dispose();
      this.packages.delete(id);
    }
  }

  dispose(): void {
    for (const mesh of this.sentries.values()) mesh.dispose();
    for (const mesh of this.packages.values()) mesh.dispose();
    this.sentries.clear();
    this.packages.clear();
    this.group.removeFromParent();
    this.group.clear();
  }
}
