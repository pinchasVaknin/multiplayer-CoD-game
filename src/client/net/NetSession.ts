import type { RenderableActor } from '../../shared/ai/BotVisualState';
import type { CombatantDirectory } from '../../shared/combat/Killfeed';
import type { HitZone } from '../../shared/combat/HitboxRig';
import type { LocalIdentity } from '../../shared/combat/LocalIdentity';
import { EV, type GameBus } from '../../shared/core/Events';
import type { InputCommand } from '../../shared/core/InputCommand';
import { logger } from '../../shared/core/Log';
import { DEFAULT_INTERPOLATION_DELAY_MS } from '../../shared/net/Interpolation';
import type { NetLoadout } from '../../shared/net/Skirmish';
import { NetClient, type SkirmishSink, type NetClientState } from '../../shared/net/NetClient';
import { phaseAt, SFlag, type WelcomeInfo } from '../../shared/net/Messages';
import { EFlag, weaponIdAt } from '../../shared/net/Snapshot';
import type { PlayerController } from '../../shared/player/PlayerController';
import {
  makeReplicatedMatchState,
  type ReplicatedMatchState,
} from '../../shared/modes/MatchFlow';
import { WEAPON_DEFS } from '../../shared/weapons/WeaponDefs';
import type { BrowserLink } from './BrowserLink';
import { RemoteActor } from './RemoteActor';

const log = logger('net');

/**
 * The client's networked match (M10).
 *
 * ## What this is, in one sentence
 *
 * It turns a socket into things the rest of the client already knows how to draw.
 *
 * ## The event bridge, which is the whole trick
 *
 * S3 sets the requirement: *"Gameplay events still go through the `EventBus`. On the server
 * it drives authority; on the client it drives presentation. **A networked event and a local
 * one must be indistinguishable to the client.**"*
 *
 * So this takes the replicated events off the wire and re-emits them onto the client's own
 * `GameBus` with the same payload shapes M1-M8 already emit. Nothing downstream changes or
 * even knows: the hitmarker, the damage numbers, the killfeed, the impact decals, the tracers,
 * the positional gunfire, the footsteps and the low-health muffle are all wired to those bus
 * entries and keep working with no networking code in them at all.
 *
 * That is why this file is a few hundred lines instead of a rewrite of the presentation
 * layer. The seam M1 built is being cashed in.
 */

export interface NetSessionDeps {
  /**
   * The link, already open and already past the handshake.
   *
   * Handed in rather than opened here (M10, playtest round 2): the map this session's world
   * is built on comes out of the `Welcome`, so the connection has to exist before the world
   * does. See `client/net/Handshake.ts`.
   */
  readonly link: BrowserLink;
  readonly welcome: WelcomeInfo;
  /** When the `Welcome` landed. Seeds the clock. See `NetClient.adopt`. */
  readonly receivedAtMs: number;
  /**
   * Frames the handshake drained behind the `Welcome`, replayed by `start`.
   *
   * Ordinarily empty. See `HandshakeResult.pending` for the reconnect case that is not.
   */
  readonly pending?: readonly Uint8Array[];
  readonly displayName: string;
  readonly bus: GameBus;
  readonly controller: PlayerController;
  readonly sample: (tickIndex: number) => InputCommand;
  /** The local weapon, stepped once per tick and never replayed. See `Prediction`. */
  readonly applyWeapon: (cmd: InputCommand) => void;
  /**
   * This client's identity, adopted from the `Welcome`.
   *
   * Every "is this event mine?" test in the presentation layer reads it. See `LocalIdentity`.
   */
  readonly identity: LocalIdentity;
  readonly interpolationDelayMs?: number;
  readonly wantRewindDebug?: boolean;
  /** The server rotated to a new match. The world must be rebuilt. */
  readonly onNewMatch?: (welcome: WelcomeInfo) => void;
  /**
   * M11 (§6.4, §6.5, §6.9): the skirmish messages, passed straight through to `NetClient`.
   *
   * Not handled here, because every one of them is a decision above this class — open an
   * overlay, start a mesh build, show a summary. This layer's job is the socket and the
   * prediction loop.
   */
  readonly skirmish?: SkirmishSink;
  /** The class to send with the `Hello` (Tier 1 #20). See `writeHello`. */
  readonly loadout?: NetLoadout | null;
}

export class NetSession {
  readonly client: NetClient;
  readonly link: BrowserLink;

