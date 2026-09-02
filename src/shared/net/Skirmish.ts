import { EQUIPMENT_DEFS, type EquipmentId } from '../equipment/EquipmentDefs';
import { CAMOS, type CamoId } from '../meta/Camos';
import { FIELD_UPGRADES, type FieldUpgradeId } from '../meta/FieldUpgrades';
import type { LoadoutSlot, WeaponLoadout } from '../meta/Loadouts';
import type { GameModeId } from '../modes/GameMode';
import { MAPS, MODES } from '../modes/ModeRegistry';
import { PERK_IDS as ALL_PERK_IDS, type PerkId } from '../perks/PerkDefs';
import { STREAK_DEFS, type StreakId } from '../streaks/StreakDefs';
import { ATTACHMENTS, type AttachmentId } from '../weapons/Attachments';
import { WEAPON_DEFS } from '../weapons/WeaponDefs';

/**
 * The skirmish flow's vocabulary, shared by both runtimes (M11, §3).
 *
 * Everything here is either a number both sides must agree on or a shape both sides must
 * decode. S3: *"Config is shared and singular. The client must never hold its own copy of a
 * gameplay number — that is how client and server drift apart in ways that look like netcode
 * bugs."* The vote durations are the sharpest case: the client renders a countdown from them
 * and the server decides phase boundaries from them, and two copies would produce a client
 * that votes into a window the server has already closed.
 */

/** Which instance a message belongs to. 0 is the permanent warmup arena. */
export type MatchId = number;

/** The warmup arena's id. Fixed, because it is created at boot and never destroyed. */
export const WARMUP_MATCH_ID: MatchId = 0;

/**
 * Instance lifecycle (§4.18).
 *
 * `WarmupMatch` only ever occupies `BOOTING` and `RUNNING`; there is no path from it to
 * `DESTROYED`. `LiveMatch` walks the whole list in order.
 */
export const InstanceState = {
  BOOTING: 0,
  ALLOCATING: 1,
  LOADING: 2,
  READY_WAIT: 3,
  RUNNING: 4,
  ENDED: 5,
  DESTROYED: 6,
  /** Reached only by an instance whose step threw (§4.18). Its players go back to warmup. */
  FAILED: 7,
} as const;
export type InstanceStateId = (typeof InstanceState)[keyof typeof InstanceState];

export function instanceStateName(state: number): string {
  for (const [name, value] of Object.entries(InstanceState)) {
    if (value === state) return name;
  }
  return 'UNKNOWN';
}

// -- the vote cycle (§4.20, §6.4) --------------------------------------------

/**
 * The phases of the 60 s cycle.
 *
 * `IDLE` is not in the brief's table and is required by §4.20's last rule: *"If every human
 * leaves during a vote phase, the cycle cancels and the arena returns to idle warmup."* An
 * arena with nobody in it is not in a phase of a countdown, and modelling it as `PLAY` would
 * mean a vote opening for zero people every forty seconds forever.
 */
export const VotePhase = {
  IDLE: 0,
  PLAY: 1,
  MODE_VOTE: 2,
  MAP_VOTE: 3,
  /** The map is decided and the instance is being allocated. Voting is closed. */
  ALLOCATING: 4,
} as const;
export type VotePhaseId = (typeof VotePhase)[keyof typeof VotePhase];

export function votePhaseName(phase: number): string {
  for (const [name, value] of Object.entries(VotePhase)) {
    if (value === phase) return name;
  }
  return 'UNKNOWN';
}

/**
 * Did the map ballot just *appear* (playtest round 4, F13)?
 *
 * The vote state is broadcast at 4 Hz, and the whole of F13's trap is that an effect hung off
 * a periodic broadcast fires at the broadcast rate: a sound played on receipt of `MAP_VOTE`
 * plays forty times over a ten-second ballot. The general form of the fix is to hold the
 * previous phase and act only on the change, and this is that rule as a pure function so the
 * *rate* can be measured headlessly — the sound itself is a browser claim, the edge is not.
 *
 * Deliberately the **map** ballot and not either ballot. F13 asks for a cue when the map choice
 * appears, and the cycle reaches `MAP_VOTE` exactly once, which is what makes "one sound per
 * cycle" a fact about the phase machine rather than a debounce interval somebody tuned.
 *
 * `previous` is whatever phase this client last heard, or `IDLE` for a client that has heard
 * nothing. That is not a special case: a client which has just migrated back into the arena
 * mid-ballot has genuinely just had the ballot appear in front of it, and should be told.
 */
