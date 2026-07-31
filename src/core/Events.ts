import type { BotTeam } from '../ai/Combatant';
import type { BotTier } from '../ai/DifficultyTiers';
import type { BotState } from '../ai/BotStates';
import type { HitZone } from '../combat/HitboxRig';
import type { GameStateId } from '../GameStates';
import type { StanceId } from '../player/Stance';
import type { WeaponSlot } from '../weapons/WeaponDefs';
import { EventBus } from './EventBus';

/**
 * The game's event vocabulary.
 *
 * `EV` exists so call sites read `bus.emit(EV.PlayerLanded, ...)` rather than a bare
 * string literal; the map below is what makes the payload type-checked.
 *
 * This map grows one milestone at a time. M1 declares only what M1 emits — a
 * declared-but-never-emitted event is a lie about what the game does.
 */

export const EV = {
  PlayerSpawned: 'player.spawned',
  PlayerStanceChanged: 'player.stanceChanged',
  PlayerJumped: 'player.jumped',
  PlayerLanded: 'player.landed',
  PlayerFootstep: 'player.footstep',
  PlayerSlideStarted: 'player.slideStarted',
  PlayerSlideEnded: 'player.slideEnded',
  PlayerMantleStarted: 'player.mantleStarted',
  PlayerMantleEnded: 'player.mantleEnded',
  PlayerHealthChanged: 'player.healthChanged',

  WeaponFired: 'weapon.fired',
  WeaponDryFired: 'weapon.dryFired',
  WeaponReloadStarted: 'weapon.reloadStarted',
  WeaponReloadStep: 'weapon.reloadStep',
  WeaponReloadFinished: 'weapon.reloadFinished',
  WeaponAdsChanged: 'weapon.adsChanged',
  WeaponAmmoChanged: 'weapon.ammoChanged',
  /** M5: the active inventory slot changed hands. Fires at the hand-over, not the request. */
  WeaponSwapped: 'weapon.swapped',

  // M5: thrown equipment and the things it does to people (S6.3).
  EquipmentThrown: 'equipment.thrown',
  EquipmentBounced: 'equipment.bounced',
  EquipmentArmed: 'equipment.armed',
  EquipmentExploded: 'equipment.exploded',
  EquipmentFlashed: 'equipment.flashed',
  SmokeSpawned: 'equipment.smokeSpawned',

  BulletImpact: 'bullet.impact',
  DamageDealt: 'damage.dealt',
  EntityKilled: 'entity.killed',

  BotSpawned: 'bot.spawned',
  BotStateChanged: 'bot.stateChanged',

  // M4: the match, as opposed to the firefight.
  MatchStarted: 'match.started',
  MatchEnded: 'match.ended',
  RoundStarted: 'round.started',
  RoundEnded: 'round.ended',
  SidesSwapped: 'match.sidesSwapped',
  ScoreChanged: 'score.changed',
  KillfeedEntry: 'killfeed.entry',
  AnnouncerCue: 'announcer.cue',

  // M6: progression. Only what M6 actually emits — a declared-but-never-emitted event is
  // a lie about what the game does, which is the rule this map has followed since M1.
  MetaXpAwarded: 'meta.xpAwarded',
  MetaLevelUp: 'meta.levelUp',
  MetaChallengeCompleted: 'meta.challengeCompleted',
  MetaCamoUnlocked: 'meta.camoUnlocked',
  MetaLoadoutChanged: 'meta.loadoutChanged',
  PerkScavenged: 'perk.scavenged',
  FieldUpgradeReady: 'fieldUpgrade.ready',
  FieldUpgradeUsed: 'fieldUpgrade.used',

  GameStateChanged: 'game.stateChanged',
  SettingsChanged: 'settings.changed',
} as const;

/**
 * The announcer's whole vocabulary (S6.5).
 *
 * Cues, not words: these are synthesised filtered-noise stings, because speech synthesis of
 * actual lines is both out of reach without assets and worse than nothing when it lands
 * badly. The mix ducks under each one.
 */
export type AnnouncerCue =
  | 'matchStart'
  | 'fight'
  | 'twoMinutes'
  | 'oneMinute'
  | 'thirtySeconds'
  | 'leadTaken'
  | 'leadLost'
  | 'victory'
  | 'defeat'
  | 'draw';

export type SlideEndReason = 'expired' | 'jumpCancel' | 'crouchReleased' | 'tooSlow' | 'blocked';

/**
 * The keyframed reload sequence (S6.6). Each step is both an animation segment and an
 * audio cue, so the animation cannot drift out of sync with what you hear.
 */
export type ReloadStep = 'down' | 'magOut' | 'magIn' | 'raise' | 'charge';

/**
 * Payload map. Declared as a type alias rather than an interface so it satisfies the
 * `EventMap` index-signature constraint. Payload objects are reused and only valid
 * for the duration of the dispatch — copy anything you intend to keep.
 */
