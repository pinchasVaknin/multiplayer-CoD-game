import type { HitZone } from '../combat/HitboxRig';
import { HIT_ZONES } from '../combat/HitboxRig';
import type { InputCommand, MutableInputCommand } from '../core/InputCommand';
import type { PlayerSimState } from '../player/PlayerState';
import {
  MAGIC,
  MAX_COMMANDS_PER_BATCH,
  MsgC,
  MsgS,
  PROTOCOL_VERSION,
  quantAngle,
  dequantAngle,
  quantPitch,
  dequantPitch,
  quantPos,
  dequantPos,
  quantMove,
  dequantMove,
} from './Protocol';
import {
  readEntity,
  readOwnerState,
  writeEntity,
  writeOwnerState,
  type EntitySnapshot,
} from './Snapshot';
import type { NetLoadout, NetWeaponLoadout } from './Skirmish';
import { ByteReader, ByteWriter } from './Wire';

/**
 * Every message on the wire, encoded and decoded in one file (M10, S6.1).
 *
 * Reader and writer for a given message sit next to each other on purpose. A binary protocol
 * fails silently and expensively when the two halves drift, and the cheapest defence is that
 * changing one and not the other is visible in a single screen of code.
 *
 * ## Frame shape
 *
 * ```
 *   u32 MAGIC | u8 msgId | payload...
 * ```
 *
 * The magic costs four bytes per frame and buys a cheap, total rejection of anything that is
 * not this protocol — a stray HTTP request, a port scanner, an old client build. S4.16 wants
 * garbage to drop the connection rather than the process, and the earlier garbage is
 * recognised the less of it reaches a decoder.
 */

// -- events ------------------------------------------------------------------

/**
 * Gameplay events the client needs to *present* something for (S4.15).
 *
 * The table in S4.15 is explicit that cosmetics are **driven by replicated events, not
 * replicated state**: the server says `damage.dealt` and the client decides what that looks
 * and sounds like. So this list is events, and there is deliberately no tracer, decal or
 * particle anywhere in it.
 */
export const Ev = {
  /** Somebody fired. Carries the terminus, so the client can draw the whole shot. */
  Fired: 1,
  Damage: 2,
  Killed: 3,
  Footstep: 4,
  Jump: 5,
  Land: 6,
} as const;

export interface FiredEvent {
  sourceId: number;
  weaponIndex: number;
  /** Muzzle, in world space. */
  x: number;
  y: number;
  z: number;
  /**
   * Where the round stopped.
   *
   * One terminus per trigger pull, not per pellet. A shotgun fires up to eight rounds and
   * this is the first one's — which is the one the tracer and the impact belong to, exactly
   * as `WeaponSystem` already decided for the local case. Replicating eight termini to draw
   * eight sparks somebody is not looking at is bandwidth spent on nothing.
   */
  endX: number;
  endY: number;
  endZ: number;
  /** Terminating surface material, for the impact sound and spark colour. */
  material: number;
  tracer: boolean;
  hitTarget: boolean;
}

export interface DamageEvent {
  sourceId: number;
  targetId: number;
  amount: number;
  zone: HitZone;
  lethal: boolean;
  x: number;
  y: number;
  z: number;
}

export interface KilledEvent {
  targetId: number;
  sourceId: number;
  weaponIndex: number;
  zone: HitZone;
}

export interface FootstepEvent {
  entityId: number;
  x: number;
  y: number;
  z: number;
  material: number;
  heavy: boolean;
  quiet: boolean;
}

export interface PoseEvent {
  entityId: number;
  x: number;
  y: number;
  z: number;
  /** Landing impact speed; zero for a jump. */
  speed: number;
  material: number;
}

export interface EventSink {
  onFired?(e: FiredEvent): void;
  onDamage?(e: DamageEvent): void;
  onKilled?(e: KilledEvent): void;
  onFootstep?(e: FootstepEvent): void;
  onJump?(e: PoseEvent): void;
  onLand?(e: PoseEvent): void;
}

function zoneIndex(zone: HitZone): number {
  const at = HIT_ZONES.indexOf(zone);
  return at < 0 ? 1 : at;
}

function zoneAt(index: number): HitZone {
  return HIT_ZONES[index] ?? 'torso';
}

// -- writing -----------------------------------------------------------------

function head(w: ByteWriter, id: number): void {
  w.reset();
  w.u32(MAGIC);
  w.u8v(id);
}

/**
 * The first frame on a connection — and it carries the player's class (M11, Tier 1 #20).
 *
 * ## Why the loadout is here and not in a message that follows
 *
 * The seat is created **inside the handshake**: `onJoin` calls `addPlayer`, which builds the
 * `NetPlayer` whose constructor sets `controller.speedScale` from the resolved perks. A class
 * that arrives in a later frame therefore arrives after the entity it was meant to configure,
 * and for every tick in between the client predicts with Lightweight's +7% while the server
 * simulates without it.
 *
 * That window is not theoretical and it is not small. Measured with the class sent one frame
 * later: **178 mispredictions in 1277 comparisons** across a warmup period, against 0 once it
 * moved into the handshake. It is Tier 1 #20 in miniature — the same arithmetic, the same
 * cause, just bounded by how long the player stays in the arena rather than forever.
 *
 * A trailing optional field, so a client that has no class yet (the first ever run, before the
 * M6 save exists) simply omits it and gets the server defaults.
 */