export function mapBallotOpened(previous: number, next: number): boolean {
  return next === VotePhase.MAP_VOTE && previous !== VotePhase.MAP_VOTE;
}

export interface VoteCycleConfig {
  /** Free warmup play before the ballot opens, seconds. */
  readonly playSeconds: number;
  readonly modeVoteSeconds: number;
  readonly mapVoteSeconds: number;
}

/**
 * §4.20's table, verbatim, and the only copy of it.
 *
 * The client derives its countdown from the *server's* phase-end tick rather than from these
 * numbers (§4.20: *"the client renders a countdown derived from the synced server clock and
 * never runs its own timer"*), so they exist here for the server's phase machine and for a
 * client that wants to draw a progress bar of the right total width.
 */
export const VOTE_CYCLE_CONFIG: VoteCycleConfig = {
  playSeconds: 40,
  modeVoteSeconds: 10,
  mapVoteSeconds: 10,
};

/** Total cycle length, seconds. 60 by construction rather than by assertion. */
export function voteCycleSeconds(cfg: VoteCycleConfig = VOTE_CYCLE_CONFIG): number {
  return cfg.playSeconds + cfg.modeVoteSeconds + cfg.mapVoteSeconds;
}

/**
 * What can be voted for, in a fixed wire order.
 *
 * Standing lesson 8 from the handover: *"Ids on the wire, not resolved numbers. A def-table
 * reorder must not silently change what a byte means. Net modules should declare their own
 * wire-order tables."* So the ballot's order is declared here rather than being whatever order
 * `MODES` happens to be in — reordering the menu must not change what vote index 2 means.
 */
export const MODE_BALLOT: readonly GameModeId[] = ['TDM', 'DOM', 'KC', 'FFA', 'SND'];

/** The three real maps. The greybox room is the arena you vote *from*, never a destination. */
export const MAP_BALLOT: readonly string[] = ['mp_foundry', 'mp_dunes', 'mp_depot'];

export interface VoteTallyEntry {
  /** Index into `MODE_BALLOT` or `MAP_BALLOT` for the current phase. */
  readonly option: number;
  readonly count: number;
}

export interface VoteView {
  readonly phase: VotePhaseId;
  /** Server tick the current phase ends on. The client's countdown is derived from this. */
  readonly phaseEndsTick: number;
  readonly tally: readonly VoteTallyEntry[];
  /** This client's own vote for the current phase, or -1. */
  readonly selfVote: number;
  /** The winning mode once the mode vote has resolved, else -1. Stays set through MAP_VOTE. */
  readonly decidedMode: number;
  readonly decidedMap: number;
  /** Humans connected to the arena. Zero cancels the cycle (§4.20). */
  readonly humans: number;
}

// -- objective state (M11 Gate B, §6.8) ---------------------------------------

/**
 * One objective's replicated state.
 *
 * §6.8: *"The instance owns every piece of mode state; clients render what they are told and
 * hold no authoritative timers."* Domination's flags are the sharpest case — the server was
 * already capturing them correctly and the client was rendering its own, permanently neutral,
 * copy, because a networked client's `Domination` has an empty roster and its `onTick` counts
 * nobody. A player stood on a flag, watched nothing happen, and reported that capture was
 * broken. It was not; it was invisible.
 *
 * Ordered by the mode's own zone list rather than keyed by id, so a zone costs four bytes
 * instead of four plus a string. The list is fixed at match construction on both sides — it
 * comes from `MapDef.objectives` — so index *is* identity here.
 */
