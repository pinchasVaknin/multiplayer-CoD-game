/**
 * The wire contract, defined once and compiled by both sides (M10, S6.1).
 *
 * S6.1 asks for the protocol to live in `shared/` *"so both sides compile against one
 * schema"*. That is the whole reason this file is here rather than duplicated: a field the
 * server writes and the client does not read is a type error at build time instead of a
 * misaligned byte at runtime, and a misaligned byte in a binary protocol does not produce a
 * small wrong number — it produces a player standing 200 m underground.
 *
 * ## Versioning
 *
 * `PROTOCOL_VERSION` is bumped by **any** change to a message layout. S6.1: *"Reject a version
 * mismatch loudly — silent skew produces bugs that look like physics bugs and cost days."*
 * The check is the first thing the handshake does, before a single gameplay byte is decoded.
 */

/**
 * Bump on any layout change to any message in this file.
 *
 * v9 (M11 Gate B, playtest round 4): `MsgS.Summary` carries the tick the hold **ends on**
 * instead of how many seconds it lasts.
 *
 * A duration is only true at the instant it is sent, and the summary screen's countdown was the
 * one place in the client still integrating a local `dt` against a server deadline. It is now
 * the same derivation the vote overlay has always used.
 *
 * v2: the snapshot header gained match phase, phase seconds and round (M10 playtest fix).
 * The HUD reads those off the client's own `MatchFlow`, which on a dedicated server never
 * ticks — so without them the banner and the clock showed their construction-time values for
 * the whole match.
 */
/**
 * v8 (M11 Gate B): `MsgS.StateHash` — the §7 divergence checker's wire.
 *
 * v7 (M11 Gate B): grenades cross the wire — `MsgS.Projectiles`.
 *
 * The server has thrown and detonated equipment since the previous commit and no client could
 * see any of it: a grenade from a bot or another player damaged people while being invisible.
 *
 * v6 (M11 Gate B): killstreaks cross the wire — `MsgC.Streak` and `MsgS.Streaks`.
 *
 * The server has run `StreakSystem` since the previous commit and no client could see or spend
 * anything it produced. `Streaks` is the protocol's first genuinely per-recipient message: earn
 * state is private to a player and UAV contacts are private to a team.
 *
 * v5 (M11 Gate B): the rest of the mode state — Kill Confirmed's tags and S&D's bomb.
 *
 * v4's objective channel fixed Domination and left the same hole open in two other modes, for
 * the same root cause: every one of these lives behind `MatchFlow.simulate`, which a networked
 * client does not run. Domination's flags were merely *stale*; a networked Kill Confirmed had
 * no tags on the floor at all and a networked S&D had a fuse that never counted.
 *
 * v4 (M11 Gate B): objective state replication.
 *
 * v3 (M11): the skirmish flow. Five new messages in each direction's id space, and `Welcome`
 * grew an instance id and a migration tick — a client that cannot tell which instance a
 * snapshot describes will apply a live match's world to its warmup arena.
 */
export const PROTOCOL_VERSION = 9;

/** Four bytes at the head of every frame. Cheap rejection of anything not ours. */
export const MAGIC = 0x4f50_5231; // 'OPR1'

/** Client -> server message ids. */
export const MsgC = {
  /** First frame on a new connection. Version, name, desired team. */
  Hello: 1,
  /** A batch of `InputCommand`s: the newest plus a few for redundancy against loss. */
  Commands: 2,
  /** Round-trip probe. Echoed by the server as `Pong` with its own tick and time. */
  Ping: 3,
  /** Voluntary disconnect. Lets the server free the seat without waiting for a timeout. */
  Bye: 4,
  /**
   * The player's class, as ids (M11, Tier 1 #20).
   *
   * The transport the handover said this fix needed and did not have. Sent once after the
   * handshake and again whenever the loadout editor is closed; the server resolves it with the
   * same shared `resolveLoadout` the client used, and applies it on the **next spawn** rather
   * than to the standing body (handover #20, rule 3).
   */
  Loadout: 5,
  /** A vote for the option at an index in the current phase's ballot (§4.20). */
  Vote: 6,
  /** "My background build for match N is finished" (§6.5). Answers `READY_WAIT`. */
  Ready: 7,
  /**
   * "Spend the streak I have earned" (M11 Gate B, §8.22).
   *
   * A **request**, not an instruction. §4.16 makes the client fully untrusted, so the server
   * checks that this player actually holds that streak before granting it — `activate` already
   * returns false for a streak nobody has earned, and that is the whole validation.
   *
   * Carries the mortar's marked coordinates, which are the one piece of activation state the
   * client legitimately chooses: the player picks a point on the map overlay before spending it.
   * Every other streak ignores them and is placed at the player's own body.
   */
  Streak: 8,
} as const;