export function writeHello(w: ByteWriter, name: string, loadout?: NetLoadout | null): Uint8Array {
  head(w, MsgC.Hello);
  w.u16(PROTOCOL_VERSION);
  w.str(name);
  w.u8v(loadout == null ? 0 : 1);
  if (loadout != null) writeLoadoutBody(w, loadout);
  return w.bytes();
}

export function writePing(w: ByteWriter, id: number, clientMs: number): Uint8Array {
  head(w, MsgC.Ping);
  w.u32(id);
  w.f64(clientMs);
  return w.bytes();
}

export function writeBye(w: ByteWriter, fromServer: boolean, reason: string): Uint8Array {
  head(w, fromServer ? MsgS.Bye : MsgC.Bye);
  w.str(reason);
  return w.bytes();
}

/**
 * A batch of commands, newest last.
 *
 * S6.2 requires the *whole* struct, and it is worth being blunt about why the redundancy is
 * here rather than a retransmit scheme: commands are tiny and a lost one is unrecoverable by
 * the time anybody notices. Sending the last few every tick means a single dropped frame
 * costs nothing at all, and at ~13 bytes a command that is cheaper than any acknowledgement
 * protocol would be.
 */
export function writeCommands(
  w: ByteWriter,
  cmds: readonly InputCommand[],
  count: number,
  lastSnapshotAck: number,
): Uint8Array {
  head(w, MsgC.Commands);
  const n = Math.min(count, MAX_COMMANDS_PER_BATCH);
  w.u16(lastSnapshotAck);
  w.u8v(n);
  for (let i = 0; i < n; i++) {
    const c = cmds[i];
    if (c === undefined) continue;
    w.u32(c.seq);
    w.i32(c.tickIndex);
    // Move axes are already normalised to -1..1 by the sampler; a byte each is 1/127
    // resolution, well under what a keyboard or a stick produces after normalisation.
    w.i8(quantMove(c.moveX));
    w.i8(quantMove(c.moveZ));
    w.u16(quantAngle(c.yaw));
    w.i16(quantPitch(c.pitch));
    w.u32(c.buttons);
  }
  return w.bytes();
}

/**
 * `Welcome` and `Migrate` share a body, deliberately.
 *
 * They say the same thing — *"this is your seat, in this instance, on this map, from this
 * tick"* — and differ only in whether the client had one before. One encoder means the
 * migration path cannot grow a field the join path lacks, which is the failure mode that
 * produces a client correctly seated in a live match and still rendering warmup's world.
 */
export function writeWelcome(w: ByteWriter, info: WelcomeInfo): Uint8Array {
  head(w, info.migrated ? MsgS.Migrate : MsgS.Welcome);
  writeSeatBody(w, info);
  return w.bytes();
}

function writeSeatBody(w: ByteWriter, info: WelcomeInfo): void {
  w.u16(PROTOCOL_VERSION);
  w.u8v(info.entityId);
  w.u8v(info.team === 'B' ? 1 : 0);
  w.str(info.mapId);
  w.str(info.modeId);
  w.i32(info.serverTick);
  w.f64(info.serverMs);
  w.u8v(info.snapshotHz);
  w.u16(info.matchId);
  w.i32(info.effectiveTick);
}

function readSeatBody(r: ByteReader, migrated: boolean): (WelcomeInfo & { version: number }) | null {
  const version = r.u16();
  const entityId = r.u8v();
  const team = r.u8v() === 1 ? 'B' : 'A';
  const mapId = r.str();
  const modeId = r.str();
  const serverTick = r.i32();
  const serverMs = r.f64();
  const snapshotHz = r.u8v();
  const matchId = r.u16();
  const effectiveTick = r.i32();
  if (r.overran) return null;
  return {
    version,
    entityId,
    team,
    mapId,
    modeId,
    serverTick,
    serverMs,
    snapshotHz,
    matchId,
    effectiveTick,
    migrated,
  };
}

// -- M11: the skirmish messages ----------------------------------------------

/**
 * The player's class, as ids (Tier 1 #20, rule 1).
 *
 * Nothing resolved crosses this wire: no damage number, no recoil value, no speed multiplier.
 * The server looks every id up in the same registry the client did and runs the same
 * `resolveLoadout`, so the two sides cannot disagree about what a class *does* while agreeing
 * about what it contains.
 */
export function writeLoadout(w: ByteWriter, loadout: NetLoadout): Uint8Array {
  head(w, MsgC.Loadout);
  writeLoadoutBody(w, loadout);
  return w.bytes();
}