export interface ObjectiveState {
  /** 0 = neutral, 1 = team A, 2 = team B. */
  readonly owner: number;
  /** Capture progress 0..255, belonging to `capturing`. */
  readonly progress: number;
  readonly capturing: number;
  readonly countA: number;
  readonly countB: number;
}

/** Owner codes on the wire. `BotTeam` is a string and this is two bits. */
export const OBJ_NEUTRAL = 0;
export const OBJ_TEAM_A = 1;
export const OBJ_TEAM_B = 2;

export function ownerCode(owner: string): number {
  if (owner === 'A') return OBJ_TEAM_A;
  if (owner === 'B') return OBJ_TEAM_B;
  return OBJ_NEUTRAL;
}

export function ownerFromCode(code: number): 'A' | 'B' | 'NONE' {
  if (code === OBJ_TEAM_A) return 'A';
  if (code === OBJ_TEAM_B) return 'B';
  return 'NONE';
}

/** Most objectives a map authors. Three flags or two bomb sites; eight is headroom. */
export const MAX_OBJECTIVES = 8;

// -- dog tags (M11 Gate B, §6.8) ----------------------------------------------

/**
 * One dog tag lying on the floor.
 *
 * The same failure as the Domination flags, one step further along. `KillConfirmed.onKill`
 * drops tags and `onTick` expires and collects them, and **both** are driven by `MatchFlow`,
 * which a networked client does not simulate. So a networked client's tag list is not stale —
 * it is permanently *empty*. Nothing is dropped, nothing is collected, and the mode whose whole
 * premise is picking things up off the floor has nothing on the floor at all.
 *
 * Keyed by id rather than ordered by index, because unlike zones the list is not fixed: tags
 * appear on deaths and vanish on pickup or expiry. `MatchObjectives.updateTags` already pools
 * its meshes by `tag.id`, so replicating the id keeps a tag's mesh attached to the same tag
 * across frames instead of making them swap places whenever one in the middle is collected.
 *
 * `life` is deliberately **not** on the wire. It decides when the server deletes a tag, and a
 * client that counted it down would be running exactly the authoritative timer §6.8 forbids —
 * a tag disappears when it stops being sent, which is one fact rather than two.
 */
