import type { HitZone } from '../combat/HitboxRig';
import { HIT_ZONES } from '../combat/HitboxRig';
import type { InputCommand, MutableInputCommand } from '../core/InputCommand';
import { CHEAT_CODE_MAX } from '../cheats/Cheats';
import type { PlayerSimState } from '../player/PlayerState';
import {
  MAGIC,
  MAX_COMMANDS_PER_BATCH,
  MsgC,
  MsgS,
  PROTOCOL_VERSION,
  RECONNECT_TOKEN_BYTES,
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
import {
  MAX_STREAK_OFFERS,
  MAX_PROJECTILES,
  MAX_SMOKE,
  type ProjectileState,
  type SmokeState,
  MAX_STREAK_ENTITIES,
  MAX_UAV_CONTACTS,
  type StreakEntityState,
  type StreakOfferState,
  type StreakView,
  type UavContactState,
  BOMB_CARRIED,
  BOMB_DEFUSED,
  BOMB_EXPLODED,
  BOMB_PLANTED,
  MAX_OBJECTIVES,
  MAX_TAGS,
  OBJ_TEAM_A,
  OBJ_TEAM_B,
  type NetLoadout,
  type NetWeaponLoadout,
  type ObjectiveState,
} from './Skirmish';
import type { BombInfo, TagInfo } from '../modes/GameMode';
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
 * and sounds like.
 *
 * ## One judgement call, named rather than glossed (M11 Gate B, S8.25)
 *
 * This comment used to claim there was *"deliberately no tracer, decal or particle anywhere in
 * it"*, and `FiredEvent.tracer` is a few lines below — the comment was simply wrong, and a
 * comment that lies about the audit it describes is worse than no comment. The audit is now
 * `scripts/check-cosmetics.mjs`, which is a check that fails rather than a sentence that
 * asserts.
 *
 * The tracer bit stays, and here is the actual argument for it. S8.25's requirement is that no
 * cosmetic state appears in a **snapshot**, and it does not: the entity snapshot is nineteen
 * fields of position, velocity, stance, health, weapon and event counters, pinned by that check.
 * `tracer` rides an *event*, which is the channel S4.15 says cosmetics are supposed to be driven
 * by. It is one bit meaning "this shot was a tracer round" — a fact about which round in the
 * magazine this was, which the firing side knows and a receiving client cannot recover across
 * packet loss without counting shots it may not have seen. The client still owns what a tracer
 * looks like, how long it lives and whether to draw one at all.
 *
 * What would be a violation, and is not present: a position for the tracer, a particle count, a
 * decal id, a muzzle-flash intensity, a viewmodel pose, a camera-shake magnitude.
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
  /**
   * How many of this pull's rays found a body (protocol v14, playtest round 5, B5).
   *
   * This was a `hitTarget` bit, and a bit is not a statistic. `ScoreSystem` builds a client's
   * whole scoreboard — accuracy column included — out of replicated events, so a remote
   * shotgunner's eight rays arriving as one connected-or-not flag meant the client counted
   * *pulls* where the server counted *rays*: one figure with two definitions, split by runtime,
   * which is the shape this milestone keeps finding.
   *
   * How many rays the pull sent is **not** here: it is `WEAPON_DEFS[weaponIndex].pellets`, and
   * both sides compile against that table. A derived field on the wire is a second copy of a
   * fact. `hitTarget` is derived from this one the same way, by the one consumer that wants it.
   *
   * Six bits of the byte the tracer flag already occupies, so it costs nothing.
   */
  pelletsHit: number;
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
  /**
   * The killer's remaining health at the instant of the kill (protocol v15, round 5, F9).
   *
   * Every entity's health is already in the snapshot, so a client *can* answer this without the
   * byte — from a frame up to a tick and an interpolation delay old, which may already include
   * damage the killer took afterwards. The death panel's whole value is "he had 8 health left"
   * versus "he had 100", and the stale version of that sentence describes a different fight.
   *
   * One byte on an event that happens a few times a minute per player, against a number that
   * only the server holds at the moment it is true. 0 means there was no killer to ask.
   */
  killerHealth: number;
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
 *
 * ## And the reconnect token, behind it (playtest round 4, F8)
 *
 * *"I was here a moment ago and this is my seat."* Optional in exactly the same way and for the
 * same reason: a first connection has nothing to present, and presenting a token nobody
 * recognises is an ordinary join rather than an error. Sent last so the class — which every
 * connection has an opinion about — is not behind a field most of them omit.
 *
 * The server never trusts it beyond looking it up: see `ReconnectRegistry.claim` for what it
 * refuses, and `RECONNECT_TOKEN_BYTES` for why guessing one is the attack it is designed
 * against.
 */
export function writeHello(
  w: ByteWriter,
  name: string,
  loadout?: NetLoadout | null,
  reconnectToken?: Uint8Array | null,
): Uint8Array {
  head(w, MsgC.Hello);
  w.u16(PROTOCOL_VERSION);
  w.str(name);
  w.u8v(loadout == null ? 0 : 1);
  if (loadout != null) writeLoadoutBody(w, loadout);
  const token = reconnectToken != null && reconnectToken.length === RECONNECT_TOKEN_BYTES
    ? reconnectToken
    : null;
  w.u8v(token === null ? 0 : 1);
  if (token !== null) w.raw(token);
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
export function writeWelcome(
  w: ByteWriter,
  info: WelcomeInfo,
  reconnectToken: Uint8Array | null,
): Uint8Array {
  head(w, info.migrated ? MsgS.Migrate : MsgS.Welcome);
  writeSeatBody(w, info, reconnectToken);
  return w.bytes();
}

/**
 * The token rides the seat body, and is **not** part of `WelcomeInfo` (round 4, F8).
 *
 * `WelcomeInfo` is *"this is your seat"* — the thing a world is built from, reconstructed by
 * `NetClient.matchInfo` and handed around the client. A credential is not part of that answer,
 * and folding it in would mean every builder of a `WelcomeInfo` — there are three — deciding
 * what to put in a field only one of them knows anything about. So it is a separate argument
 * with exactly one caller, `Session.sendSeat`, which stamps its own connection's token.
 */
function writeSeatBody(w: ByteWriter, info: WelcomeInfo, reconnectToken: Uint8Array | null): void {
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
  const token =
    reconnectToken != null && reconnectToken.length === RECONNECT_TOKEN_BYTES ? reconnectToken : null;
  w.u8v(token === null ? 0 : 1);
  if (token !== null) w.raw(token);
}

function readSeatBody(
  r: ByteReader,
  migrated: boolean,
): (WelcomeInfo & { version: number; reconnectToken: Uint8Array | null }) | null {
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
  const hasToken = r.u8v() === 1;
  const reconnectToken = hasToken ? r.raw(RECONNECT_TOKEN_BYTES) : null;
  if (r.overran) return null;
  return {
    version,
    reconnectToken,
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
  w.i32(info.endsTick);
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

/**
 * Objective state, one record per zone in the mode's own order (M11 Gate B, §6.8).
 *
 * Four bytes a zone: owner and capturing team packed into one, progress as a byte, and the two
 * body counts. The counts are what the HUD's contested indicator reads, and §6.8 requires
 * contested state not to flicker under jitter — sending the counts rather than a derived
 * boolean means the client renders exactly what the server counted rather than re-deriving it
 * from a position list that is 100 ms in the past.
 */
export function writeObjectives(w: ByteWriter, states: readonly ObjectiveState[]): Uint8Array {
  head(w, MsgS.Objectives);
  const n = Math.min(states.length, MAX_OBJECTIVES);
  w.u8v(n);
  for (let i = 0; i < n; i++) {
    const o = states[i];
    if (o === undefined) continue;
    // Owner in the low two bits, capturing team in the next two. Both are 0-2.
    w.u8v((o.owner & 0x03) | ((o.capturing & 0x03) << 2));
    w.u8v(o.progress);
    w.u8v(Math.min(255, o.countA));
    w.u8v(Math.min(255, o.countB));
  }
  return w.bytes();
}

/**
 * Kill Confirmed's dog tags (M11 Gate B, §6.8).
 *
 * Seven bytes a tag: a `uint16` id and three quantised `int16` positions. The id wraps at 65535
 * and is compared for equality only, never ordered, so a match long enough to drop that many
 * tags reuses an id that has been off the floor for hours.
 *
 * **The newest tags win when the list overflows.** A tag near the end of its 20 s life is the
 * one whose absence a player is least likely to notice, and the one most likely to be gone
 * before the next frame anyway; a tag that landed this tick is on a body somebody is standing
 * over. Truncating the front rather than the back is the difference between a cap that degrades
 * and a cap that hides exactly the tags being fought over.
 */
export function writeTags(w: ByteWriter, tags: readonly TagInfo[]): Uint8Array {
  head(w, MsgS.Tags);
  const skip = Math.max(0, tags.length - MAX_TAGS);
  const n = Math.min(tags.length, MAX_TAGS);
  w.u8v(n);
  for (let i = skip; i < tags.length; i++) {
    const t = tags[i];
    if (t === undefined) continue;
    w.u16(t.id & 0xffff);
    w.u8v(t.team === 'B' ? OBJ_TEAM_B : OBJ_TEAM_A);
    w.i16(quantPos(t.x));
    w.i16(quantPos(t.y));
    w.i16(quantPos(t.z));
  }
  return w.bytes();
}

/**
 * Search & Destroy's bomb (M11 Gate B, §6.8).
 *
 * The fuse travels as hundredths of a second in a `uint16` — 655 s of range against a 45 s
 * timer, and a hundredth is finer than the one-decimal HUD readout. It is **not** sent as a
 * tick count: the client would have to hold the tick rate and the round's start tick to read
 * it, which is three facts where one will do.
 */
export function writeBomb(w: ByteWriter, info: BombInfo): Uint8Array {
  head(w, MsgS.Bomb);
  w.u8v(bombStateCode(info.state));
  w.i16(info.carrierId);
  w.u8v(info.attackers === 'B' ? OBJ_TEAM_B : OBJ_TEAM_A);
  w.i16(quantPos(info.x));
  w.i16(quantPos(info.y));
  w.i16(quantPos(info.z));
  w.u16(Math.max(0, Math.min(0xffff, Math.round(info.secondsLeft * 100))));
  w.u8v(Math.max(0, Math.min(255, Math.round(info.interactFraction * 255))));
  w.i16(info.interactEntity);
  w.i8(info.plantedSiteIndex);
  return w.bytes();
}

/**
 * Exported so the §7 hash encodes a bomb state the same way the wire does.
 *
 * Two spellings of "PLANTED is 1" is two places to get it wrong, and the resulting mismatch
 * would look like a replication bug rather than a comparator bug.
 */
export function bombStateCode(state: BombInfo['state']): number {
  if (state === 'PLANTED') return BOMB_PLANTED;
  if (state === 'DEFUSED') return BOMB_DEFUSED;
  if (state === 'EXPLODED') return BOMB_EXPLODED;
  return BOMB_CARRIED;
}

function bombStateFromCode(code: number): BombInfo['state'] {
  if (code === BOMB_PLANTED) return 'PLANTED';
  if (code === BOMB_DEFUSED) return 'DEFUSED';
  if (code === BOMB_EXPLODED) return 'EXPLODED';
  return 'CARRIED';
}

/**
 * "Spend this streak" (M11 Gate B, §8.22).
 *
 * The coordinates are the mortar's marked point and are meaningless for the other five, which
 * are placed at the player's own body. Sent anyway rather than conditionally, because five bytes
 * saved on a message a player sends at most three times a match is not worth a variable layout.
 */
export function writeStreakRequest(w: ByteWriter, kind: number, x: number, z: number): Uint8Array {
  head(w, MsgC.Streak);
  w.u8v(kind & 0xff);
  w.i16(quantPos(x));
  w.i16(quantPos(z));
  return w.bytes();
}

/**
 * "I typed this cheat code" (playtest round 4, F14).
 *
 * The text, not a parsed id — see `MsgC.Cheat` for why the decision stays the server's. Refused
 * as malformed above `CHEAT_CODE_MAX` rather than truncated and compared: a code that arrives
 * cut short would be answered *"unknown code"*, which is a lie about a frame that was too long
 * rather than about a code that does not exist.
 */
export function writeCheatRequest(w: ByteWriter, code: string): Uint8Array {
  head(w, MsgC.Cheat);
  w.str(code.slice(0, CHEAT_CODE_MAX));
  return w.bytes();
}

/** What the server decided about a code, and this seat's whole mask afterwards (F14). */
export function writeCheats(w: ByteWriter, outcome: number, mask: number): Uint8Array {
  head(w, MsgS.Cheats);
  w.u8v(outcome & 0xff);
  w.u8v(mask & 0xff);
  return w.bytes();
}

/**
 * Everything one recipient is told about streaks (M11 Gate B, §6.8, §8.22).
 *
 * Encoded per seat, which is what makes the two private sections private — see `MsgS.Streaks`
 * and `StreakView`. The entity list is the same for everybody and simply rides along.
 */
export function writeStreaks(w: ByteWriter, view: StreakView): Uint8Array {
  head(w, MsgS.Streaks);

  // Four bytes per offer rather than one per held streak (round 4, B9 and the pivot). A price
  // list is bigger than an inventory and has to be: a client cannot decide what a key does, or
  // say why it did nothing, from a list of what it is allowed to press.
  const offers = Math.min(view.offers.length, MAX_STREAK_OFFERS);
  w.u8v(offers);
  for (let i = 0; i < offers; i++) {
    const o = view.offers[i];
    if (o === undefined) continue;
    w.u8v(o.kind & 0xff);
    w.u8v(Math.max(0, Math.min(255, o.price)));
    // Centiseconds in sixteen bits: the longest lockout in the table is a sentry's ninety
    // seconds plus the cooldown, which is 12000 and well inside it. Hundredths rather than
    // tenths because the fill is drawn every frame and a tenth of a second is a visible step.
    w.u16(Math.max(0, Math.min(0xffff, Math.round(o.lockoutCs))));
  }

  w.u8v(Math.max(0, Math.min(255, view.balance)));
  w.i8(view.nextKind);
  w.u8v(Math.max(0, Math.min(255, view.nextPrice)));
  // Sweep as a quantised angle with a sentinel: -1 means "your team has no UAV up", which is a
  // different statement from "the beam is at zero" and the minimap draws them differently.
  w.u8v(view.scrambled ? 1 : 0);
  w.u8v(view.sweepAngle < 0 ? 0 : 1);
  w.u16(view.sweepAngle < 0 ? 0 : quantAngle(view.sweepAngle));

  const contacts = Math.min(view.contacts.length, MAX_UAV_CONTACTS);
  w.u8v(contacts);
  for (let i = 0; i < contacts; i++) {
    const c = view.contacts[i];
    if (c === undefined) continue;
    w.i16(c.entityId);
    w.i16(quantPos(c.x));
    w.i16(quantPos(c.z));
    w.u16(Math.max(0, Math.min(0xffff, c.ageCs)));
  }

  const entities = Math.min(view.entities.length, MAX_STREAK_ENTITIES);
  w.u8v(entities);
  for (let i = 0; i < entities; i++) {
    const e = view.entities[i];
    if (e === undefined) continue;
    w.u16(e.instanceId & 0xffff);
    w.u8v(e.kind & 0xff);
    w.i16(e.ownerId);
    w.u8v(e.team & 0x03);
    w.i16(quantPos(e.x));
    w.i16(quantPos(e.y));
    w.i16(quantPos(e.z));
    w.u16(quantAngle(e.yaw));
    w.i16(quantPitch(e.pitch));
    w.u8v(Math.max(0, Math.min(255, e.health)));
    w.u8v(Math.max(0, Math.min(255, e.fraction)));
    w.u8v(e.flags & 0xff);
  }
  return w.bytes();
}

/**
 * Grenades in flight and smoke on the ground (M11 Gate B, §6.8, §8.24).
 *
 * Positions to the centimetre like everything else in this file. A grenade is small and fast,
 * and 1 cm is well inside the radius of the mesh drawn at it — the visible error in a replicated
 * arc comes from the snapshot rate, not from the quantisation, and interpolating between two
 * 1 cm samples is exactly as smooth as interpolating between two exact ones.
 */
export function writeProjectiles(
  w: ByteWriter,
  projectiles: readonly ProjectileState[],
  smoke: readonly SmokeState[],
): Uint8Array {
  head(w, MsgS.Projectiles);
  const n = Math.min(projectiles.length, MAX_PROJECTILES);
  w.u8v(n);
  for (let i = 0; i < n; i++) {
    const p = projectiles[i];
    if (p === undefined) continue;
    w.u16(p.serial & 0xffff);
    w.u8v(p.kind & 0xff);
    w.i16(p.ownerId);
    w.i16(quantPos(p.x));
    w.i16(quantPos(p.y));
    w.i16(quantPos(p.z));
    w.u16(quantAngle(p.yaw));
    w.u8v(p.flags & 0xff);
  }

  const m = Math.min(smoke.length, MAX_SMOKE);
  w.u8v(m);
  for (let i = 0; i < m; i++) {
    const s = smoke[i];
    if (s === undefined) continue;
    w.i16(quantPos(s.x));
    w.i16(quantPos(s.y));
    w.i16(quantPos(s.z));
    // Radius in decimetres: a cloud is metres across and a centimetre of radius is not a thing
    // anybody can see, where a byte per cloud is a thing the bandwidth budget can.
    w.u8v(Math.max(0, Math.min(255, Math.round(s.radius * 10))));
    w.u16(Math.max(0, Math.min(0xffff, s.remainingDs)));
  }
  return w.bytes();
}

/** The §7 mode-state hash, and the tick it describes. */
export function writeStateHash(w: ByteWriter, tick: number, hash: number): Uint8Array {
  head(w, MsgS.StateHash);
  w.i32(tick);
  w.u32(hash);
  return w.bytes();
}

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

/**
 * The owner block, flagged so a spectating or unspawned client can omit it entirely.
 *
 * The cheat mask is written **after** the optional state and unconditionally (playtest round 4,
 * F14). Unconditionally because the block is absent for a client with no body, and a player who
 * switches free-cam on while dead would otherwise not be told until they spawned; after, because
 * appending is the change that leaves every existing field where it was.
 *
 * One byte per snapshot per client, and it buys the property that matters: the entitlement is
 * replicated as **state**, so no single dropped frame can leave the two sides disagreeing about
 * whether a wall stops this player.
 */
export function writeSnapshotOwner(
  w: ByteWriter,
  owner: PlayerSimState | null,
  cheatMask: number,
): void {
  if (owner === null) {
    w.u8v(0);
  } else {
    w.u8v(1);
    writeOwnerState(w, owner);
  }
  w.u8v(cheatMask & 0xff);
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
  // Bit 0 is the tracer; the rest is the connected count, which `MAX_PELLETS` bounds at 16.
  w.u8v((e.tracer ? 1 : 0) | (e.pelletsHit << 1));
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
  // Health is 0-255 on the wire everywhere else in this protocol; see `EntitySnapshot.health`.
  w.u8v(Math.max(0, Math.min(255, Math.round(e.killerHealth))));
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
  /**
   * The master tick the summary hold expires on, and everybody is migrated back (§6.9).
   *
   * A **deadline**, not a duration, and that is the whole of the playtest round 4 fix for B4.
   * A duration is only true at the instant it is sent: a client that entered the screen late,
   * or reconnected into it, or simply read the message a frame after the one that put the
   * screen up, would count from a number that was never about its own clock. The same shape as
   * `VoteInfo.phaseEndsTick`, derived the same way — `(endsTick - currentTick) * DT` against
   * the synced server clock — so the summary and the ballot cannot disagree about what a
   * countdown is.
   */
  readonly endsTick: number;
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
  | {
      kind: 'hello';
      version: number;
      name: string;
      loadout: NetLoadout | null;
      /** What this connection claims about a seat it held before (round 4, F8). */
      reconnectToken: Uint8Array | null;
    }
  | { kind: 'commands'; count: number; snapshotAck: number }
  | { kind: 'ping'; id: number; clientMs: number }
  | { kind: 'bye'; reason: string }
  | ({ kind: 'welcome'; version: number; reconnectToken: Uint8Array | null } & WelcomeInfo)
  | { kind: 'reject'; code: number }
  | { kind: 'pong'; id: number; clientMs: number; serverMs: number; serverTick: number }
  | { kind: 'snapshot' }
  | { kind: 'events'; count: number }
  | { kind: 'loadout'; loadout: NetLoadout }
  | { kind: 'vote'; phase: number; option: number }
  | { kind: 'ready'; matchId: number }
  | ({ kind: 'migrate'; version: number; reconnectToken: Uint8Array | null } & WelcomeInfo)
  | ({ kind: 'voteState' } & VoteInfo)
  | { kind: 'prepare'; matchId: number; mapId: string; modeId: string }
  | ({ kind: 'summary' } & SummaryInfo)
  | { kind: 'notice'; text: string }
  | { kind: 'objectives'; states: readonly ObjectiveState[] }
  | { kind: 'tags'; tags: readonly TagInfo[] }
  | { kind: 'streaks'; view: StreakView }
  | { kind: 'stateHash'; tick: number; hash: number }
  | {
      kind: 'projectiles';
      projectiles: readonly ProjectileState[];
      smoke: readonly SmokeState[];
    }
  | { kind: 'streakRequest'; streakKind: number; x: number; z: number }
  | { kind: 'cheatRequest'; code: string }
  | { kind: 'cheats'; outcome: number; mask: number }
  | { kind: 'bomb'; bomb: BombInfo }
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
      // Same explicit presence byte as the loadout above, and never "read if bytes remain":
      // a length inferred from what is left in the frame is a length an attacker chooses.
      const hasToken = r.u8v() === 1;
      const reconnectToken = hasToken ? r.raw(RECONNECT_TOKEN_BYTES) : null;
      return r.overran ? BAD : { kind: 'hello', version, name, loadout, reconnectToken };
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
    case MsgC.Streak: {
      const streakKind = r.u8v();
      const x = dequantPos(r.i16());
      const z = dequantPos(r.i16());
      return r.overran ? BAD : { kind: 'streakRequest', streakKind, x, z };
    }
    case MsgC.Cheat: {
      const code = r.str();
      // Length is meaning, not shape, so it is refused here rather than clamped: an over-long
      // code is a client this server does not recognise, and §4.16 answers that at the boundary.
      if (r.overran || code.length > CHEAT_CODE_MAX) return BAD;
      return { kind: 'cheatRequest', code };
    }
    case MsgS.Cheats: {
      const outcome = r.u8v();
      const mask = r.u8v();
      return r.overran ? BAD : { kind: 'cheats', outcome, mask };
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
      const endsTick = r.i32();
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
        endsTick,
        rows,
        xp,
      };
    }
    case MsgS.Notice: {
      const text = r.str();
      return r.overran ? BAD : { kind: 'notice', text };
    }
    case MsgS.Objectives: {
      const n = r.u8v();
      if (r.overran || n > MAX_OBJECTIVES) return BAD;
      const states: ObjectiveState[] = [];
      for (let i = 0; i < n; i++) {
        const packed = r.u8v();
        const progress = r.u8v();
        const countA = r.u8v();
        const countB = r.u8v();
        states.push({ owner: packed & 0x03, capturing: (packed >> 2) & 0x03, progress, countA, countB });
      }
      return r.overran ? BAD : { kind: 'objectives', states };
    }
    case MsgS.Tags: {
      const n = r.u8v();
      // A count past the cap is a malformed frame, not a big match. S4.16: drop it, never
      // allocate against a number a client controls.
      if (r.overran || n > MAX_TAGS) return BAD;
      const tags: TagInfo[] = [];
      for (let i = 0; i < n; i++) {
        const id = r.u16();
        const team = r.u8v() === OBJ_TEAM_B ? 'B' : 'A';
        const x = dequantPos(r.i16());
        const y = dequantPos(r.i16());
        const z = dequantPos(r.i16());
        tags.push({ id, team, x, y, z });
      }
      return r.overran ? BAD : { kind: 'tags', tags };
    }
    case MsgS.Bomb: {
      const state = bombStateFromCode(r.u8v());
      const carrierId = r.i16();
      const attackers = r.u8v() === OBJ_TEAM_B ? 'B' : 'A';
      const x = dequantPos(r.i16());
      const y = dequantPos(r.i16());
      const z = dequantPos(r.i16());
      const secondsLeft = r.u16() / 100;
      const interactFraction = r.u8v() / 255;
      const interactEntity = r.i16();
      const plantedSiteIndex = r.i8();
      return r.overran
        ? BAD
        : {
            kind: 'bomb',
            bomb: {
              state,
              carrierId,
              attackers,
              x,
              y,
              z,
              secondsLeft,
              interactFraction,
              interactEntity,
              plantedSiteIndex,
            },
          };
    }
    case MsgS.Streaks: {
      const offerCount = r.u8v();
      if (r.overran || offerCount > MAX_STREAK_OFFERS) return BAD;
      const offers: StreakOfferState[] = [];
      for (let i = 0; i < offerCount; i++) {
        const kind = r.u8v();
        const price = r.u8v();
        const lockoutCs = r.u16();
        offers.push({ kind, price, lockoutCs });
      }

      const balance = r.u8v();
      const nextKind = r.i8();
      const nextPrice = r.u8v();
      const scrambled = r.u8v() === 1;
      const hasSweep = r.u8v() === 1;
      const sweepRaw = r.u16();
      const sweepAngle = hasSweep ? dequantAngle(sweepRaw) : -1;

      const contactCount = r.u8v();
      // A count past the cap is a malformed frame. S4.16: never allocate against a number the
      // other end controls, even when the other end is meant to be the server.
      if (r.overran || contactCount > MAX_UAV_CONTACTS) return BAD;
      const contacts: UavContactState[] = [];
      for (let i = 0; i < contactCount; i++) {
        const entityId = r.i16();
        const x = dequantPos(r.i16());
        const z = dequantPos(r.i16());
        const ageCs = r.u16();
        contacts.push({ entityId, x, z, ageCs });
      }

      const entityCount = r.u8v();
      if (r.overran || entityCount > MAX_STREAK_ENTITIES) return BAD;
      const entities: StreakEntityState[] = [];
      for (let i = 0; i < entityCount; i++) {
        const instanceId = r.u16();
        const kindIndex = r.u8v();
        const ownerId = r.i16();
        const team = r.u8v();
        const x = dequantPos(r.i16());
        const y = dequantPos(r.i16());
        const z = dequantPos(r.i16());
        const yaw = dequantAngle(r.u16());
        const pitch = dequantPitch(r.i16());
        const health = r.u8v();
        const fraction = r.u8v();
        const flags = r.u8v();
        entities.push({
          instanceId,
          kind: kindIndex,
          ownerId,
          team,
          x,
          y,
          z,
          yaw,
          pitch,
          health,
          fraction,
          flags,
        });
      }

      return r.overran
        ? BAD
        : {
            kind: 'streaks',
            view: {
              offers,
              balance,
              nextKind,
              nextPrice,
              scrambled,
              sweepAngle,
              contacts,
              entities,
            },
          };
    }
    case MsgS.Projectiles: {
      const n = r.u8v();
      if (r.overran || n > MAX_PROJECTILES) return BAD;
      const projectiles: ProjectileState[] = [];
      for (let i = 0; i < n; i++) {
        const serial = r.u16();
        const kind = r.u8v();
        const ownerId = r.i16();
        const x = dequantPos(r.i16());
        const y = dequantPos(r.i16());
        const z = dequantPos(r.i16());
        const yaw = dequantAngle(r.u16());
        const flags = r.u8v();
        projectiles.push({ serial, kind, ownerId, x, y, z, yaw, flags });
      }

      const m = r.u8v();
      if (r.overran || m > MAX_SMOKE) return BAD;
      const smoke: SmokeState[] = [];
      for (let i = 0; i < m; i++) {
        const x = dequantPos(r.i16());
        const y = dequantPos(r.i16());
        const z = dequantPos(r.i16());
        const radius = r.u8v() / 10;
        const remainingDs = r.u16();
        smoke.push({ x, y, z, radius, remainingDs });
      }
      return r.overran ? BAD : { kind: 'projectiles', projectiles, smoke };
    }
    case MsgS.StateHash: {
      const tick = r.i32();
      const hash = r.u32();
      return r.overran ? BAD : { kind: 'stateHash', tick, hash };
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
        e.pelletsHit = bits >>> 1;
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
        e.killerHealth = r.u8v();
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
  pelletsHit: 0,
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
const killedScratch: KilledEvent = { targetId: 0, sourceId: 0, weaponIndex: 0, zone: 'torso', killerHealth: 0 };
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
