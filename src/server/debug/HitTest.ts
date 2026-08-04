import { logger } from '../../shared/core/Log';
import { DEFAULT_INTERPOLATION_DELAY_MS } from '../../shared/net/Interpolation';
import { describeConditions, type NetConditions } from '../../shared/net/NetSim';
import { EFlag } from '../../shared/net/Snapshot';
import { HeadlessClient } from './HeadlessClient';

const log = logger('hittest');

/**
 * A controlled hit-registration experiment (M10, S8.6).
 *
 * S8.6: *"fire on a strafing target at each latency preset and report hit rate. It must not
 * degrade materially with latency."*
 *
 * ## Why a dedicated experiment rather than reading the match numbers
 *
 * A hit rate taken out of a running bot match measures the aim script far more than it
 * measures the netcode. Bots take cover, die, respawn across the map and break line of sight,
 * so the denominator is dominated by shots that were never going to land for reasons that
 * have nothing to do with lag compensation — and comparing that number across latencies
 * compares two different fights.
 *
 * This is the controlled version: **one shooter, one target, a fixed strafe, a fixed range.**
 * The shooter aims at the target's *interpolated* position — which is what it can actually
 * see, and therefore what lag compensation has to make correct — and holds the trigger. The
 * only variable between runs is the simulated link.
 *
 * The comparison that makes the number mean something is `REWIND_DISABLED=1` on the server:
 * the same experiment with lag compensation switched off, which is the measurement that shows
 * what the system is worth rather than just that it is present.
 */

export interface HitTestResult {
  readonly conditions: string;
  readonly shots: number;
  readonly hits: number;
  readonly hitRate: number;
  readonly rttMs: number;
  /** Mispredictions on the shooter, for context. */
  readonly mispredictions: number;
}

export async function runHitTest(
  url: string,
  conditions: NetConditions,
  seconds: number,
  seed: number,
): Promise<HitTestResult> {
  // The target strafes on a fixed cadence and never shoots back; the shooter tracks it.
  const target = new HeadlessClient({
    url,
    name: 'TARGET',
    mapId: 'mp_foundry',
    conditions,
    behaviour: 'strafe',
    seed,
  });
  const shooter = new HeadlessClient({
    url,
    name: 'SHOOTER',
    mapId: 'mp_foundry',
    conditions,
    behaviour: 'seeker',
    seed: seed + 1,
  });

  await target.connect();
  await shooter.connect();

  // Let the clock sync and the pre-match countdown finish before counting anything. A shot
  // fired during WARMUP is refused by the server and would land in the denominator as a miss.
  await drive([target, shooter], 5000);
  const before = shooter.report();

  await drive([target, shooter], seconds * 1000);
  const after = shooter.report();

  target.disconnect(true);
  shooter.disconnect(true);

  const shots = after.shotsFired - before.shotsFired;
  const hits = after.hitsDealt - before.hitsDealt;
  const result: HitTestResult = {
    conditions: describeConditions(conditions),
    shots,
    hits,
    hitRate: shots === 0 ? 0 : hits / shots,
    rttMs: Math.round(after.stats.rttMs * 10) / 10,
    mispredictions: after.mispredictions - before.mispredictions,
  };

  log.info(
    `${result.conditions}: ${hits}/${shots} = ${(result.hitRate * 100).toFixed(1)}% at ` +
      `${result.rttMs}ms RTT (interpolating ${DEFAULT_INTERPOLATION_DELAY_MS}ms in the past).`,
  );
  return result;
}

/** Drive a set of clients for a wall-clock duration, faster than the tick rate. */
function drive(clients: readonly HeadlessClient[], ms: number): Promise<void> {
  const endAt = Date.now() + ms;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      for (const c of clients) c.update();
      if (Date.now() >= endAt) {
        clearInterval(timer);
        resolve();
      }
    }, 4);
  });
}

export { EFlag };