export interface TagState {
  readonly id: number;
  /** The side that *died*: `OBJ_TEAM_A` or `OBJ_TEAM_B`. Enemy tags confirm, own tags deny. */
  readonly team: number;
  /** Centimetres, `quantPos`. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Tags carried in one frame.
 *
 * A tag lives 20 s and a busy Kill Confirmed match kills roughly once a second across a
 * ten-player roster, so twenty-odd tags is a plausible steady state and 32 is the headroom
 * over it. Beyond the cap the *oldest* are dropped from the frame rather than the newest —
 * see `writeTags` — because a tag about to expire matters less than one that just landed.
 */
export const MAX_TAGS = 32;

// -- the bomb (M11 Gate B, §6.8) ----------------------------------------------

/** Bomb states on the wire, in `BombState`'s own order. */
export const BOMB_CARRIED = 0;
export const BOMB_PLANTED = 1;
export const BOMB_DEFUSED = 2;
export const BOMB_EXPLODED = 3;

/**
 * Search & Destroy's bomb, entire.
 *
 * §6.8 is explicit that this one is not optional: *"round state, bomb timer and plant/defuse
 * progress are server-authoritative — a client-side timer will drift and will decide a round
 * wrongly."* The drift is not hypothetical here. `stepPlant` and `stepDefuse` run off
 * `MatchFlow`, so on a networked client the bomb timer is not slow, it is **stopped**: it holds
 * whatever value it was constructed with for the entire round.
 *
 * `interactFraction` and `interactEntity` travel together for the reason the zone counts do.
 * A plant is *interruptible*, and a client re-deriving "somebody is planting" from a position
 * 100 ms in the past would keep the ring on screen for two frames after the planter was shot.
 * The server says who is working and how far along they are; the client draws that and nothing
 * else.
 */
export interface BombReplica {
  /** One of the `BOMB_*` codes. */
  readonly state: number;
  /** Who is carrying it, or -1 while it lies on the ground. */
  readonly carrierId: number;
  /** Which side attacks this round, as an owner code. Flips on the side swap (§6.4). */
  readonly attackers: number;
  /** Where it lies when nobody carries it. Centimetres, `quantPos`. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Fuse remaining, in hundredths of a second. */
  readonly timerCs: number;
  /** Plant or defuse progress, 0..255. */
  readonly interactProgress: number;
  /** Who is planting or defusing, or -1. */
  readonly interactEntity: number;
  /** Index into the mode's site list once planted, or -1. */
  readonly plantedSite: number;
}

// -- killstreaks (M11 Gate B, §6.8, §8.22) ------------------------------------

/**
 * One live streak entity, as everybody sees it.
 *
 * §4.15 puts *"killstreak earn, activation, entity state"* on the replicated side. A sentry and
 * a care package are **physical objects both teams can see and shoot**, so this list is the same
 * for every recipient — it is the *intel* below that is filtered, not the bodies.
 *
 * One record shape for all six rather than a tagged union per kind. The fields a sentry does not
 * use cost it four bytes of zeroes, and the alternative is six encoders and six decoders that
 * can each drift from their counterpart. `kind` says how to read the two soft fields.
 */
export interface StreakEntityState {
  /** Unique per activation. Identity across frames, which the renderer's mesh pool needs. */
  readonly instanceId: number;
  /** Index into `STREAK_DEFS`. */
  readonly kind: number;
  readonly ownerId: number;
  /** `OBJ_TEAM_A` or `OBJ_TEAM_B`. */
  readonly team: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Body yaw — a sentry's turret, a chopper's heading, a UAV's sweep bearing. */
  readonly yaw: number;
  /** Turret or gunner pitch. Zero for the kinds with no elevation. */
  readonly pitch: number;
  /** A sentry's health, 0..255. `255` for every kind that cannot be shot down. */
  readonly health: number;
  /** A care package's claim progress, 0..255. Zero elsewhere. */
  readonly fraction: number;
  /** `SEFlag` bits. */
  readonly flags: number;
}

/** Bits in `StreakEntityState.flags`. */
export const SEFlag = {
  /** A care package that has touched the ground, or a sentry that is still alive. */
  Landed: 1 << 0,
  Alive: 1 << 1,
  /** Somebody is currently claiming this crate. */
  Claiming: 1 << 2,
} as const;

/**
 * One UAV contact — **intel, and the thing Ghost actually hides**.
 *
 * Two filters stand between an enemy position and an enemy client, and they are different:
 *
 * 1. **Ghost**, applied at record time inside `Uav.onTick`: a player whose `visibleToUav` is
 *    false is *never recorded as a contact at all*, so the perk is invisible to everything
 *    downstream. Note what this is not — the player's **body stays in the entity list**. Ghost
 *    hides you from UAV intel; it does not make you invisible, and an entity filter would.
 * 2. **Ownership**, applied at send time in `MatchInstance`: contacts go only to the team whose
 *    UAV recorded them. Broadcasting them and expecting the client to ignore the other team's
 *    would put the whole point of a UAV in the untrusted half of the system.
 */
export interface UavContactState {
  readonly entityId: number;
  readonly x: number;
  readonly z: number;
  /** Hundredths of a second since the beam crossed. Drives the minimap fade. */
  readonly ageCs: number;
}

/**
 * One streak this player has equipped, as the server prices and gates it (round 4, B9 + B10).
 *
 * Replaces the list of "earned and unspent kind indices" that used to be here. Under a balance
 * there is nothing to hold, so what a client needs is not an inventory but a **price list**:
 * what each of my three keys costs, and whether I have already spent that one this life. Both
 * facts are the server's — the price carries Hardline, and the used set is per life and per
 * entity — and a client that recomputed either would be the second authority §4.15 exists to
 * prevent.
 *
 * Keyed by `kind` rather than delivered in slot order. The server drops empty slots when it
 * resolves a class, so position here does not survive a class with a gap in it; the client
 * already knows its own three keys and looks each one up.
 */
export interface StreakOfferState {
  /** Index into `STREAK_DEFS`. */
  readonly kind: number;
  /** Kills it costs this player, already discounted by Hardline. */
  readonly price: number;
  /** Bought this life. B10: not available again until death. */
  readonly used: boolean;
}

/**
 * Everything one recipient is told about streaks this tick.
 *
 * Built per seat rather than broadcast, because three of its parts are private: what *you* can
 * afford, what *your* team's UAV can see, and whether *your* minimap is scrambled. The entity
 * list is common and is simply carried along with them.
 */
export interface StreakView {
  /** The class's streaks, priced and gated. Up to three. */
  readonly offers: readonly StreakOfferState[];
  /**
   * Kills banked and not yet spent (round 4, B9).
   *
   * Was `streakCount`, the consecutive-kill counter. The two are different numbers the moment
   * anything is bought, and it is the balance the HUD's progress line is measured against.
   */
  readonly balance: number;
  /** The cheapest streak this player cannot afford yet, or -1. */
  readonly nextKind: number;
  /** What it costs, already discounted by Hardline. */
  readonly nextPrice: number;
  /** An enemy Counter-UAV is up: this player's minimap is scrambled. */
  readonly scrambled: boolean;
  /** Sweep bearing of a friendly UAV, or -1 when this team has none. */
  readonly sweepAngle: number;
  readonly contacts: readonly UavContactState[];
  readonly entities: readonly StreakEntityState[];
}

/** Live streak entities in one frame. Two instances of six streaks is already unusual. */
export const MAX_STREAK_ENTITIES = 16;
/** Contacts a sweep can carry. One per roster slot, and the roster caps well below this. */
export const MAX_UAV_CONTACTS = 24;
/** Offers a player can be shown at once — three keys, three slots (M7 playtest). */
export const MAX_STREAK_OFFERS = 3;

// -- equipment in flight (M11 Gate B, §6.8, §8.24) ----------------------------

/**
 * One grenade in the air, or lying armed on the floor.
 *
 * §6.8: *"Grenades predicted by the thrower, authoritative on the instance, reconciled without
 * visible teleporting."* Both halves of that sentence are load-bearing, and they mean this list
 * is consumed differently depending on **who threw it**:
 *
 * - **Somebody else's** grenade is replicated state, drawn from these records exactly as a
 *   remote player's body is drawn from the snapshot. The client never simulated it and has
 *   nothing to reconcile.
 * - **Your own** is predicted. The client threw it on the tick it sent the command and has been
 *   integrating it locally ever since, so the authoritative record is a *correction*, not a
 *   source — and it is applied by blending rather than snapping, because a grenade that jumps is
 *   precisely the visible teleport the criterion forbids.
 *
 * `serial` is the pool's own, already unique per throw and already stable for a projectile's
 * whole life, so nothing had to be invented to key this by.
 */
export interface ProjectileState {
  readonly serial: number;
  /** Index into `EQUIPMENT_DEFS`. */
  readonly kind: number;
  readonly ownerId: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Spin, for the mesh. */
  readonly yaw: number;
  /** `PEFlag` bits. */
  readonly flags: number;
}

/** Bits in `ProjectileState.flags`. */
export const PEFlag = {
  /** Come to rest, rather than still bouncing. */
  Resting: 1 << 0,
  /** Armed — past its arming fuse, live. */
  Armed: 1 << 1,
  /** Stuck to a surface or a body (semtex). */
  Stuck: 1 << 2,
} as const;

/**
 * One smoke cloud.
 *
 * Replicated rather than left to the client's own `SmokeField`, for the reason §6.8 gives it a
 * sentence of its own: smoke **occludes bot line of sight on the server**, so where the cloud is
 * decides who can see whom. A client drawing a cloud in a slightly different place from the one
 * the server is testing against would be showing cover that does not exist.
 */
export interface SmokeState {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
  /** Seconds left, in tenths. Drives the fade and the bloom. */
  readonly remainingDs: number;
}

/** The projectile pool is 32; a frame carrying more than that is malformed. */
export const MAX_PROJECTILES = 32;
/** The smoke field is 8. */
export const MAX_SMOKE = 8;

// -- loadout on the wire (Tier 1 #20) ----------------------------------------

/**
 * A class, as ids (handover #20, rule 1).
 *
 * *"Send ids, not resolved numbers. Resolve server-side with the same shared `resolveLoadout`,
 * so a def-table reorder cannot silently change meaning."* Every field here is a string the
 * server looks up in the same registry the client looked it up in; nothing pre-computed
 * crosses the wire, so there is no way for the two sides to disagree about what a weapon *is*
 * while agreeing about what it is called.
 */
export interface NetWeaponLoadout {
  readonly weaponId: string;
  readonly attachments: readonly string[];
  readonly camo: string | null;
}

export interface NetLoadout {
  readonly name: string;
  readonly primary: NetWeaponLoadout;
  readonly secondary: NetWeaponLoadout;
  readonly lethal: string;
  readonly tactical: string;
  readonly perks: readonly (string | null)[];
  readonly fieldUpgrade: string;
  readonly streaks: readonly (string | null)[];
}

/** Caps, so a hostile client cannot make the server allocate on its say-so (S4.16). */
export const MAX_ATTACHMENTS_PER_WEAPON = 5;
/** Perk slots on a class: one per tier. Named for the slot count, not the tier list. */
export const PERK_SLOTS = 3;
export const STREAK_SLOTS = 3;

/**
 * A local `LoadoutSlot`, flattened to the ids that cross the wire (Tier 1 #20, rule 1).
 *
 * The inverse of `sanitiseNetLoadout`, and deliberately a plain projection: it copies ids and
 * computes nothing. *"Send ids, not resolved numbers. Resolve server-side with the same shared
 * `resolveLoadout`, so a def-table reorder cannot silently change meaning."*
 */
export function toNetLoadout(slot: LoadoutSlot): NetLoadout {
  return {
    name: slot.name,
    primary: {
      weaponId: slot.primary.weaponId,
      attachments: [...slot.primary.attachments],
      camo: slot.primary.camo,
    },
    secondary: {
      weaponId: slot.secondary.weaponId,
      attachments: [...slot.secondary.attachments],
      camo: slot.secondary.camo,
    },
    lethal: slot.lethal,
    tactical: slot.tactical,
    fieldUpgrade: slot.fieldUpgrade,
    perks: [...slot.perks],
    streaks: [...slot.streaks],
  };
}

/**
 * Validate a class at the boundary and **never throw** (handover #20, rule 2).
 *
 * Returns a `LoadoutSlot` built only from ids that are real, with anything unrecognised
 * dropped rather than rejected — a client one build behind should field a slightly different
 * class, not fail to join. `null` is returned only when the payload is structurally unusable,
 * and the caller's answer to that is the M10 default pair rather than a disconnect.
 *
 * ## What this deliberately cannot check
 *
 * **Unlocks.** The server has no profile and progression is client-side (§6.9), so a player
 * can field a weapon they have not earned. That is a known, recorded gap rather than a bug to
 * rediscover: it affects only the cosmetic question of which gun is in their hands, every gun
 * is balanced against every other, and the alternative is the server-side account database
 * §9 puts out of scope.
 */
export function sanitiseNetLoadout(raw: NetLoadout | null): LoadoutSlot | null {
  if (raw === null) return null;

  const primary = sanitiseWeapon(raw.primary);
  const secondary = sanitiseWeapon(raw.secondary);
  if (primary === null || secondary === null) return null;

  return {
    name: sanitiseText(raw.name, 24) || 'CUSTOM',
    primary,
    secondary,
    lethal: pick<EquipmentId>(raw.lethal, EQUIPMENT_IDS, 'frag'),
    tactical: pick<EquipmentId>(raw.tactical, EQUIPMENT_IDS, 'flashbang'),
    perks: fixedLength<PerkId>(raw.perks, PERK_SLOTS, LEGAL_PERK_IDS),
    fieldUpgrade: pick<FieldUpgradeId>(raw.fieldUpgrade, FIELD_UPGRADE_IDS, 'munitions'),
    streaks: fixedLength<StreakId>(raw.streaks, STREAK_SLOTS, STREAK_IDS),
  };
}

function sanitiseWeapon(raw: NetWeaponLoadout | null | undefined): WeaponLoadout | null {
  if (raw === null || raw === undefined) return null;
  const weaponId = typeof raw.weaponId === 'string' ? raw.weaponId : '';
  if (!WEAPON_IDS.has(weaponId)) return null;

  const attachments: AttachmentId[] = [];
  const source = Array.isArray(raw.attachments) ? raw.attachments : [];
  for (const id of source) {
    if (attachments.length >= MAX_ATTACHMENTS_PER_WEAPON) break;
    if (typeof id !== 'string' || !ATTACHMENT_IDS.has(id)) continue;
    // A duplicate attachment would stack its modifier twice on the server and once on the
    // client, which is #20's divergence arriving through a different door.
    if (attachments.includes(id as AttachmentId)) continue;
    attachments.push(id as AttachmentId);
  }

  const camo = typeof raw.camo === 'string' && CAMO_IDS.has(raw.camo) ? (raw.camo as CamoId) : null;
  return { weaponId, attachments, camo };
}

function fixedLength<T extends string>(
  raw: readonly (string | null)[] | undefined,
  length: number,
  legal: ReadonlySet<string>,
): Array<T | null> {
  const out: Array<T | null> = [];
  const source = Array.isArray(raw) ? raw : [];
  for (let i = 0; i < length; i++) {
    const value = source[i];
    out.push(typeof value === 'string' && legal.has(value) ? (value as T) : null);
  }
  return out;
}

function pick<T extends string>(raw: string, legal: ReadonlySet<string>, fallback: T): T {
  return typeof raw === 'string' && legal.has(raw) ? (raw as T) : fallback;
}

function sanitiseText(raw: string, cap: number): string {
  if (typeof raw !== 'string') return '';
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
    if (out.length >= cap) break;
  }
  return out.trim();
}