/** Server -> client message ids. */
export const MsgS = {
  /** Handshake accepted: your entity id, the map, the mode, the server's tick and time. */
  Welcome: 128,
  /** Handshake refused. Carries a `RejectCode` and never a stack trace (S4.16). */
  Reject: 129,
  /** World state. Full when `baseline === 0`, otherwise a delta against that snapshot id. */
  Snapshot: 130,
  /** Reply to `Ping`, carrying the server's clock and tick for the sync estimator. */
  Pong: 131,
  /** Gameplay events that drive client presentation — hits, kills, shots by other players. */
  Events: 132,
  /** The server is closing this connection, with a reason. */
  Bye: 133,
  /**
   * You are now in a different instance, from a named tick (M11, §4.18).
   *
   * Carries everything `Welcome` does — the entity id is reassigned by the new instance and
   * the map may be different — plus the instance id and the tick the move takes effect on. The
   * client's obligations on receipt are not optional: flush unacked commands, discard the
   * prediction ring, resync the clock offset and clear the interpolation buffer. Carrying any
   * of that across produces corrections that look exactly like netcode bugs.
   */
  Migrate: 134,
  /** The vote cycle's state, broadcast at a low rate. The client never counts votes (§4.20). */
  Vote: 135,
  /** "Start building this map now" — the background build's starting gun (§6.5). */
  Prepare: 136,
  /** End-of-match stats and the XP breakdown, delivered **before** teardown (§6.9). */
  Summary: 137,
  /** A short line for the player: allocation failed, migration failed, the arena was rebuilt. */
  Notice: 138,
  /**
   * Objective state — Domination flags, S&D sites (M11 Gate B, §6.8).
   *
   * Sent on every snapshot tick alongside the world state rather than inside it: the snapshot
   * is delta-encoded against a per-client baseline and objectives change on their own schedule,
   * so folding them in would either break the delta or force a full snapshot whenever a flag
   * ticked. Small enough at four bytes a zone that a separate frame is cheaper than either.
   */
  Objectives: 139,
  /**
   * Kill Confirmed's dog tags (M11 Gate B, §6.8).
   *
   * Separate from `Objectives` because the two are different *kinds* of state: a zone list is
   * fixed at construction and indexed positionally, and a tag list appears, shrinks and is
   * keyed by id. Folding them into one message would mean a length prefix per section and a
   * mode-dependent reader, for two modes that never both have both.
   */
  Tags: 140,
  /**
   * Search & Destroy's bomb — carrier, fuse and plant/defuse progress (M11 Gate B, §6.8).
   *
   * §6.8 requires the fuse to be server-authoritative because *"a client-side timer will drift
   * and will decide a round wrongly"*. On a networked client it does not drift, it stops: the
   * countdown runs from `onTick`, and a networked client does not simulate `MatchFlow`.
   */
  Bomb: 141,
  /**
   * Killstreaks — live entities, plus this recipient's own earn state and intel (§6.8, §8.22).
   *
   * The one message in the protocol that is genuinely **per recipient rather than broadcast**,
   * and it has to be: what you have earned is yours, and a UAV's contacts belong to the team
   * that called it in. Sending everyone everything and filtering in the client would put a UAV's
   * entire value inside the untrusted half of the system (§4.16).
   */
  Streaks: 142,
  /**
   * Grenades in flight and smoke on the ground (M11 Gate B, §6.8, §8.24).
   *
   * Broadcast rather than per recipient — a grenade is a physical object with no secrets, and
   * unlike a UAV's contacts there is nothing about it one team may know and the other may not.
   * The *consumption* differs per client, though, and that is the client's own business: your
   * own grenade in this list is a correction to something you predicted, and everybody else's
   * is the only copy you have.
   */
  Projectiles: 143,
  /**
   * A hash of this tick's mode state, for the §7 divergence checker.
   *
   * Sent **last** in the tick's send order, after every channel that describes mode state, so a
   * client has applied all of tick N before being asked what it thinks tick N looked like. Sent
   * any earlier it would compare against a client holding tick N-1 and cry wolf on every sample.
   */
  StateHash: 144,
} as const;