export type GameEvents = {
  /**
   * Every `player.*` event carries `entityId` from M3 onward.
   *
   * These are emitted by `PlayerController`, and from M3 a bot owns one of those too — so
   * "the player landed" became "somebody landed" and a subscriber that wants the camera to
   * dip has to say whose landing it cares about. `PLAYER_ENTITY_ID` is 0.
   */
  [EV.PlayerSpawned]: { entityId: number; x: number; y: number; z: number; yaw: number };
  [EV.PlayerStanceChanged]: { entityId: number; from: StanceId; to: StanceId; tick: number };
  [EV.PlayerJumped]: { entityId: number; x: number; y: number; z: number; horizontalSpeed: number };
  /**
   * `impactSpeed` is downward velocity magnitude at the moment of contact, m/s.
   * `material` is the surface underfoot, so M2's audio can colour the sound by it.
   */
  [EV.PlayerLanded]: {
    entityId: number;
    x: number;
    y: number;
    z: number;
    impactSpeed: number;
    stance: StanceId;
    material: number;
  };
  /** `quiet` is set while crouched or sliding: audible at 12 m rather than beyond (S6.3). */
  [EV.PlayerFootstep]: {
    entityId: number;
    x: number;
    y: number;
    z: number;
    speed: number;
    heavy: boolean;
    quiet: boolean;
    material: number;
  };
  [EV.PlayerSlideStarted]: { entityId: number; x: number; y: number; z: number; entrySpeed: number };
  [EV.PlayerSlideEnded]: { entityId: number; reason: SlideEndReason; exitSpeed: number; tick: number };
  [EV.PlayerMantleStarted]: { entityId: number; x: number; y: number; z: number; ledgeHeight: number };
  [EV.PlayerMantleEnded]: { entityId: number; x: number; y: number; z: number; endStance: StanceId };
  [EV.PlayerHealthChanged]: { current: number; max: number; delta: number; regenerating: boolean };

  /**
   * One round left the barrel, and has already landed — every weapon is hitscan (S4.4).
   *
   * Emitted *after* the trace resolves so the payload can carry the end point, which is
   * what a tracer needs. `damage.dealt` and `bullet.impact` therefore arrive just before
   * this on the same tick; they are all rendered in the same frame, so the ordering is
   * not observable, and the alternative is a second event carrying one vector.
   *
   * `x,y,z` is the muzzle and `dx,dy,dz` is the direction *after* recoil and spread.
   * `shotIndex` is the index into the recoil pattern, which is what the debug plot reads.
   */
  [EV.WeaponFired]: {
    weaponId: string;
    /** Who pulled the trigger. From M3 that is not always the player. */
    sourceId: number;
    x: number;
    y: number;
    z: number;
    dx: number;
    dy: number;
    dz: number;
    endX: number;
    endY: number;
    endZ: number;
    distance: number;
    shotIndex: number;
    spreadDeg: number;
    tracer: boolean;
    hitTarget: boolean;
    ammoInMag: number;
    /**
     * M5. One trigger pull is one event even for a shotgun, so the pellet count and how
     * many of them connected ride along — a second event per pellet would fire eight muzzle
     * flashes and eight gunshots for one bang.
     */
    pellets: number;
    pelletsHit: number;
    /**
     * False once a suppressor is fitted (S6.2). Carried on the event because only the
     * shooter's *resolved* def knows, and the minimap has no way to ask.
     */
    minimapPing: boolean;
  };
  /**
   * The mechanical vocabulary. Each carries `sourceId` from M3 for the same reason
   * `weapon.fired` does: a bot working its charging handle across the room is a sound the
   * player should hear *over there*, not at their own shoulder.
   */
  [EV.WeaponDryFired]: { weaponId: string; sourceId: number };
  [EV.WeaponReloadStarted]: { weaponId: string; sourceId: number; empty: boolean; duration: number };
  [EV.WeaponReloadStep]: { weaponId: string; sourceId: number; step: ReloadStep };
  [EV.WeaponReloadFinished]: { weaponId: string; sourceId: number; mag: number; reserve: number };
  [EV.WeaponAdsChanged]: { weaponId: string; sourceId: number; aiming: boolean };
  [EV.WeaponAmmoChanged]: { weaponId: string; sourceId: number; mag: number; reserve: number };
  [EV.WeaponSwapped]: { fromId: string; toId: string; sourceId: number; slot: WeaponSlot };

  /**
   * M5 equipment (S6.3).
   *
   * Everything a grenade does to somebody arrives through one of these. The explosion is
   * `equipment.exploded` plus the ordinary `damage.dealt` for each victim — there is still
   * exactly one damage door (M3's note), and a grenade is a `WeaponDef`-shaped record like
   * everything else.
   */
  [EV.EquipmentThrown]: {
    equipmentId: string;
    sourceId: number;
    x: number;
    y: number;
    z: number;
    /** Seconds the fuse had already been cooking when it left the hand. */
    cooked: number;
  };
  [EV.EquipmentBounced]: {
    equipmentId: string;
    x: number;
    y: number;
    z: number;
    /** Impact speed, m/s — the bounce is louder the harder it lands. */
    speed: number;
    material: number;
    /** True when it stuck rather than bounced (semtex, claymore planting). */
    stuck: boolean;
  };
  /** A claymore finished arming and is now watching its arc. */
  [EV.EquipmentArmed]: { equipmentId: string; sourceId: number; x: number; y: number; z: number };
  [EV.EquipmentExploded]: {
    equipmentId: string;
    sourceId: number;
    x: number;
    y: number;
    z: number;
    radius: number;
    /** How many combatants took damage. */
    victims: number;
  };
  /**
   * Somebody was flashed. `intensity` is the final 0..1 effect after the angle and
   * line-of-sight scaling S6.3 asks for, and both inputs are carried so the scaling can be
   * reported rather than asserted.
   */
  [EV.EquipmentFlashed]: {
    targetId: number;
    sourceId: number;
    intensity: number;
    /** Degrees between the target's facing and the direction to the blast. */
    angleDeg: number;
    distance: number;
    hadLos: boolean;
  };
  [EV.SmokeSpawned]: { x: number; y: number; z: number; radius: number; seconds: number };

  /** A round terminated on world geometry, or punched through it. */
  [EV.BulletImpact]: {
    x: number;
    y: number;
    z: number;
    nx: number;
    ny: number;
    nz: number;
    material: number;
    penetrated: boolean;
  };
  [EV.DamageDealt]: {
    sourceId: number;
    targetId: number;
    weaponId: string;
    zone: HitZone;
    amount: number;
    x: number;
    y: number;
    z: number;
    distance: number;
    /** Damage lost to falloff, HP. */
    falloffLoss: number;
    /** Damage lost to wall penetration, HP. */
    penetrationLoss: number;
    lethal: boolean;
  };
  [EV.EntityKilled]: { targetId: number; sourceId: number; weaponId: string; zone: HitZone };

  [EV.BotSpawned]: {
    entityId: number;
    team: BotTeam;
    tier: BotTier;
    x: number;
    y: number;
    z: number;
    yaw: number;
    /** Metres to the nearest living enemy at the moment of spawning (S6.9). */
    nearestEnemy: number;
  };
  [EV.BotStateChanged]: { entityId: number; from: BotState; to: BotState; tier: BotTier };

  /**
   * M4. A match is not a firefight: it has a mode, a clock, rounds and an outcome, and the
   * HUD, the scoreboard, the announcer and the summary screen all learn about it from here
   * rather than by reaching into `MatchFlow`.
   */
  [EV.MatchStarted]: { modeId: string; modeName: string; mapId: string; mapName: string; roundsToWin: number };
  [EV.MatchEnded]: {
    winner: BotTeam | 'DRAW';
    reason: string;
    scoreA: number;
    scoreB: number;
    /** True when the local player's side won. Drives the announcer cue and the summary. */
    localWon: boolean;
  };
  [EV.RoundStarted]: { round: number; roundsToWin: number };
  [EV.RoundEnded]: { round: number; winner: BotTeam | 'DRAW'; reason: string };
  [EV.SidesSwapped]: { afterRound: number };
  [EV.ScoreChanged]: { teamA: number; teamB: number; limit: number };
  /**
   * One line for the killfeed. Names rather than ids, because the feed is text and
   * resolving an id to a name in the presentation layer means the presentation layer needs
   * the roster.
   */
  [EV.KillfeedEntry]: {
    killerName: string;
    victimName: string;
    killerTeam: BotTeam | 'NONE';
    victimTeam: BotTeam | 'NONE';
    weaponId: string;
    headshot: boolean;
    suicide: boolean;
    /** True when the local player killed or was killed. The feed brightens those rows. */
    involvesLocal: boolean;
  };
  [EV.AnnouncerCue]: { cue: AnnouncerCue };

  /**
   * M6 progression.
   *
   * All of these are *presentation* events: the profile is already updated by the time
   * they fire, and nothing gameplay-facing subscribes to them. That is deliberate — XP
   * must not be able to change what a match does, or acceptance criterion 9 ("progression
   * costs nothing in the hot path") stops being a measurement and becomes a hope.
   */
  [EV.MetaXpAwarded]: { total: number; xpBefore: number; xpAfter: number };
  [EV.MetaLevelUp]: { level: number; prestige: number; unlockCount: number };
  [EV.MetaChallengeCompleted]: { id: string; name: string; xp: number; camo: string | null };
  [EV.MetaCamoUnlocked]: { camoId: string; name: string };
  [EV.MetaLoadoutChanged]: { slotIndex: number; name: string };
  /** Scavenger picked a magazine off a body. Carries where, so the audio is positional. */
  [EV.PerkScavenged]: { entityId: number; x: number; y: number; z: number; rounds: number };
  [EV.FieldUpgradeReady]: { upgradeId: string; entityId: number };
  [EV.FieldUpgradeUsed]: { upgradeId: string; entityId: number; x: number; y: number; z: number };

  [EV.GameStateChanged]: { from: GameStateId; to: GameStateId };
  [EV.SettingsChanged]: { key: string };
};

export type GameBus = EventBus<GameEvents>;

export function createGameBus(): GameBus {
  return new EventBus<GameEvents>();
}
