import * as THREE from 'three';
import type { Combatant } from '../ai/Combatant';
import type { ObjectiveTarget } from '../ai/ObjectiveIntent';
import { makeObjectiveTarget, type MutableObjectiveTarget } from '../ai/ObjectiveIntent';
import { EV } from '../core/Events';
import { DT } from '../core/Loop';
import { makeRayHit } from '../world/Geometry';
import { Killstreak, type StreakContext } from './KillstreakBase';
import { STREAK_DEFS, type StreakDef } from './StreakDefs';

/**
 * Care Package (brief S6.1): drops a random higher streak, **contestable by bots**.
 *
 * "Contestable" is the requirement, and it is the reason this class exposes an
 * `ObjectiveTarget`: bots do not get a special code path that teleports them to crates. The
 * package publishes itself through the same `ObjectiveIntent` seam Domination's flags use, so a
 * bot walks to it with the same pathing, gets shot at on the way with the same perception, and
 * claims it by standing on it for the same reason a flag is taken by standing on it.
 *
 * **Either side can take it.** A package dropped by the player is worth contesting precisely
 * because the enemy can steal it, and the claim timer is what turns that into a fight rather
 * than a race — three seconds standing still in the open is a real decision.
 *
 * The crate falls rather than appearing: it is spawned at `packageDropHeight` and descends at a
 * fixed rate until the collision world says it has landed. That is a sim-tick integration on
 * `DT`, not an animation.
 */
export class CarePackage extends Killstreak {
  /** Where the crate is heading, and where it will sit once landed. */
  readonly x: number;
  readonly z: number;
  y: number;

  landed = false;
  /** 0..1 claim progress, and who is making it. */
  claimFraction = 0;
  claimantId = -1;
  /** What is inside. Rolled at activation so the debug panel can see it before it lands. */
  readonly contents: StreakDef;

  private readonly group = new THREE.Group();
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly beaconMaterial: THREE.MeshBasicMaterial;
  private readonly target: MutableObjectiveTarget = makeObjectiveTarget();
  private readonly packageId: number;
  private groundY = 0;

  constructor(
    def: StreakDef,
    ownerId: number,
    ownerTeam: 'A' | 'B',
    instanceId: number,
    ctx: StreakContext,
    x: number,
    z: number,
  ) {
    super(def, ownerId, ownerTeam, instanceId, ctx);
    this.x = x;
    this.z = z;
    this.y = 0;
    this.packageId = instanceId;
    this.contents = rollContents(ctx);

    this.geometry = new THREE.BoxGeometry(0.9, 0.72, 0.9);
    this.material = new THREE.MeshStandardMaterial({ color: 0x3d4a3a, roughness: 0.78, metalness: 0.08 });
    this.beaconMaterial = new THREE.MeshBasicMaterial({ color: 0xffb340, toneMapped: false });
  }