export type MsgCId = (typeof MsgC)[keyof typeof MsgC];
export type MsgSId = (typeof MsgS)[keyof typeof MsgS];

/**
 * Why a handshake was refused.
 *
 * A code, not a string, and deliberately coarse. S4.16 forbids returning internals to a
 * client; "the server is full" is all a rejected connection is entitled to know.
 */
export const RejectCode = {
  BadVersion: 1,
  ServerFull: 2,
  Malformed: 3,
  RateLimited: 4,
  MatchOver: 5,
} as const;
export type RejectCodeId = (typeof RejectCode)[keyof typeof RejectCode];

export function rejectText(code: number): string {
  switch (code) {
    case RejectCode.BadVersion:
      return 'protocol version mismatch';
    case RejectCode.ServerFull:
      return 'server full';
    case RejectCode.Malformed:
      return 'malformed handshake';
    case RejectCode.RateLimited:
      return 'rate limited';
    case RejectCode.MatchOver:
      return 'match is over';
    default:
      return 'refused';
  }
}

// -- limits (S4.16) ----------------------------------------------------------
//
// Every one of these is a cap on something a hostile client controls. They are here rather
// than at the call site so the whole attack surface can be read in one place.

/** Largest frame the server will accept. Anything bigger drops the connection unread. */
export const MAX_CLIENT_FRAME_BYTES = 1024;

/** Largest frame the server will produce. Sized for a full snapshot of 18 entities. */
export const MAX_SERVER_FRAME_BYTES = 8192;

/** Messages per second per connection before the connection is dropped. */
export const MAX_MESSAGES_PER_SEC = 240;

/**
 * Largest batch the server will decode. A protocol ceiling, not the client's send size.
 */
export const MAX_COMMANDS_PER_BATCH = 16;

/**
 * How many commands a client actually sends each tick: the newest plus three older ones.
 *
 * Sized from what it has to survive. Four consecutive dropped frames is 67 ms of total
 * blackout; at the 2% loss S7 asks us to test under, the chance of that is about one in six
 * million, and any link losing four in a row has problems this cannot paper over.
 *
 * It started at sixteen, which was measured and found to be waste: at 13 bytes a command and
 * 60 batches a second that is **17.4 KB/s upstream against 4.8 KB/s down** — a client
 * uploading three and a half times what it downloads, to guard against a burst of loss that
 * would disconnect it anyway. Four brings upstream to roughly 5 KB/s and loses nothing
 * measurable.
 */
export const COMMAND_REDUNDANCY = 4;

/** Simultaneous connections from one IP. */
export const MAX_CONNECTIONS_PER_IP = 4;

/** Players in a match (S4.9: one match instance, 10 connected clients). */
export const MAX_PLAYERS = 10;

/** How long a connection may go silent before it is assumed dead, ms. */
export const CLIENT_TIMEOUT_MS = 10_000;

/** How long a connection has to complete its handshake before it is dropped, ms. */
export const HANDSHAKE_TIMEOUT_MS = 5_000;

/**
 * How far from the server's current tick a command may claim to be, in ticks.
 *
 * Generous enough for a 500 ms link plus a jitter buffer, tight enough that a client cannot
 * claim to be simulating a minute in the future and have its commands parked in a buffer.
 */
export const MAX_TICK_SKEW = 120;

/**
 * Lag compensation cap, ms (S4.13).
 *
 * Shared rather than server-only because both sides reason about it: the server clamps to it,
 * and the client's rewind panel has to show whether a given player's link is past it. A
 * client displaying a different cap from the one being enforced would be a read-out that lies
 * in exactly the situation it exists for.
 */
export const MAX_REWIND_MS = 200;

// -- quantisation (S4.12) ----------------------------------------------------