  /** Remote entities, keyed by entity id. Drawn by `BotRenderer` (S6.5). */
  readonly actors = new Map<number, RemoteActor>();

  /** Replicated score and clock, for the HUD. */
  scoreA = 0;
  scoreB = 0;
  timeLeft = -1;
  frozen = false;
  matchOver = false;

  /**
   * Where replicated match state is applied.
   *
   * Set by `MatchWorld` once the match exists. A callback rather than a direct reference
   * because the session is constructed *before* the match — the match's renderer needs the
   * session's actor list at construction — so the dependency can only point this way.
   */
  onMatchState: ((state: ReplicatedMatchState) => void) | null = null;

  /**
   * Where the local player's replicated health and liveness are applied.
   *
   * The client had three independent notions of "am I dead" — `NetClient.localAlive`,
   * `ClientMatch.playerDead` and the local `Health` object — and only the first was driven by
   * the server. That divergence is what let a respawned player stay frozen: the suppression
   * that stopped their movement and the state that would have lifted it were different facts.
   * This makes the server's answer the only one.
   */
  onLocalState: ((health: number, alive: boolean) => void) | null = null;

  private lastScoreA = -1;
  private lastScoreB = -1;
  private lastLocalHealth = -1;
  private lastLocalAlive = true;

  private readonly deps: NetSessionDeps;
  private readonly interpolationDelayMs: number;
  private readonly renderable: RenderableActor[] = [];