/** The class's body, shared by `Hello` and `Loadout` so the two cannot encode it differently. */
function writeLoadoutBody(w: ByteWriter, loadout: NetLoadout): void {
  w.str(loadout.name);
  writeWeaponLoadout(w, loadout.primary);
  writeWeaponLoadout(w, loadout.secondary);
  w.str(loadout.lethal);
  w.str(loadout.tactical);
  w.str(loadout.fieldUpgrade);
  writeIdList(w, loadout.perks);
  writeIdList(w, loadout.streaks);
}

function readLoadoutBody(r: ByteReader): NetLoadout {
  const name = r.str();
  const primary = readWeaponLoadout(r);
  const secondary = readWeaponLoadout(r);
  const lethal = r.str();
  const tactical = r.str();
  const fieldUpgrade = r.str();
  const perks = readIdList(r);
  const streaks = readIdList(r);
  return { name, primary, secondary, lethal, tactical, fieldUpgrade, perks, streaks };
}

function writeWeaponLoadout(w: ByteWriter, weapon: NetWeaponLoadout): void {
  w.str(weapon.weaponId);
  w.str(weapon.camo ?? '');
  writeIdList(w, weapon.attachments);
}

function writeIdList(w: ByteWriter, ids: readonly (string | null)[]): void {
  const capped = Math.min(ids.length, MAX_ID_LIST);
  w.u8v(capped);
  for (let i = 0; i < capped; i++) w.str(ids[i] ?? '');
}

function readIdList(r: ByteReader): Array<string | null> {
  const count = r.u8v();
  const out: Array<string | null> = [];
  // Capped before the loop, so a claimed length of 200 cannot make the server allocate 200
  // strings before the reader notices it has run out of bytes (S4.16).
  if (count > MAX_ID_LIST) return out;
  for (let i = 0; i < count; i++) {
    const id = r.str();
    out.push(id === '' ? null : id);
  }
  return out;
}

function readWeaponLoadout(r: ByteReader): NetWeaponLoadout {
  const weaponId = r.str();
  const camo = r.str();
  const attachments = readIdList(r).filter((a): a is string => a !== null);
  return { weaponId, camo: camo === '' ? null : camo, attachments };
}

/** Longest id list any message may carry. Covers five attachments with room to spare. */
const MAX_ID_LIST = 8;

export function writeVote(w: ByteWriter, phase: number, option: number): Uint8Array {
  head(w, MsgC.Vote);
  w.u8v(phase);
  w.u8v(option);
  return w.bytes();
}

export function writeReady(w: ByteWriter, matchId: number): Uint8Array {
  head(w, MsgC.Ready);
  w.u16(matchId);
  return w.bytes();
}

export function writeVoteState(w: ByteWriter, info: VoteInfo): Uint8Array {
  head(w, MsgS.Vote);
  w.u8v(info.phase);
  w.i32(info.phaseEndsTick);
  w.u8v(Math.min(info.tally.length, MAX_BALLOT_OPTIONS));
  for (let i = 0; i < Math.min(info.tally.length, MAX_BALLOT_OPTIONS); i++) {
    w.u8v(Math.max(0, Math.min(255, info.tally[i] ?? 0)));
  }
  // Signed, because -1 is "no vote" and "not decided" and both are real states.
  w.i8(info.selfVote);
  w.i8(info.decidedMode);
  w.i8(info.decidedMap);
  w.u8v(Math.min(255, info.humans));
  return w.bytes();
}

/** Ballots are five modes and three maps; eight is headroom, not a limit anybody meets. */
const MAX_BALLOT_OPTIONS = 8;

export function writePrepare(
  w: ByteWriter,
  matchId: number,
  mapId: string,
  modeId: string,
): Uint8Array {
  head(w, MsgS.Prepare);
  w.u16(matchId);
  w.str(mapId);
  w.str(modeId);
  return w.bytes();
}

export function writeSummary(w: ByteWriter, info: SummaryInfo): Uint8Array {
  head(w, MsgS.Summary);
  w.u16(info.matchId);
  w.str(info.mapId);
  w.str(info.modeId);
  w.str(info.winner);
  w.str(info.reason);
  w.u16(info.scoreA);
  w.u16(info.scoreB);
  w.u8v(info.holdSeconds);
  w.u8v(Math.min(info.rows.length, MAX_SUMMARY_ROWS));
  for (let i = 0; i < Math.min(info.rows.length, MAX_SUMMARY_ROWS); i++) {
    const row = info.rows[i];
    if (row === undefined) continue;
    w.u8v(row.entityId);
    w.str(row.displayName);
    w.u8v((row.team === 'B' ? 1 : 0) | (row.isBot ? 2 : 0));
    w.u16(row.kills);
    w.u16(row.deaths);
    w.u16(row.assists);
    w.i32(row.score);
  }
  w.u8v(Math.min(info.xp.length, MAX_XP_LINES));
  for (let i = 0; i < Math.min(info.xp.length, MAX_XP_LINES); i++) {
    const line = info.xp[i];
    if (line === undefined) continue;
    w.str(line.label);
    w.i32(line.amount);
  }
  return w.bytes();
}

