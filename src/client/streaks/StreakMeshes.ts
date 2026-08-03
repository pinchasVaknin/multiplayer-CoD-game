import * as THREE from 'three';
import type { BotTeam } from '../../shared/ai/Combatant';

/**
 * The bodies killstreaks used to build for themselves (M9).
 *
 * Lifted verbatim out of `shared/streaks/SentryGun.ts` and `shared/streaks/CarePackage.ts`.
 * Nothing about the geometry changed — the sentry is still three splayed legs, a tinted
 * body and a barrel, and the crate is still a box under a bright post. What changed is who
 * owns them: `StreakRenderer` builds these against the live streak list, and the streaks no
 * longer know a scene exists.
 */

export class SentryMesh {
  readonly group = new THREE.Group();
  private readonly yawNode = new THREE.Group();
  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor(x: number, y: number, z: number, restYaw: number, team: BotTeam) {
    const legGeo = new THREE.CylinderGeometry(0.035, 0.05, 0.62, 6);
    const legMat = new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.7, metalness: 0.35 });
    this.disposables.push(legGeo, legMat);
    for (let i = 0; i < 3; i++) {
      const leg = new THREE.Mesh(legGeo, legMat);
      const a = (i / 3) * Math.PI * 2;
      leg.position.set(Math.cos(a) * 0.16, 0.31, Math.sin(a) * 0.16);
      leg.rotation.z = Math.cos(a) * 0.28;
      leg.rotation.x = -Math.sin(a) * 0.28;
      leg.castShadow = true;
      this.group.add(leg);
    }

    this.yawNode.position.y = 0.62;
    this.group.add(this.yawNode);

    const bodyGeo = new THREE.BoxGeometry(0.3, 0.22, 0.34);
    const bodyMat = new THREE.MeshStandardMaterial({
      // Tinted to the owner's side so the player can tell theirs from an enemy's at a glance.
      color: team === 'A' ? 0x2f5d7c : 0x7c3a2f,
      roughness: 0.55,
      metalness: 0.4,
    });
    this.disposables.push(bodyGeo, bodyMat);
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.castShadow = true;
    this.yawNode.add(body);

    const barrelGeo = new THREE.CylinderGeometry(0.028, 0.028, 0.42, 8);
    const barrelMat = new THREE.MeshStandardMaterial({ color: 0x14181d, roughness: 0.45, metalness: 0.6 });
    this.disposables.push(barrelGeo, barrelMat);
    const barrel = new THREE.Mesh(barrelGeo, barrelMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.z = -0.28;
    this.yawNode.add(barrel);

    this.group.position.set(x, y, z);
    this.group.rotation.y = restYaw;
  }

  /** Both angles are relative to the base's placed facing. See `SentryGun.turretYaw`. */
  aim(turretYaw: number, turretPitch: number): void {
    this.yawNode.rotation.y = turretYaw;
    this.yawNode.rotation.x = turretPitch;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.group.clear();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

export class CarePackageMesh {
  readonly group = new THREE.Group();
  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor(x: number, y: number, z: number) {
    const geometry = new THREE.BoxGeometry(0.9, 0.72, 0.9);
    const material = new THREE.MeshStandardMaterial({ color: 0x3d4a3a, roughness: 0.78, metalness: 0.08 });
    const beaconGeometry = new THREE.CylinderGeometry(0.045, 0.045, 3.2, 6);
    const beaconMaterial = new THREE.MeshBasicMaterial({ color: 0xffb340, toneMapped: false });
    this.disposables.push(geometry, material, beaconGeometry, beaconMaterial);

    const crate = new THREE.Mesh(geometry, material);
    crate.castShadow = true;
    crate.receiveShadow = true;
    this.group.add(crate);

    // A thin bright post so the crate is findable across a map without a HUD marker.
    const beacon = new THREE.Mesh(beaconGeometry, beaconMaterial);
    beacon.position.y = 1.9;
    this.group.add(beacon);

    this.group.position.set(x, y, z);
  }

  /** The crate falls; x and z never change after the drop. */
  setHeight(y: number): void {
    this.group.position.y = y;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.group.clear();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