  override onActivate(): void {
    const cfg = this.ctx.cfg;
    // Where the ground is under the drop point, so the crate has somewhere to land.
    this.groundY = this.probeGround(this.x, this.z);
    this.y = this.groundY + cfg.packageDropHeight;

    const crate = new THREE.Mesh(this.geometry, this.material);
    crate.castShadow = true;
    crate.receiveShadow = true;
    this.group.add(crate);

    // A thin bright post so the crate is findable across a map without a HUD marker.
    const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 3.2, 6), this.beaconMaterial);
    beacon.position.y = 1.9;
    this.group.add(beacon);

    this.group.position.set(this.x, this.y, this.z);
    this.ctx.scene.add(this.group);

    const ev = { packageId: this.packageId, ownerTeam: this.ownerTeam, x: this.x, y: this.y, z: this.z };
    this.ctx.bus.emit(EV.CarePackageDropped, ev);
    this.ctx.audio.packageDrop(this.x, this.y, this.z);
  }

  override onTick(_tick: number): boolean {
    this.age += DT;
    const cfg = this.ctx.cfg;

    if (!this.landed) {
      this.y -= cfg.packageDropSpeed * DT;
      if (this.y <= this.groundY) {
        this.y = this.groundY;
        this.landed = true;
        this.ctx.audio.packageLand(this.x, this.y, this.z);
      }
      this.group.position.y = this.y;
      return true;
    }

    // Claim: one claimant at a time, and contesting resets rather than sharing. A crate two
    // people are standing on is a fight, not a co-operative unlock.
    const claimants = this.claimantsOn();
    if (claimants.length !== 1) {
      this.claimFraction = 0;
      this.claimantId = -1;
      return this.age < this.def.durationSeconds;
    }
    const claimant = claimants[0];
    if (claimant === undefined) return true;

    if (claimant.entityId !== this.claimantId) {
      this.claimantId = claimant.entityId;
      this.claimFraction = 0;
    }
    this.claimFraction += DT / cfg.packageCaptureSeconds;
    if (this.claimFraction < 1) return this.age < this.def.durationSeconds;

    this.grant(claimant);
    return false;
  }

  override onExpire(): void {
    this.ctx.scene.remove(this.group);
    this.group.clear();
    this.geometry.dispose();
    this.material.dispose();
    this.beaconMaterial.dispose();
  }

  override describe(): string {
    if (!this.landed) return `PACKAGE falling ${(this.y - this.groundY).toFixed(1)}m · ${this.contents.name}`;
    const who = this.claimantId < 0 ? 'unclaimed' : `#${this.claimantId} ${(this.claimFraction * 100).toFixed(0)}%`;
    return `PACKAGE ${this.contents.name} · ${who} · ${this.secondsRemaining.toFixed(0)}s`;
  }

  /**
   * The crate as an objective, for any bot that fancies it.
   *
   * Only offered once it has landed — a bot sprinting to stand under a falling crate is a bot
   * standing still in the open for no reason. Priority is high enough to break off a firefight
   * for, because a contested package is worth more than the fight it interrupts.
   */
  objectiveTarget(): ObjectiveTarget | null {
    if (!this.landed || this.phase !== 'ACTIVE') return null;
    const t = this.target;
    t.id = `package_${this.packageId}`;
    t.label = 'PACKAGE';
    t.x = this.x;
    t.y = this.y;
    t.z = this.z;
    t.radius = this.ctx.cfg.packageRadius;
    t.action = 'collect';
    t.priority = 0.75;
    return t;
  }

  // -- internals --------------------------------------------------------------

  private claimantsOn(): Combatant[] {
    const cfg = this.ctx.cfg;
    const out: Combatant[] = [];
    const r2 = cfg.packageRadius * cfg.packageRadius;
    for (const c of this.ctx.roster) {
      if (!c.participating) continue;
      if (Math.abs(c.py - this.y) > 2.4) continue;
      const dx = c.px - this.x;
      const dz = c.pz - this.z;
      if (dx * dx + dz * dz <= r2) out.push(c);
    }
    return out;
  }

  private grant(claimant: Combatant): void {
    const ev = {
      packageId: this.packageId,
      entityId: claimant.entityId,
      team: claimant.team,
      streakId: this.contents.id,
      name: this.contents.name,
    };
    this.ctx.bus.emit(EV.CarePackageClaimed, ev);
    this.ctx.audio.packageClaimed(this.x, this.y, this.z);
  }

  /**
   * Find the floor under the drop point by casting straight down from high up.
   *
   * Uses the same spatial-hash raycaster gameplay uses (S4.3) — never `THREE.Raycaster`.
   * A miss means the drop point is over a hole in the map, in which case sitting on y = 0 is
   * the least surprising answer available.
   */
  private probeGround(x: number, z: number): number {
    const from = this.ctx.cfg.packageDropHeight + 12;
    const hit = makeRayHit();
    if (!this.ctx.world.raycast(x, from, z, 0, -1, 0, from + 8, hit)) return 0;
    return from - hit.t;
  }
}

/**
 * Roll the contents.
 *
 * Weighted toward the cheaper streaks so a package is a good outcome rather than a jackpot,
 * and a package can never contain another package.
 */
function rollContents(ctx: StreakContext): StreakDef {
  const pool = STREAK_DEFS.filter((s) => s.fromCarePackage);
  // Cheaper streaks are likelier: weight is the inverse of the requirement.
  let total = 0;
  for (const s of pool) total += 1 / s.requirement;
  let roll = ctx.rng.float() * total;
  for (const s of pool) {
    roll -= 1 / s.requirement;
    if (roll <= 0) return s;
  }
  const last = pool[pool.length - 1];
  if (last === undefined) throw new Error('No care-package contents are eligible');
  return last;
}