const MAX_SUMMARY_ROWS = 24;
const MAX_XP_LINES = 12;

export function writeNotice(w: ByteWriter, text: string): Uint8Array {
  head(w, MsgS.Notice);
  w.str(text);
  return w.bytes();
}

export function writeReject(w: ByteWriter, code: number): Uint8Array {
  head(w, MsgS.Reject);
  w.u8v(code);
  return w.bytes();
}

export function writePong(
  w: ByteWriter,
  id: number,
  clientMs: number,
  serverMs: number,
  serverTick: number,
): Uint8Array {
  head(w, MsgS.Pong);
  w.u32(id);
  // Echoed untouched so the client can match a reply to its own send without keeping a table.
  w.f64(clientMs);
  w.f64(serverMs);
  w.i32(serverTick);
  return w.bytes();
}

export interface SnapshotHeader {
  snapshotId: number;
  baselineId: number;
  serverTick: number;
  /** The last command seq the server has processed for this client. The ack (S4.11). */
  ackSeq: number;
  /** The tick that command was applied on. */
  ackTick: number;
  /** Score, so the HUD has it without a second channel. */
  scoreA: number;
  scoreB: number;
  /** Seconds left in the match, or -1 outside a running clock. */
  timeLeft: number;
  /** `SFlag` bits. Match phase, which S4.15 lists as server-authoritative round state. */
  flags: number;
  /** Index into `MATCH_PHASES`. The HUD's banner reads the phase, not just the frozen bit. */
  phase: number;
  /** Seconds left of the warm-up or round-end hold. Drives the 3-2-1 countdown. */
  phaseSeconds: number;
  /** Round number, for the modes that have them. */
  round: number;
  /**
   * How often this client's commands have recently arrived too late to use, 0-60.
   *
   * The feedback signal for S4.11's *"measure and adapt this offset per client"*. Only the
   * server can measure it — the client has no way to know its command was late, because from
   * its side it was sent on time.
   */
  starvation: number;
}

/**
 * Snapshot header flags.
 *
 * `InputFrozen` exists because of a divergence that was invisible until it was measured. The
 * server zeroes a player's movement axes during WARMUP and ROUND_END, and applies no command
 * at all while they are dead. A client that did not know either of those things kept
 * predicting ordinary movement, and every tick of the three-second countdown and every tick
 * of every death produced a correction. Measured before this flag existed: ~68 mispredictions
 * per twenty-second run at **zero** added latency, p50 7.7 cm.
 *
 * S4.15 already puts "round state" in the server-authoritative column. This is that rule
 * being honoured rather than a new mechanism.
 */
export const SFlag = {
  /** Countdown or post-round: movement and actions are ignored, look is not. */
  InputFrozen: 1 << 0,
  /** The match has ended. */
  MatchOver: 1 << 1,
} as const;

export function writeSnapshotHeader(w: ByteWriter, h: SnapshotHeader): void {
  head(w, MsgS.Snapshot);
  w.u16(h.snapshotId);
  w.u16(h.baselineId);
  w.i32(h.serverTick);
  /**
   * **Signed**, so the "nothing acked yet" sentinel survives the wire.
   *
   * This was a bug worth remembering. `ackSeq` starts at -1 on a freshly seated player, and
   * as a `u32` that arrives as 4,294,967,295. The client set `lastAckedSeq` to four billion
   * on the first snapshot and then silently discarded every real ack for the rest of the
   * match as "older than one already applied" — so reconciliation ran exactly once, at join,
   * and never again. Nothing looked wrong: the player moved, the game played, and prediction
   * was quietly doing nothing at all.
   *
   * It only appeared with two clients, because with one the join happened to complete before
   * the first snapshot went out and the sentinel was never sent.
   */
  w.i32(h.ackSeq);
  w.i32(h.ackTick);
  w.u16(h.scoreA);
  w.u16(h.scoreB);
  w.i16(Math.round(h.timeLeft));
  w.u8v(h.flags);
  w.u8v(h.starvation);
  w.u8v(h.phase);
  // Tenths, so a 3-2-1 countdown ticks smoothly rather than in whole seconds.
  w.u16(Math.max(0, Math.round(h.phaseSeconds * 10)));
  w.u8v(Math.min(255, Math.max(0, h.round)));
}

/** The owner block, flagged so a spectating or unspawned client can omit it entirely. */
export function writeSnapshotOwner(w: ByteWriter, owner: PlayerSimState | null): void {
  if (owner === null) {
    w.u8v(0);
    return;
  }
  w.u8v(1);
  writeOwnerState(w, owner);
}

export function writeSnapshotEntities(
  w: ByteWriter,
  entities: readonly EntitySnapshot[],
  count: number,
  baseline: (id: number) => EntitySnapshot | null,
  removed: readonly number[],
  removedCount: number,
): void {
  w.u8v(Math.min(removedCount, 255));
  for (let i = 0; i < removedCount && i < 255; i++) w.u8v(removed[i] ?? 0);
  w.u8v(Math.min(count, 255));
  for (let i = 0; i < count && i < 255; i++) {
    const e = entities[i];
    if (e === undefined) continue;
    writeEntity(w, e, baseline(e.entityId));
  }
}