  constructor(deps: NetSessionDeps) {
    this.deps = deps;
    this.interpolationDelayMs = deps.interpolationDelayMs ?? DEFAULT_INTERPOLATION_DELAY_MS;
    this.link = deps.link;

    /**
     * Adopt the server's entity assignment before anything can ask about it.
     *
     * This one line is what makes the hitmarker appear. Every local-player test in the
     * presentation layer compares against `PLAYER_ENTITY_ID`, which is 0 and is the server's
     * empty spectator seat; a connected human is entity 1 or above, so before this every one
     * of those comparisons was false and every piece of feedback silently did nothing.
     */
    deps.identity.adopt(deps.welcome.entityId);

    this.client = new NetClient({
      link: this.link,
      controller: deps.controller,
      sample: deps.sample,
      applyNonReplayed: deps.applyWeapon,
      displayName: deps.displayName,
      loadout: deps.loadout ?? null,
      wantRewindDebug: deps.wantRewindDebug,
      onNewMatch: (welcome) => {
        // A rotation reassigns entity ids, so the identity has to move with it or every
        // filter downstream starts testing against the seat we held in the previous match.
        deps.identity.adopt(welcome.entityId);
        deps.onNewMatch?.(welcome);
      },
      skirmish: {
        ...deps.skirmish,
        onMigrated: (welcome) => {
          // Same reason as `onNewMatch` above, and it has to happen here as well: a migration
          // is the other way this client's entity id changes, and an identity left pointing at
          // the seat we held in the arena makes every "was that me?" test in the presentation
          // layer wrong for the whole live match.
          deps.identity.adopt(welcome.entityId);
          deps.skirmish?.onMigrated?.(welcome);
        },
      },
      events: {
        // ---- the bridge (S3) ------------------------------------------------
        onFired: (e) => {
          // Never re-emit our own shots: the local weapon already emitted `weapon.fired` on
          // the tick it was predicted, and playing it again from the server would double
          // every muzzle flash and every gunshot the player hears from their own rifle.
          if (e.sourceId === this.client.entityId) return;
          const weaponId = weaponIdAt(e.weaponIndex);
          const def = weaponId === null ? undefined : WEAPON_DEFS[weaponId];
          if (def === undefined) return;
          evFired.weaponId = def.id;
          evFired.sourceId = e.sourceId;
          evFired.x = e.x;
          evFired.y = e.y;
          evFired.z = e.z;
          evFired.endX = e.endX;
          evFired.endY = e.endY;
          evFired.endZ = e.endZ;
          const dx = e.endX - e.x;
          const dy = e.endY - e.y;
          const dz = e.endZ - e.z;
          const len = Math.hypot(dx, dy, dz) || 1;
          evFired.dx = dx / len;
          evFired.dy = dy / len;
          evFired.dz = dz / len;
          evFired.distance = len;
          evFired.shotIndex = 0;
          evFired.spreadDeg = 0;
          evFired.tracer = e.tracer;
          evFired.hitTarget = e.hitTarget;
          evFired.ammoInMag = 0;
          evFired.pellets = 1;
          evFired.pelletsHit = e.hitTarget ? 1 : 0;
          evFired.minimapPing = def.minimapPing;
          this.deps.bus.emit(EV.WeaponFired, evFired);

          /**
           * The impact, synthesised from the shot's terminus.
           *
           * Impacts are not replicated — see `EventCollector` for why — so the decal, the
           * debris and the surface click are produced here from the endpoint and material the
           * shot carried. The normal is the reverse of the travel direction, which is right
           * for a flat wall and slightly wrong for a glancing hit; the alternative is four
           * more bytes per shot to make a spark point differently.
           */
          evImpact.x = e.endX;
          evImpact.y = e.endY;
          evImpact.z = e.endZ;
          evImpact.nx = -evFired.dx;
          evImpact.ny = -evFired.dy;
          evImpact.nz = -evFired.dz;
          evImpact.material = e.material;
          evImpact.penetrated = false;
          this.deps.bus.emit(EV.BulletImpact, evImpact);
        },

        onDamage: (e) => {
          evDamage.sourceId = e.sourceId;
          evDamage.targetId = e.targetId;
          evDamage.weaponId = '';
          evDamage.zone = e.zone;
          evDamage.amount = e.amount;
          evDamage.x = e.x;
          evDamage.y = e.y;
          evDamage.z = e.z;
          evDamage.distance = 0;
          evDamage.falloffLoss = 0;
          evDamage.penetrationLoss = 0;
          evDamage.lethal = e.lethal;
          this.deps.bus.emit(EV.DamageDealt, evDamage);
        },

        onKilled: (e) => {
          evKilled.targetId = e.targetId;
          evKilled.sourceId = e.sourceId;
          evKilled.weaponId = weaponIdAt(e.weaponIndex) ?? '';
          evKilled.zone = e.zone;
          this.deps.bus.emit(EV.EntityKilled, evKilled);
        },

        onFootstep: (e) => {
          // Our own footsteps are produced by our own predicted `PlayerController`. Playing
          // the server's copy too would double every step the player takes.
          if (e.entityId === this.client.entityId) return;
          evStep.entityId = e.entityId;
          evStep.x = e.x;
          evStep.y = e.y;
          evStep.z = e.z;
          evStep.speed = 0;
          evStep.heavy = e.heavy;
          evStep.quiet = e.quiet;
          evStep.material = e.material;
          this.deps.bus.emit(EV.PlayerFootstep, evStep);
        },

        onLand: (e) => {
          if (e.entityId === this.client.entityId) return;
          evLand.entityId = e.entityId;
          evLand.x = e.x;
          evLand.y = e.y;
          evLand.z = e.z;
          evLand.impactSpeed = e.speed;
          evLand.stance = 'STAND';
          evLand.material = e.material;
          this.deps.bus.emit(EV.PlayerLanded, evLand);
        },

        onJump: (e) => {
          if (e.entityId === this.client.entityId) return;
          evJump.entityId = e.entityId;
          evJump.x = e.x;
          evJump.y = e.y;
          evJump.z = e.z;
          evJump.horizontalSpeed = e.speed;
          this.deps.bus.emit(EV.PlayerJumped, evJump);
        },
      },
    });
  }

  get state(): NetClientState {
    return this.client.state;
  }

  /** What the server said it was running when this session joined. */
  get welcome(): WelcomeInfo {
    return this.deps.welcome;
  }

  /**
   * Called for every body the snapshot knows about, so the caller can put them on the
   * scoreboard. Expected to be idempotent — see `registerRoster`.
   */
  onRosterEntry: ((entityId: number, name: string, team: 'A' | 'B') => void) | null = null;

  get connected(): boolean {
    return this.client.state === 'joined';
  }

  /**
   * Take up the connection the handshake already made.
   *
   * Synchronous, and deliberately so: by the time this runs the socket is open and the
   * `Welcome` has been decoded, so there is nothing left to wait for. The asynchrony all
   * happened before the world was built, which is the whole point of the reordering.
   */
  start(): void {
    this.client.adopt(this.deps.welcome, this.deps.receivedAtMs);
    // Anything that shared a batch with the `Welcome` was dequeued before this client existed.
    // Replayed after `adopt`, so it lands on a joined client rather than a connecting one.
    const pending = this.deps.pending;
    if (pending !== undefined && pending.length > 0) {
      log.info(`replaying ${pending.length} frame(s) that arrived behind the welcome.`);
      this.client.replay(pending);
    }
    log.info(`joined ${this.link.remoteAddress} as ${this.deps.displayName}`);
  }