/**
 * Legal ids, read straight off the registries rather than listed again here.
 *
 * A second list would be a place for the validator to fall behind the game: a weapon added in
 * a later milestone and not added here would be silently unequippable over the network, and
 * the symptom — "my class works in solo and not online" — points nowhere near this file.
 */
const WEAPON_IDS: ReadonlySet<string> = new Set(Object.keys(WEAPON_DEFS));
const ATTACHMENT_IDS: ReadonlySet<string> = new Set(Object.keys(ATTACHMENTS));
const CAMO_IDS: ReadonlySet<string> = new Set(Object.keys(CAMOS));
const EQUIPMENT_IDS: ReadonlySet<string> = new Set(Object.keys(EQUIPMENT_DEFS));
const LEGAL_PERK_IDS: ReadonlySet<string> = new Set(ALL_PERK_IDS);
const STREAK_IDS: ReadonlySet<string> = new Set(STREAK_DEFS.map((s) => s.id));
const FIELD_UPGRADE_IDS: ReadonlySet<string> = new Set(Object.keys(FIELD_UPGRADES));

// -- ballots against the registry --------------------------------------------

/**
 * The ballots, checked against the registry at module load.
 *
 * A ballot naming a mode or map that does not exist would throw at the moment the vote
 * resolved — forty seconds into a cycle, in front of everybody. Better to refuse to start.
 */
for (const modeId of MODE_BALLOT) {
  if (!MODES.some((m) => m.id === modeId)) {
    throw new Error(`MODE_BALLOT names "${modeId}", which is not in the mode registry.`);
  }
}
for (const mapId of MAP_BALLOT) {
  if (!MAPS.some((m) => m.id === mapId)) {
    throw new Error(`MAP_BALLOT names "${mapId}", which is not in the map registry.`);
  }
}
