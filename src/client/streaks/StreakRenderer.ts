import * as THREE from 'three';
import { CarePackage } from '../../shared/streaks/CarePackage';
import { SentryGun } from '../../shared/streaks/SentryGun';
import type { StreakSystem } from '../../shared/streaks/StreakSystem';
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

  constructor(private readonly streaks: StreakSystem) {
    this.group.name = 'streaks';
  }

  update(): void {
    this.present.clear();

    for (const streak of this.streaks.active) {
      if (streak instanceof SentryGun) {
        this.present.add(streak.instanceId);
        let mesh = this.sentries.get(streak.instanceId);
        if (mesh === undefined) {
          mesh = new SentryMesh(streak.x, streak.y, streak.z, streak.restYaw, streak.team);
          this.sentries.set(streak.instanceId, mesh);
          this.group.add(mesh.group);
        }
        mesh.aim(streak.turretYaw, streak.turretPitch);
      } else if (streak instanceof CarePackage) {
        this.present.add(streak.instanceId);
        let mesh = this.packages.get(streak.instanceId);
        if (mesh === undefined) {
          mesh = new CarePackageMesh(streak.x, streak.y, streak.z);
          this.packages.set(streak.instanceId, mesh);
          this.group.add(mesh.group);
        }
        mesh.setHeight(streak.y);
      }
    }

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