  disconnect(reason = 'left'): void {
    this.client.disconnect(reason);
  }

  /**
   * Let go of the connection without closing it (M10, playtest round 2).
   *
   * Used when the server rotates to a new match: this session's world is being torn down and
   * a new one built, but the *socket* is fine and the seat on the server is still ours. The
   * caller hands the same link to the next session.
   *
   * Everything that could keep drawing is cut — the callbacks that push state into a match
   * about to be disposed, and the actor table whose entity ids are about to be reassigned.
   */
  detach(): void {
    this.onMatchState = null;
    this.onLocalState = null;
    this.onRosterEntry = null;
    this.actors.clear();
    this.renderable.length = 0;
  }

  /**
   * One update. Called once per rendered frame, before the world is drawn.
   *
   * Returns the number of simulation steps run, which the caller uses for the same purposes
   * the local loop uses its own step count.
   */
  update(): number {
    const steps = this.client.update();

    const h = this.client.header;
    this.scoreA = h.scoreA;
    this.scoreB = h.scoreB;
    this.timeLeft = h.timeLeft;
    this.frozen = (h.flags & SFlag.InputFrozen) !== 0;
    this.matchOver = (h.flags & SFlag.MatchOver) !== 0;

    /**
     * Push the replicated match clock into the client's own inert `MatchFlow`.
     *
     * The HUD reads phase, round and both clocks straight off that object, and on a dedicated
     * server nothing ticks it. Without this the banner sat on "GET READY - 3" and the match
     * clock on 10:00 for the whole game.
     */
    if (this.client.state === 'joined') {
      replicatedState.phase = phaseAt(h.phase);
      replicatedState.secondsRemaining = Math.max(0, h.timeLeft);
      replicatedState.phaseSeconds = h.phaseSeconds;
      replicatedState.round = h.round;
      replicatedState.scoreA = h.scoreA;
      replicatedState.scoreB = h.scoreB;
      replicatedState.serverTick = h.serverTick;
      this.onMatchState?.(replicatedState);
    }

    /**
     * The score, as the event the HUD already listens for.
     *
     * Re-emitted rather than poked into the banner, so it travels the identical path a local
     * score change does (S3). Edge-triggered, because the HUD's handler is a subscription and
     * firing it twenty times a second with an unchanged value is work for nothing.
     */
    if (h.scoreA !== this.lastScoreA || h.scoreB !== this.lastScoreB) {
      this.lastScoreA = h.scoreA;
      this.lastScoreB = h.scoreB;
      evScore.teamA = h.scoreA;
      evScore.teamB = h.scoreB;
      this.deps.bus.emit(EV.ScoreChanged, evScore);
    }

    // The local player's own health and liveness, from our own entity in the snapshot.
    const own = this.client.remotes.get(this.client.entityId);
    if (own !== undefined) {
      const alive = (own.latest.flags & EFlag.Alive) !== 0;
      const health = own.latest.health;
      if (health !== this.lastLocalHealth || alive !== this.lastLocalAlive) {
        this.lastLocalHealth = health;
        this.lastLocalAlive = alive;
        this.onLocalState?.(health, alive);
      }
    }

    this.syncActors();
    // After the actors, so a body that first appeared in this snapshot is on the scoreboard
    // on the same frame it becomes visible.
    if (this.onRosterEntry !== null) this.registerRoster(this.onRosterEntry);
    return steps;
  }

  /**
   * Reconcile the actor set against the snapshot, and pull this frame's poses.
   *
   * The local player is deliberately excluded: they are predicted, drawn from the first
   * person, and have no body in the scene. Including them would put a second, ~100 ms stale
   * copy of the player inside their own camera.
   */
  private syncActors(): void {
    const renderMs = this.client.renderTimeMs(this.interpolationDelayMs);

    for (const [id, interp] of this.client.remotes) {
      if (id === this.client.entityId) continue;
      let actor = this.actors.get(id);
      if (actor === undefined) {
        actor = new RemoteActor(id);
        this.actors.set(id, actor);
      }
      actor.update(interp, renderMs);
    }

    // Anything the server has stopped sending is gone. `NetClient` already removes the
    // interpolator on an explicit removal, so this is the one place a body actually leaves
    // the scene — and it is why a disconnect does not leave a ghost (S8.11).
    if (this.actors.size !== this.client.remotes.size) {
      for (const id of this.actors.keys()) {
        if (!this.client.remotes.has(id)) this.actors.delete(id);
      }
    }
  }

