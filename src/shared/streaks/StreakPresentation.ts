/**
 * Everything a killstreak wants the world to *see and hear*, as a port (M9).
 *
 * Before M9 `StreakContext` handed every streak a `THREE.Scene`, the `Fx` pool, the
 * `CameraRig` and the `StreakAudio` synthesiser. That made `streaks/` unloadable in Node
 * for the sake of a dozen calls, none of which decide anything: a tracer, a bang, a puff
 * of light, a shake.
 *
 * S4.15 already says how this resolves — *"cosmetics are driven by replicated events, not
 * by replicated state; the server says `damage.dealt` and the client decides what that
 * looks and sounds like."* This interface is that boundary, stated in types. Every
 * argument is a number, so nothing here would be hard to put on a wire.
 *
 * **`SilentPresentation` is not a stub.** A headless server has no speakers and no scene;
 * doing nothing is the complete and correct behaviour for that runtime, not an unfinished
 * one. The browser supplies `ClientStreakPresentation`, which is where a networked effect
 * event will arrive at M10 — the streaks themselves will not change.
 *
 * Positional calls take world coordinates. Panning and attenuation are the client's
 * business; a streak states where a thing happened, not how loud it should be.
 */
export interface StreakPresentation {
  // -- sentry ---------------------------------------------------------------
  sentryDeploy(x: number, y: number, z: number): void;
  sentryShot(x: number, y: number, z: number): void;
  sentryDestroyed(x: number, y: number, z: number): void;

  // -- care package ---------------------------------------------------------
  packageDrop(x: number, y: number, z: number): void;
  packageLand(x: number, y: number, z: number): void;
  packageClaimed(x: number, y: number, z: number): void;

  // -- chopper gunner -------------------------------------------------------
  /** Rotor wash. `spin` is 0..1 spool-up. */
  chopperSpin(spin: number): void;
  chopperShot(): void;

  // -- uav / counter-uav ----------------------------------------------------
  /** A sweep passed. `age` is seconds since activation, for pitch variation. */
  uavSweep(age: number): void;
  counterUav(): void;

  // -- mortar ---------------------------------------------------------------
  mortarInbound(x: number, y: number, z: number): void;
  mortarImpact(x: number, y: number, z: number): void;

  // -- shared effects -------------------------------------------------------
  /** A bullet's visible path. Pooled by the client; a streak never owns one. */
  tracer(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void;
  /** An explosion. `bright` distinguishes a mortar from a bullet impact. */
  blast(x: number, y: number, z: number, radius: number, bright: boolean): void;
  /** Additive camera shake for the local player, 0..1-ish. Ignored where there is no camera. */
  shake(amount: number): void;
}

/**
 * The presentation a process with no output uses.
 *
 * Complete, not partial: the server's correct response to "play a gunshot" is to do
 * nothing, and it will still resolve the shot, award the kill and replicate the result.
 */
export const SILENT_PRESENTATION: StreakPresentation = {
  sentryDeploy(): void {},
  sentryShot(): void {},
  sentryDestroyed(): void {},
  packageDrop(): void {},
  packageLand(): void {},
  packageClaimed(): void {},
  chopperSpin(): void {},
  chopperShot(): void {},
  uavSweep(): void {},
  counterUav(): void {},
  mortarInbound(): void {},
  mortarImpact(): void {},
  tracer(): void {},
  blast(): void {},
  shake(): void {},
};