export function beginEvents(w: ByteWriter): void {
  head(w, MsgS.Events);
  w.u8v(0); // count, patched by `finishEvents`
}

export function writeFired(w: ByteWriter, e: FiredEvent): void {
  w.u8v(Ev.Fired);
  w.u8v(e.sourceId);
  w.u8v(e.weaponIndex);
  w.i16(quantPos(e.x));
  w.i16(quantPos(e.y));
  w.i16(quantPos(e.z));
  w.i16(quantPos(e.endX));
  w.i16(quantPos(e.endY));
  w.i16(quantPos(e.endZ));
  w.u8v(e.material);
  w.u8v((e.tracer ? 1 : 0) | (e.hitTarget ? 2 : 0));
}

export function writeDamage(w: ByteWriter, e: DamageEvent): void {
  w.u8v(Ev.Damage);
  w.u8v(e.sourceId);
  w.u8v(e.targetId);
  w.u16(Math.round(Math.min(65535, Math.max(0, e.amount * 100))));
  w.u8v(zoneIndex(e.zone) | (e.lethal ? 0x80 : 0));
  w.i16(quantPos(e.x));
  w.i16(quantPos(e.y));
  w.i16(quantPos(e.z));
}

export function writeKilled(w: ByteWriter, e: KilledEvent): void {
  w.u8v(Ev.Killed);
  w.u8v(e.targetId);
  w.u8v(e.sourceId);
  w.u8v(e.weaponIndex);
  w.u8v(zoneIndex(e.zone));
}

export function writeFootstep(w: ByteWriter, e: FootstepEvent): void {
  w.u8v(Ev.Footstep);
  w.u8v(e.entityId);
  w.i16(quantPos(e.x));
  w.i16(quantPos(e.y));
  w.i16(quantPos(e.z));
  w.u8v(e.material);
  w.u8v((e.heavy ? 1 : 0) | (e.quiet ? 2 : 0));
}

export function writePose(w: ByteWriter, kind: number, e: PoseEvent): void {
  w.u8v(kind);
  w.u8v(e.entityId);
  w.i16(quantPos(e.x));
  w.i16(quantPos(e.y));
  w.i16(quantPos(e.z));
  w.u8v(Math.round(Math.min(255, Math.abs(e.speed) * 10)));
  w.u8v(e.material);
}

/**
 * Patch the event count into the byte reserved by `beginEvents`.
 *
 * The count is written last because it is not known first, and reserving a byte is cheaper
 * than buffering the events somewhere to count them. `bytes()` is a live view over the
 * writer's own buffer, so writing through it patches the frame in place.
 */
export function finishEvents(w: ByteWriter, count: number): Uint8Array {
  const frame = w.bytes();
  // u32 magic + u8 msgId = offset 5.
  if (frame.length > 5) frame[5] = Math.min(count, 255);
  return frame;
}

// -- reading -----------------------------------------------------------------

/**
 * What the server told this client about the match it just joined.
 *
 * **The client builds its world from this and never from its own menu selection** (M10,
 * playtest round 2). Before that rule existed the browser loaded whichever map was last
 * picked in the front end while the server ran whatever `MAP` said, and the two disagreeing
 * produced exactly the symptoms you would predict and none of the ones you would look for:
 * spawning outside the geometry, walking through walls that are not there, and a rubber-band
 * every time the authoritative position was applied against a collision world that did not
 * match. It reads as a netcode fault and is a *loading* fault.
 */
export interface WelcomeInfo {
  readonly entityId: number;
  readonly team: 'A' | 'B';
  readonly mapId: string;
  readonly modeId: string;
  readonly serverTick: number;
  readonly serverMs: number;
  readonly snapshotHz: number;
  /**
   * Which instance this seat is in (M11). `WARMUP_MATCH_ID` is the arena.
   *
   * Carried on `Welcome` as well as `Migrate` so there is exactly one field the client reads
   * to answer *"whose world is this snapshot describing"*, on both the join path and the
   * migration path. A client that inferred it from the map id would be right until somebody
   * voted for a live match on the greybox room.
   */
  readonly matchId: number;
  /**
   * The tick this seat becomes live, from the server's clock (§4.18).
   *
   * On a join this is simply the current tick. On a migration it is the **named tick** the
   * contract turns on: the router sends this player's messages to the old instance up to it
   * and the new one from it, and the client applies nothing from the new instance before it.
   */
  readonly effectiveTick: number;
  /** True when this is a migration rather than a fresh join. Drives the client's flush. */
  readonly migrated: boolean;
}

/** One row of the end-of-match summary (§6.9). */
export interface SummaryRow {
  readonly entityId: number;
  readonly displayName: string;
  readonly team: 'A' | 'B';
  readonly kills: number;
  readonly deaths: number;
  readonly assists: number;
  readonly score: number;
  readonly isBot: boolean;
}