  /** The renderable set, rebuilt per frame. Handed to `BotRenderer`. */
  renderables(): Iterable<RenderableActor> {
    this.renderable.length = 0;
    for (const actor of this.actors.values()) this.renderable.push(actor);
    return this.renderable;
  }

  /**
   * Names and teams for everybody in the match, from the snapshot (M10, playtest round 2).
   *
   * The killfeed and the scoreboard both resolve entity ids to names, and both did it against
   * `bots.roster` — which on a networked client is **empty**, because the bots are in the
   * server process and the other humans are `RemoteActor`s. Every lookup missed, so the feed
   * read `WORLD killed UNKNOWN` and the scoreboard had one row on it.
   *
   * `EntitySnapshot` has carried `displayName` and the team bit since the protocol was
   * written; this is the first thing to read them for anything other than drawing a label.
   * The local player is included explicitly — they have no `RemoteActor`, by design, because
   * they are predicted and drawn from the first person.
   */
  directory(): CombatantDirectory {
    return {
      nameOf: (entityId) => {
        if (this.deps.identity.is(entityId)) return this.deps.displayName;
        return this.actors.get(entityId)?.displayName ?? null;
      },
      teamOf: (entityId) => {
        if (this.deps.identity.is(entityId)) return this.deps.welcome.team;
        const actor = this.actors.get(entityId);
        return actor === undefined ? null : actor.team;
      },
    };
  }

  /**
   * Push every known body onto the scoreboard.
   *
   * Called once per frame; `ScoreSystem.register` is idempotent, so this is a cheap way to
   * pick up bodies as they first appear in a snapshot without a join/leave message type the
   * protocol does not have. Kills and deaths accumulate from the replicated events, which
   * reach `ScoreSystem` through the same bus subscriptions a local match uses (S3).
   */
  registerRoster(register: (entityId: number, name: string, team: 'A' | 'B') => void): void {
    register(this.deps.identity.entityId, this.deps.displayName, this.deps.welcome.team);
    for (const actor of this.actors.values()) {
      if (actor.displayName === '') continue;
      register(actor.entityId, actor.displayName, actor.team);
    }
  }
}

/**
 * Refilled per snapshot and handed straight to `MatchFlow`.
 *
 * The same "payloads are transient" contract the bus has used since M1: the callee reads it
 * during the call and never retains it.
 */
const replicatedState: ReplicatedMatchState = makeReplicatedMatchState();

// Event payload singletons. The bus contract since M1 is that payloads are transient and
// never retained, which is what makes reusing one record per event type safe.
const evFired = {
  weaponId: '',
  sourceId: 0,
  x: 0,
  y: 0,
  z: 0,
  dx: 0,
  dy: 0,
  dz: -1,
  endX: 0,
  endY: 0,
  endZ: 0,
  distance: 0,
  shotIndex: 0,
  spreadDeg: 0,
  tracer: false,
  hitTarget: false,
  ammoInMag: 0,
  pellets: 1,
  pelletsHit: 0,
  minimapPing: true,
};

const evImpact = { x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, material: 0, penetrated: false };

const evDamage = {
  sourceId: 0,
  targetId: 0,
  weaponId: '',
  zone: 'torso' as HitZone,
  amount: 0,
  x: 0,
  y: 0,
  z: 0,
  distance: 0,
  falloffLoss: 0,
  penetrationLoss: 0,
  lethal: false,
};

const evKilled = { targetId: 0, sourceId: 0, weaponId: '', zone: 'torso' as HitZone };

const evStep = {
  entityId: 0,
  x: 0,
  y: 0,
  z: 0,
  speed: 0,
  heavy: false,
  quiet: false,
  material: 0,
};

const evLand = {
  entityId: 0,
  x: 0,
  y: 0,
  z: 0,
  impactSpeed: 0,
  stance: 'STAND' as const,
  material: 0,
};

const evJump = { entityId: 0, x: 0, y: 0, z: 0, horizontalSpeed: 0 };

/**
 * `limit` is left at zero: the score limit is a mode rule the client already holds, and the
 * HUD only redraws it when a `ScoreChanged` carries a non-zero one.
 */
const evScore = { teamA: 0, teamB: 0, limit: 0 };
