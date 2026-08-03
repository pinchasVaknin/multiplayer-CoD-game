import type { CameraRig } from '../engine/CameraRig';
import type { Fx } from '../engine/Fx';
import type { StreakPresentation } from '../../shared/streaks/StreakPresentation';
import type { StreakAudio } from './StreakAudio';

/**
 * The browser's answer to `StreakPresentation` (M9).
 *
 * Every method is one line, and that is the point: the port exists to give the simulation
 * somewhere to *say* a thing happened, and this is the only place that decides what saying
 * it looks and sounds like. On the server the same calls land in `SILENT_PRESENTATION`.
 *
 * S4.15's phrasing again — *"the server says `damage.dealt`; the client decides what that
 * looks and sounds like"*. At M10 this class is where a replicated effect event will arrive,
 * and no killstreak will need to change for that to happen.
 *
 * `blast` is supplied rather than imported because the explosion pool belongs to the M5
 * equipment Fx, and `streaks/` has never depended on `equipment/` for a puff of light.
 */
export class ClientStreakPresentation implements StreakPresentation {
  constructor(
    private readonly audio: StreakAudio,
    private readonly fx: Fx,
    private readonly cameraRig: CameraRig,
    private readonly blastFn: (x: number, y: number, z: number, radius: number, bright: boolean) => void,
  ) {}

  sentryDeploy(x: number, y: number, z: number): void {
    this.audio.sentryDeploy(x, y, z);
  }

  sentryShot(x: number, y: number, z: number): void {
    this.audio.sentryShot(x, y, z);
  }

  sentryDestroyed(x: number, y: number, z: number): void {
    this.audio.sentryDestroyed(x, y, z);
  }

  packageDrop(x: number, y: number, z: number): void {
    this.audio.packageDrop(x, y, z);
  }

  packageLand(x: number, y: number, z: number): void {
    this.audio.packageLand(x, y, z);
  }

  packageClaimed(x: number, y: number, z: number): void {
    this.audio.packageClaimed(x, y, z);
  }

  chopperSpin(spin: number): void {
    this.audio.chopperSpin(spin);
  }

  chopperShot(): void {
    this.audio.chopperShot();
  }

  uavSweep(age: number): void {
    this.audio.uavSweep(age);
  }

  counterUav(): void {
    this.audio.counterUav();
  }

  mortarInbound(x: number, y: number, z: number): void {
    this.audio.mortarInbound(x, y, z);
  }

  mortarImpact(x: number, y: number, z: number): void {
    this.audio.mortarImpact(x, y, z);
  }

  tracer(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    this.fx.spawnTracer(x0, y0, z0, x1, y1, z1);
  }

  blast(x: number, y: number, z: number, radius: number, bright: boolean): void {
    this.blastFn(x, y, z, radius, bright);
  }

  shake(amount: number): void {
    this.cameraRig.shake.add(amount);
  }
}