/** The XP breakdown the M6 bar animates. Awarded by the instance, persisted by the client. */
export interface SummaryXpLine {
  readonly label: string;
  readonly amount: number;
}

export interface SummaryInfo {
  readonly matchId: number;
  readonly mapId: string;
  readonly modeId: string;
  readonly winner: string;
  readonly reason: string;
  readonly scoreA: number;
  readonly scoreB: number;
  readonly rows: readonly SummaryRow[];
  readonly xp: readonly SummaryXpLine[];
  /** Seconds the summary is held before everybody is migrated back (§6.9: 12-15 s). */
  readonly holdSeconds: number;
}

/** The vote cycle as the server sees it. The client renders this and computes nothing. */
export interface VoteInfo {
  readonly phase: number;
  readonly phaseEndsTick: number;
  readonly tally: readonly number[];
  readonly selfVote: number;
  readonly decidedMode: number;
  readonly decidedMap: number;
  readonly humans: number;
}

/** Everything a decoded frame can be. Discriminated on `kind`. */
export type Decoded =
  | { kind: 'hello'; version: number; name: string; loadout: NetLoadout | null }
  | { kind: 'commands'; count: number; snapshotAck: number }
  | { kind: 'ping'; id: number; clientMs: number }
  | { kind: 'bye'; reason: string }
  | ({ kind: 'welcome'; version: number } & WelcomeInfo)
  | { kind: 'reject'; code: number }
  | { kind: 'pong'; id: number; clientMs: number; serverMs: number; serverTick: number }
  | { kind: 'snapshot' }
  | { kind: 'events'; count: number }
  | { kind: 'loadout'; loadout: NetLoadout }
  | { kind: 'vote'; phase: number; option: number }
  | { kind: 'ready'; matchId: number }
  | ({ kind: 'migrate'; version: number } & WelcomeInfo)
  | ({ kind: 'voteState' } & VoteInfo)
  | { kind: 'prepare'; matchId: number; mapId: string; modeId: string }
  | ({ kind: 'summary' } & SummaryInfo)
  | { kind: 'notice'; text: string }
  | { kind: 'bad' };

const BAD: Decoded = { kind: 'bad' };

/**
 * Read the frame header and dispatch on the message id.
 *
 * Returns `{kind:'bad'}` for anything unrecognised, truncated or not ours. **It never
 * throws** — S4.16 makes that a hard requirement, because every byte reaching this function
 * came from an untrusted socket and an exception here is a denial-of-service vector rather
 * than a bug report.
 *
 * `snapshot` and `commands` decode their header only; their bodies are streamed by the
 * caller out of the same reader, because both are variable-length and neither should
 * allocate a list to hand back.
 */
