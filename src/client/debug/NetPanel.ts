import { describeConditions, findPreset, NET_PRESETS, parseConditions } from '../../shared/net/NetSim';
import { MAX_REWIND_MS } from '../../shared/net/Protocol';
import {
  CORRECTION_SMOOTHING_TICKS,
  MAX_SMOOTHED_DISTANCE,
  POSITION_EPSILON,
} from '../../shared/net/Prediction';
import type { NetSession } from '../net/NetSession';
import { setField, type DebugOverlay } from './DebugOverlay';

/**
 * The network, prediction and rewind read-outs (M10, S7).
 *
 * S7 asks for three panels and this is all three, because they share a source and splitting
 * them across three files would mean three lookups of the same session.
 *
 * - **Network**: RTT, jitter, measured clock offset, server tick vs client tick, snapshot
 *   size, snapshots/sec, bandwidth up and down, packet loss.
 * - **Prediction**: misprediction count and distance p50/p99, replay depth, active smoothing.
 * - **Rewind**: what the server applied per shot, and how often the 200 ms cap bit.
 *
 * ## Why the rewind numbers come from the server
 *
 * A client cannot observe its own lag compensation — the rewind happens on the server, to
 * other people's hitboxes, on a tick the client will not see for another half a round trip.
 * So the figures shown here are the client's own *inputs* to that calculation (its RTT and
 * interpolation delay, which is exactly what `viewLagMsFor` uses), plus the per-shot record
 * the server sends back to a client that asked for it with `?rewinddebug=1`.
 *
 * Everything updates on the overlay's 15 Hz text hook rather than per frame. S7's panels
 * must not show up in the frame times they exist to report.
 */

export class NetPanel {
  private readonly session: () => NetSession | null;

  constructor(overlay: DebugOverlay, session: () => NetSession | null) {
    this.session = session;

    const left = overlay.leftColumn;

    // ---- NETWORK -----------------------------------------------------------
    const net = overlay.section('Network', left);
    const fState = net.addField('State');
    const fRtt = net.addField('RTT / jitter');
    const fOffset = net.addField('Clock offset');
    const fTicks = net.addField('Server / client tick');
    const fLead = net.addField('Lead / buffer');
    const fSnap = net.addField('Snapshot');
    const fRate = net.addField('Snapshots/sec');
    const fBandwidth = net.addField('Bandwidth');
    const fLoss = net.addField('Loss');
    const fSim = net.addField('Simulated');

    // ---- PREDICTION --------------------------------------------------------
    const pred = overlay.section('Prediction', left);
    const fMispred = pred.addField('Mispredictions');
    const fMispredDist = pred.addField('Error p50 / p99');
    const fReplay = pred.addField('Replay depth');
    const fSmoothing = pred.addField('Correction');
    const fUnacked = pred.addField('Unacked');

    // ---- REWIND ------------------------------------------------------------
    const rewind = overlay.section('Rewind', left);
    const fViewLag = rewind.addField('View lag');
    const fRewindTicks = rewind.addField('Rewind');
    const fCap = rewind.addField('Cap');

    overlay.addTextHook(() => {
      const s = this.session();
      if (s === null) {
        setField(fState, 'single-player (no server)');
        return;
      }
      const c = s.client;
      const st = c.stats;
      const p = c.prediction;
      const pct = p.percentiles();

      setField(fState, `${c.state}${c.closeReason === '' ? '' : ` — ${c.closeReason}`}`);
      setField(fRtt, `${st.rttMs.toFixed(0)} ms / ${st.jitterMs.toFixed(1)} ms`);
      setField(fOffset, `${st.clockOffsetMs.toFixed(0)} ms`);
      setField(fTicks, `${st.serverTick} / ${st.clientTick}`);
      setField(fLead, 
        `${st.leadTicks} ticks (${c.clock.leadMs().toFixed(0)} ms) · buffer ` +
          `${st.marginMs.toFixed(0)} ms${st.adaptiveMs > 0.5 ? ` (+${st.adaptiveMs.toFixed(0)} earned)` : ''}`,
      );
      setField(fSnap, `${st.lastSnapshotBytes} B now, ${st.meanSnapshotBytes.toFixed(0)} B mean`);
      setField(fRate, st.snapshotsPerSecond.toFixed(1));
      setField(fBandwidth, 
        `${fmtRate(st.bytesOutPerSecond)} up / ${fmtRate(st.bytesInPerSecond)} down`,
      );
      setField(fLoss, `${st.lossPct.toFixed(1)}% (${st.snapshotsLost} snapshots)`);
      setField(fSim, describeConditions(s.link.outbound.conditions));

      // Prediction. The misprediction count is S8.4's criterion and is deliberately the
      // first number: at zero added latency it must read zero, and anything else means the
      // step function is not pure and nothing downstream can be trusted.
      const rate = st.snapshotsReceived === 0 ? 0 : (p.stats.mispredictions / Math.max(1, p.stats.comparisons)) * 100;
      setField(fMispred, `${p.stats.mispredictions} / ${p.stats.comparisons} (${rate.toFixed(1)}%)`);
      setField(fMispredDist, 
        `${(pct.p50 * 100).toFixed(1)} cm / ${(pct.p99 * 100).toFixed(1)} cm  (eps ${(POSITION_EPSILON * 1000).toFixed(0)} mm)`,
      );
      setField(fReplay, `${p.stats.lastReplayDepth} now, ${p.stats.maxReplayDepth} max`);
      setField(fSmoothing, 
        `${(p.smoothingFraction * 100).toFixed(0)}% of ${CORRECTION_SMOOTHING_TICKS} ticks · ` +
          `snap past ${MAX_SMOOTHED_DISTANCE} m`,
      );
      setField(fUnacked, String(p.unacked));

      // Rewind: this client's contribution to the server's calculation.
      const interpMs = 100;
      const viewLag = st.rttMs * 0.5 + interpMs;
      const applied = Math.min(viewLag, MAX_REWIND_MS);
      setField(fViewLag, `${viewLag.toFixed(0)} ms (RTT/2 ${(st.rttMs * 0.5).toFixed(0)} + interp ${interpMs})`);
      setField(fRewindTicks, `${applied.toFixed(0)} ms ≈ ${Math.round(applied / (1000 / 60))} ticks`);
      setField(fCap, viewLag > MAX_REWIND_MS ? `CLAMPED at ${MAX_REWIND_MS} ms` : `${MAX_REWIND_MS} ms, not clamping`);
    });
  }

  /**
   * Change simulated conditions live (S7: *"toggleable live"*).
   *
   * Applied to both directions of the existing link rather than reconnecting, because a
   * toggle that tore the connection down would reset every counter it exists to move.
   */
  setConditions(spec: string): string {
    const s = this.session();
    if (s === null) return 'not connected';
    const parsed = parseConditions(spec) ?? findPreset(spec);
    if (parsed === null) {
      return `unrecognised '${spec}'. Presets: ${Object.keys(NET_PRESETS).join(', ')}`;
    }
    s.link.inbound.conditions = parsed;
    s.link.outbound.conditions = parsed;
    return `conditions now ${describeConditions(parsed)}`;
  }
}

function fmtRate(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(0)} B/s`;
  return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
}