/**
 * Positions to the centimetre, as `int16`.
 *
 * S4.12 asks for *"~1 cm"*. `int16` at 1 cm covers +/-327.67 m; the largest map is 72 m
 * across, so the range is not a constraint and the two bytes are.
 */
export const POS_SCALE = 100;

/** Velocities to the centimetre per second, as `int16`. +/-327 m/s covers any fall. */
export const VEL_SCALE = 100;

/** Angles to 16 bits over a full turn: 2*pi/65536 = 0.0055 deg, far below aim resolution. */
const ANGLE_SCALE = 65536 / (Math.PI * 2);

export function quantPos(v: number): number {
  return Math.round(v * POS_SCALE);
}

export function dequantPos(v: number): number {
  return v / POS_SCALE;
}

export function quantVel(v: number): number {
  return Math.round(v * VEL_SCALE);
}

export function dequantVel(v: number): number {
  return v / VEL_SCALE;
}

/** Radians -> `uint16`. Wraps, so no clamping is needed and no angle is unrepresentable. */
export function quantAngle(rad: number): number {
  return Math.round(rad * ANGLE_SCALE) & 0xffff;
}

export function dequantAngle(q: number): number {
  // Back to (-pi, pi], which is the range every consumer of yaw in this codebase expects.
  const a = (q & 0xffff) / ANGLE_SCALE;
  return a > Math.PI ? a - Math.PI * 2 : a;
}

/**
 * Pitch is clamped to +/-89 deg by `InputCommand` (S4.2), so it gets a narrower, finer mapping
 * than yaw rather than sharing the wrapping one: half the range at the same bit count is half
 * the quantisation error on the axis where a headshot lives.
 */
const PITCH_LIMIT = (89 * Math.PI) / 180;
const PITCH_SCALE = 32767 / PITCH_LIMIT;

export function quantPitch(rad: number): number {
  const c = rad < -PITCH_LIMIT ? -PITCH_LIMIT : rad > PITCH_LIMIT ? PITCH_LIMIT : rad;
  return Math.round(c * PITCH_SCALE);
}

export function dequantPitch(q: number): number {
  return q / PITCH_SCALE;
}

/**
 * Move axes travel as a signed byte: -1..1 in 1/127 steps.
 *
 * Exposed as its own pair rather than inlined at the two call sites, because prediction has
 * to apply the identical rounding — see `quantiseCommandInPlace`.
 */
export function quantMove(v: number): number {
  const r = Math.round(v * 127);
  return r < -127 ? -127 : r > 127 ? 127 : r;
}

export function dequantMove(q: number): number {
  return q / 127;
}

/**
 * Round a command's fields to exactly what the wire will carry.
 *
 * **The client must predict with this, not with what it sampled.** This was a real and
 * genuinely subtle bug, and it is the last thing standing between a working prediction and
 * S8.4's "zero mispredictions".
 *
 * A command is quantised on the way out: yaw to 16 bits, pitch to 16, the move axes to a byte
 * each. The server therefore simulates `dequant(quant(x))`, while a client that predicted
 * with its raw sampled `x` simulated something very slightly different. The error per tick is
 * around 1e-5 m — far too small to see, and far too small to trip any sane epsilon on its own.
 *
 * But it does not cancel. A player turning steadily accumulates the same-signed yaw error
 * every tick, and the positional divergence grows without bound between corrections. Measured
 * with a client turning at 0.004 rad/tick: p50 misprediction of **14 cm** at zero added
 * latency, on a link with no loss and no jitter, with the count refusing to fall below a few
 * dozen per run no matter what else was fixed.
 *
 * Quantising at sample time makes client and server simulate byte-identical commands, which
 * is the only version of "the same command" that means anything across a wire.
 */
export function quantiseCommandInPlace(cmd: {
  moveX: number;
  moveZ: number;
  yaw: number;
  pitch: number;
}): void {
  cmd.moveX = dequantMove(quantMove(cmd.moveX));
  cmd.moveZ = dequantMove(quantMove(cmd.moveZ));
  cmd.yaw = dequantAngle(quantAngle(cmd.yaw));
  cmd.pitch = dequantPitch(quantPitch(cmd.pitch));
}