export function decodeHeader(r: ByteReader): Decoded {
  if (r.remaining < 5) return BAD;
  if (r.u32() !== MAGIC) return BAD;
  const id = r.u8v();

  switch (id) {
    case MsgC.Hello: {
      const version = r.u16();
      const name = r.str();
      // The version is checked by the caller before any of this is trusted, but the trailing
      // loadout must still decode without throwing on a frame from a build that did not send
      // one — hence the explicit presence byte rather than "read if bytes remain".
      const hasLoadout = r.u8v() === 1;
      const loadout = hasLoadout ? readLoadoutBody(r) : null;
      return r.overran ? BAD : { kind: 'hello', version, name, loadout };
    }
    case MsgC.Commands: {
      const snapshotAck = r.u16();
      const count = r.u8v();
      if (r.overran || count > MAX_COMMANDS_PER_BATCH) return BAD;
      return { kind: 'commands', count, snapshotAck };
    }
    case MsgC.Ping: {
      const pid = r.u32();
      const clientMs = r.f64();
      return r.overran ? BAD : { kind: 'ping', id: pid, clientMs };
    }
    case MsgC.Bye:
    case MsgS.Bye: {
      const reason = r.str();
      return r.overran ? BAD : { kind: 'bye', reason };
    }
    case MsgS.Welcome: {
      const seat = readSeatBody(r, false);
      return seat === null ? BAD : { kind: 'welcome', ...seat };
    }
    case MsgS.Migrate: {
      const seat = readSeatBody(r, true);
      return seat === null ? BAD : { kind: 'migrate', ...seat };
    }
    case MsgC.Loadout: {
      const name = r.str();
      const primary = readWeaponLoadout(r);
      const secondary = readWeaponLoadout(r);
      const lethal = r.str();
      const tactical = r.str();
      const fieldUpgrade = r.str();
      const perks = readIdList(r);
      const streaks = readIdList(r);
      if (r.overran) return BAD;
      // Structurally decoded only. `sanitiseNetLoadout` is what decides whether any of these
      // ids are *real*, and it is deliberately a separate step: decoding is about bytes and
      // validation is about meaning, and folding them together is how a decoder ends up
      // throwing on a name it does not recognise (S4.16).
      return {
        kind: 'loadout',
        loadout: { name, primary, secondary, lethal, tactical, fieldUpgrade, perks, streaks },
      };
    }
    case MsgC.Vote: {
      const phase = r.u8v();
      const option = r.u8v();
      return r.overran ? BAD : { kind: 'vote', phase, option };
    }
    case MsgC.Ready: {
      const matchId = r.u16();
      return r.overran ? BAD : { kind: 'ready', matchId };
    }
    case MsgS.Vote: {
      const phase = r.u8v();
      const phaseEndsTick = r.i32();
      const count = r.u8v();
      if (r.overran || count > MAX_BALLOT_OPTIONS) return BAD;
      const tally: number[] = [];
      for (let i = 0; i < count; i++) tally.push(r.u8v());
      const selfVote = r.i8();
      const decidedMode = r.i8();
      const decidedMap = r.i8();
      const humans = r.u8v();
      if (r.overran) return BAD;
      return {
        kind: 'voteState',
        phase,
        phaseEndsTick,
        tally,
        selfVote,
        decidedMode,
        decidedMap,
        humans,
      };
    }
    case MsgS.Prepare: {
      const matchId = r.u16();
      const mapId = r.str();
      const modeId = r.str();
      return r.overran ? BAD : { kind: 'prepare', matchId, mapId, modeId };
    }
    case MsgS.Summary: {
      const matchId = r.u16();
      const mapId = r.str();
      const modeId = r.str();
      const winner = r.str();
      const reason = r.str();
      const scoreA = r.u16();
      const scoreB = r.u16();
      const holdSeconds = r.u8v();
      const rowCount = r.u8v();
      if (r.overran || rowCount > MAX_SUMMARY_ROWS) return BAD;
      const rows: SummaryRow[] = [];
      for (let i = 0; i < rowCount; i++) {
        const entityId = r.u8v();
        const displayName = r.str();
        const bits = r.u8v();
        const kills = r.u16();
        const deaths = r.u16();
        const assists = r.u16();
        const score = r.i32();
        rows.push({
          entityId,
          displayName,
          team: (bits & 1) !== 0 ? 'B' : 'A',
          isBot: (bits & 2) !== 0,
          kills,
          deaths,
          assists,
          score,
        });
      }
      const xpCount = r.u8v();
      if (r.overran || xpCount > MAX_XP_LINES) return BAD;
      const xp: SummaryXpLine[] = [];
      for (let i = 0; i < xpCount; i++) xp.push({ label: r.str(), amount: r.i32() });
      if (r.overran) return BAD;
      return {
        kind: 'summary',
        matchId,
        mapId,
        modeId,
        winner,
        reason,
        scoreA,
        scoreB,
        holdSeconds,
        rows,
        xp,
      };
    }
    case MsgS.Notice: {
      const text = r.str();
      return r.overran ? BAD : { kind: 'notice', text };
    }
    case MsgS.Reject: {
      const code = r.u8v();
      return r.overran ? BAD : { kind: 'reject', code };
    }
    case MsgS.Pong: {
      const pid = r.u32();
      const clientMs = r.f64();
      const serverMs = r.f64();
      const serverTick = r.i32();
      return r.overran ? BAD : { kind: 'pong', id: pid, clientMs, serverMs, serverTick };
    }
    case MsgS.Snapshot:
      return { kind: 'snapshot' };
    case MsgS.Events: {
      const count = r.u8v();
      return r.overran ? BAD : { kind: 'events', count };
    }
    default:
      return BAD;
  }
}

/** Read one command out of a `commands` body into a caller-owned record. */
export function readCommand(r: ByteReader, out: MutableInputCommand): void {
  out.seq = r.u32();
  out.tickIndex = r.i32();
  out.moveX = dequantMove(r.i8());
  out.moveZ = dequantMove(r.i8());
  out.yaw = dequantAngle(r.u16());
  out.pitch = dequantPitch(r.i16());
  out.buttons = r.u32();
  // Never transmitted: it is the *sampling runtime's* clock, so a client's value is
  // meaningless here and trusting one would be trusting a number an attacker chose.
  out.sampledAtMs = 0;
}

export function readSnapshotHeader(r: ByteReader, out: SnapshotHeader): void {
  out.snapshotId = r.u16();
  out.baselineId = r.u16();
  out.serverTick = r.i32();
  out.ackSeq = r.i32();
  out.ackTick = r.i32();
  out.scoreA = r.u16();
  out.scoreB = r.u16();
  out.timeLeft = r.i16();
  out.flags = r.u8v();
  out.starvation = r.u8v();
  out.phase = r.u8v();
  out.phaseSeconds = r.u16() / 10;
  out.round = r.u8v();
}

export function makeSnapshotHeader(): SnapshotHeader {
  return {
    snapshotId: 0,
    baselineId: 0,
    serverTick: 0,
    ackSeq: 0,
    ackTick: 0,
    scoreA: 0,
    scoreB: 0,
    timeLeft: -1,
    flags: 0,
    starvation: 0,
    phase: 0,
    phaseSeconds: 0,
    round: 1,
  };
}

/**
 * Wire order for `MatchPhase`. Index, not string — one byte instead of a length-prefixed word.
 *
 * Mirrors `MATCH_PHASES` in `shared/modes/MatchFlow.ts`; the two are asserted to agree by
 * `phaseIndex` returning 0 for anything unrecognised, which is WARMUP and is the safe answer.
 */
export const WIRE_PHASES = ['WARMUP', 'LIVE', 'ROUND_END', 'MATCH_END'] as const;

export function phaseIndex(phase: string): number {
  const at = WIRE_PHASES.indexOf(phase as (typeof WIRE_PHASES)[number]);
  return at < 0 ? 0 : at;
}

export function phaseAt(index: number): (typeof WIRE_PHASES)[number] {
  return WIRE_PHASES[index] ?? 'WARMUP';
}

/** True when an owner block follows. */
export function readSnapshotOwnerPresent(r: ByteReader): boolean {
  return r.u8v() === 1;
}

export { readOwnerState, readEntity };

/**
 * Stream the event list into a sink.
 *
 * Unknown event ids abort the rest of the frame rather than trying to skip: without a length
 * prefix per event there is no way to know where the next one starts, and guessing would
 * decode the remaining bytes as garbage. A newer server talking to an older client is a
 * version mismatch, and the handshake has already refused that case — this is the belt to
 * that braces.
 */
export function readEvents(r: ByteReader, count: number, sink: EventSink): boolean {
  for (let i = 0; i < count; i++) {
    const kind = r.u8v();
    if (r.overran) return false;
    switch (kind) {
      case Ev.Fired: {
        const e = firedScratch;
        e.sourceId = r.u8v();
        e.weaponIndex = r.u8v();
        e.x = dequantPos(r.i16());
        e.y = dequantPos(r.i16());
        e.z = dequantPos(r.i16());
        e.endX = dequantPos(r.i16());
        e.endY = dequantPos(r.i16());
        e.endZ = dequantPos(r.i16());
        e.material = r.u8v();
        const bits = r.u8v();
        e.tracer = (bits & 1) !== 0;
        e.hitTarget = (bits & 2) !== 0;
        if (r.overran) return false;
        sink.onFired?.(e);
        break;
      }
      case Ev.Damage: {
        const e = damageScratch;
        e.sourceId = r.u8v();
        e.targetId = r.u8v();
        e.amount = r.u16() / 100;
        const z = r.u8v();
        e.zone = zoneAt(z & 0x7f);
        e.lethal = (z & 0x80) !== 0;
        e.x = dequantPos(r.i16());
        e.y = dequantPos(r.i16());
        e.z = dequantPos(r.i16());
        if (r.overran) return false;
        sink.onDamage?.(e);
        break;
      }
      case Ev.Killed: {
        const e = killedScratch;
        e.targetId = r.u8v();
        e.sourceId = r.u8v();
        e.weaponIndex = r.u8v();
        e.zone = zoneAt(r.u8v());
        if (r.overran) return false;
        sink.onKilled?.(e);
        break;
      }
      case Ev.Footstep: {
        const e = footstepScratch;
        e.entityId = r.u8v();
        e.x = dequantPos(r.i16());
        e.y = dequantPos(r.i16());
        e.z = dequantPos(r.i16());
        e.material = r.u8v();
        const bits = r.u8v();
        e.heavy = (bits & 1) !== 0;
        e.quiet = (bits & 2) !== 0;
        if (r.overran) return false;
        sink.onFootstep?.(e);
        break;
      }
      case Ev.Jump:
      case Ev.Land: {
        const e = poseScratch;
        e.entityId = r.u8v();
        e.x = dequantPos(r.i16());
        e.y = dequantPos(r.i16());
        e.z = dequantPos(r.i16());
        e.speed = r.u8v() / 10;
        e.material = r.u8v();
        if (r.overran) return false;
        if (kind === Ev.Jump) sink.onJump?.(e);
        else sink.onLand?.(e);
        break;
      }
      default:
        return false;
    }
  }
  return true;
}

// Decode scratch. Handed to the sink for the duration of the call and never retained —
// the same "payloads are transient" contract the EventBus has used since M1.
const firedScratch: FiredEvent = {
  sourceId: 0,
  weaponIndex: 0,
  x: 0,
  y: 0,
  z: 0,
  endX: 0,
  endY: 0,
  endZ: 0,
  material: 0,
  tracer: false,
  hitTarget: false,
};
const damageScratch: DamageEvent = {
  sourceId: 0,
  targetId: 0,
  amount: 0,
  zone: 'torso',
  lethal: false,
  x: 0,
  y: 0,
  z: 0,
};
const killedScratch: KilledEvent = { targetId: 0, sourceId: 0, weaponIndex: 0, zone: 'torso' };
const footstepScratch: FootstepEvent = {
  entityId: 0,
  x: 0,
  y: 0,
  z: 0,
  material: 0,
  heavy: false,
  quiet: false,
};
const poseScratch: PoseEvent = { entityId: 0, x: 0, y: 0, z: 0, speed: 0, material: 0 };

export { ByteReader, ByteWriter };
