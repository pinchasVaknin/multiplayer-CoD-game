import * as THREE from 'three';
import {
  DEFAULT_SCHEDULER,
  SCHEDULER_CONFIG_KEYS,
  SCHEDULER_TUNABLES,
  schedulerConfigToSource,
  type SchedulerConfig,
} from '../ai/AiScheduler';
import type { BotDirector } from '../ai/BotDirector';
import {
  BOT_TIERS,
  DEFAULT_PERCEPTION,
  DEFAULT_TIERS,
  PERCEPTION_CONFIG_KEYS,
  PERCEPTION_TUNABLES,
  TIER_CONFIG_KEYS,
  TIER_TUNABLES,
  perceptionConfigToSource,
  tierTableToSource,
  type PerceptionConfig,
  type TierTable,
} from '../ai/DifficultyTiers';
import type { AiDebug } from './AiDebug';
import { labelAnchorY } from './AiDebug';
import type { DebugOverlay } from './DebugOverlay';
import { makeTuningGroup } from './TuningPanel';

/**
 * The AI's text side of the debug overlay (brief S7).
 *
 * Three jobs: the per-tick cost read-outs acceptance criterion 6 is read from, one
 * selected bot's entire blackboard, and a floating state label over every bot. Plus the
 * six slider panels — one per tier, then perception and the scheduler rates — which is
 * S7's "live sliders for every difficulty-tier value" taken literally.
 *
 * The labels are DOM rather than sprites for the same reason the HUD is: a projected
 * `transform` on an already-composited element costs nothing, where 24 canvas textures
 * would cost a texture upload each. They are only positioned while the layer is on.
 */

/** Read-outs refresh on the overlay's own 15 Hz text hook, never per frame. */
export class AiPanel {
  private readonly labelLayer: HTMLElement;
  private readonly labels: HTMLElement[] = [];
  private readonly project = new THREE.Vector3();

  private selected = 0;

  private readonly fBots = field();
  private readonly fAiMs = field();
  private readonly fAiPct = field();
  private readonly fWork = field();
  private readonly fAstar = field();
  private readonly fAstarQueue = field();
  private readonly fSearches = field();
  private readonly fNav = field();
  private readonly fCover = field();
  private readonly fSpawnTier = field();
  private readonly fSpawnSafety = field();

  private readonly fSel = field();
  private readonly fSelState = field();
  private readonly fSelHealth = field();
  private readonly fSelTarget = field();
  private readonly fSelKnown = field();
  private readonly fSelInvestigate = field();
  private readonly fSelReaction = field();
  private readonly fSelAim = field();
  private readonly fSelGoal = field();
  private readonly fSelPath = field();
  private readonly fSelScore = field();

  constructor(
    private readonly overlay: DebugOverlay,
    private readonly director: BotDirector,
    private readonly aiDebug: AiDebug,
    tiers: TierTable,
    perception: PerceptionConfig,
    scheduler: SchedulerConfig,
    debugHost: HTMLElement,
  ) {
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'dbg-botlabels';
    this.labelLayer.hidden = true;
    debugHost.appendChild(this.labelLayer);

    this.buildSections();
    this.buildTuning(tiers, perception, scheduler);

    overlay.addTextHook(() => this.refresh());
    window.addEventListener('keydown', this.onKeyDown);
  }

  /** Position the floating state labels. Render rate, and only while the layer is on. */
  updateLabels(camera: THREE.PerspectiveCamera, alpha: number): void {
    const on = this.aiDebug.isEnabled;
    if (this.labelLayer.hidden === on) this.labelLayer.hidden = !on;
    if (!on) return;

    const bots = this.director.bots;
    this.ensureLabels(bots.length);
    const halfW = window.innerWidth * 0.5;
    const halfH = window.innerHeight * 0.5;

    for (let i = 0; i < this.labels.length; i++) {
      const el = this.labels[i];
      if (el === undefined) continue;
      const bot = bots[i];
      if (bot === undefined) {
        el.style.display = 'none';
        continue;
      }

      this.project.set(bot.renderX(alpha), labelAnchorY(bot), bot.renderZ(alpha)).project(camera);
      // z > 1 is behind the camera; projecting it would mirror the label onto the screen.
      if (this.project.z > 1) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      el.style.transform = `translate(-50%, -100%) translate(${(halfW + this.project.x * halfW).toFixed(
        0,
      )}px, ${(halfH - this.project.y * halfH).toFixed(0)}px)`;

      const text = `${bot.displayName} ${bot.state}`;
      if (el.dataset['t'] !== text) {
        el.dataset['t'] = text;
        el.textContent = text;
      }
      el.classList.toggle('dbg-botlabel--sel', i === this.selected);
      el.classList.toggle('dbg-botlabel--dead', !bot.health.alive);
    }
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    this.labelLayer.remove();
  }

  // -- construction ----------------------------------------------------------

  private buildSections(): void {
    const left = this.overlay.leftColumn;

    const ai = this.overlay.section('AI · budget', left);
    bind(ai, 'Bots', this.fBots);
    bind(ai, 'AI last / mean', this.fAiMs);
    bind(ai, 'AI p50 / p99 / worst', this.fAiPct);
    bind(ai, 'Runs (per/tac/path)', this.fWork);
    bind(ai, 'A* nodes now / worst', this.fAstar);
    bind(ai, 'A* queued / starved', this.fAstarQueue);
    bind(ai, 'Searches ok / failed', this.fSearches);
    bind(ai, 'Navmesh', this.fNav);
    bind(ai, 'Cover used / total', this.fCover);
    bind(ai, 'Spawns s/h/lb', this.fSpawnTier);
    bind(ai, 'Spawn min / cone / seen', this.fSpawnSafety);

    ai.addNode(
      toggle('AI visualisation (F4)', false, (on) => {
        this.aiDebug.setEnabled(on);
      }),
    );

    const bb = this.overlay.section('AI · blackboard', left);
    bind(bb, 'Bot', this.fSel);
    bind(bb, 'State', this.fSelState);
    bind(bb, 'Health / ammo', this.fSelHealth);
    bind(bb, 'Target', this.fSelTarget);
    bind(bb, 'Last known', this.fSelKnown);
    bind(bb, 'Investigate', this.fSelInvestigate);
    bind(bb, 'Reaction', this.fSelReaction);
    bind(bb, 'Aim err / off-sol', this.fSelAim);
    bind(bb, 'Goal', this.fSelGoal);
    bind(bb, 'Path', this.fSelPath);
    bind(bb, 'K/D · shots', this.fSelScore);
    bb.addNode(button('Select next bot (F5)', () => this.cycleSelection()));
  }

  private buildTuning(tiers: TierTable, perception: PerceptionConfig, scheduler: SchedulerConfig): void {
    // One panel per tier. `tierTableToSource` writes the whole table out, so COPY CONFIG
    // from any of the four gives a pasteable `DEFAULT_TIERS` rather than a fragment.
    for (const tier of BOT_TIERS) {
      this.overlay.addTuningGroup(
        makeTuningGroup(
          `Tier · ${tier}`,
          tiers[tier],
          TIER_TUNABLES,
          TIER_CONFIG_KEYS,
          DEFAULT_TIERS[tier],
          () => tierTableToSource(tiers),
        ),
        noop,
      );
    }

    this.overlay.addTuningGroup(
      makeTuningGroup(
        'Perception',
        perception,
        PERCEPTION_TUNABLES,
        PERCEPTION_CONFIG_KEYS,
        DEFAULT_PERCEPTION,
        perceptionConfigToSource,
      ),
      noop,
    );

    this.overlay.addTuningGroup(
      makeTuningGroup(
        'AI scheduler',
        scheduler,
        SCHEDULER_TUNABLES,
        SCHEDULER_CONFIG_KEYS,
        DEFAULT_SCHEDULER,
        schedulerConfigToSource,
      ),
      noop,
    );
  }

  private ensureLabels(count: number): void {
    while (this.labels.length < count) {
      const el = document.createElement('div');
      el.className = 'dbg-botlabel op-label';
      this.labelLayer.appendChild(el);
      this.labels.push(el);
    }
  }

  private cycleSelection(): void {
    const n = this.director.botCount;
    if (n === 0) return;
    this.selected = (this.selected + 1) % n;
  }

  // -- read-out --------------------------------------------------------------

  private refresh(): void {
    const d = this.director;
    // Percentiles are computed from a sorted copy, so this is done here at 15 Hz rather
    // than in `endTick` at 60 Hz — the overlay must not show up in what it measures.
    d.scheduler.recompute();

    const s = d.scheduler;
    const pf = d.pathfinder;

    let alive = 0;
    for (const bot of d.bots) {
      if (bot.health.alive) alive++;
    }

    set(this.fBots, `${alive} alive / ${d.botCount}`);
    set(this.fAiMs, `${s.lastMs.toFixed(2)} / ${s.meanMs.toFixed(3)} ms`);
    set(this.fAiPct, `${s.p50Ms.toFixed(2)} / ${s.p99Ms.toFixed(2)} / ${s.worstMs.toFixed(2)} ms`);
    set(this.fWork, `${s.perceptionRuns} / ${s.tacticalRuns} / ${s.pathRuns}`);
    set(this.fAstar, `${pf.nodesThisTick} / ${pf.worstNodesPerTick}`);
    set(this.fAstarQueue, `${pf.pending} / ${pf.budgetExhaustedTicks}`);
    set(this.fSearches, `${pf.searchesCompleted} / ${pf.searchesFailed}`);

    const nav = d.navStats;
    set(
      this.fNav,
      `${nav.walkable}/${nav.cells} nodes · ${nav.links} links · ${nav.stacked} stacked · ${nav.bakeMs.toFixed(0)}ms`,
    );
    set(this.fCover, `${d.cover.occupiedCount} / ${d.cover.count} (${nav.coverRejected} rejected)`);

    const sp = d.spawns.stats;
    set(this.fSpawnTier, `${sp.safe} / ${sp.hidden} / ${sp.leastBad} of ${sp.selections}`);
    const minDist = Number.isFinite(sp.minEnemyDistance) ? sp.minEnemyDistance.toFixed(2) : '-';
    set(this.fSpawnSafety, `${minDist} m · ${sp.coneViolations} cone · ${sp.visibleViolations} seen`);

    this.refreshSelected();
  }

  private refreshSelected(): void {
    const bot = this.director.bots[this.selected];
    if (bot === undefined) {
      set(this.fSel, 'none');
      return;
    }
    const bb = bot.blackboard;
    const brain = bot.brain;
    const combat = bot.combat;

    set(this.fSel, `${this.selected}: ${bot.displayName} · ${bot.team} · ${bot.tierName}`);
    set(this.fSelState, `${brain.state} (${brain.stateTime.toFixed(1)}s)`);
    set(
      this.fSelHealth,
      `${bot.health.current.toFixed(0)}/${bot.health.max} · ${bot.magazine}/${bot.reserve}` +
        `${bot.reloading ? ' reloading' : ''}`,
    );
    set(
      this.fSelTarget,
      bb.targetId < 0
        ? 'none'
        : `#${bb.targetId} ${bb.hasLos ? 'LOS' : `lost ${bb.sinceLos.toFixed(1)}s`} conf ${bb.confidence.toFixed(2)}` +
            ` · ${bb.visibleEnemies} visible`,
    );
    set(
      this.fSelKnown,
      bb.targetId < 0
        ? '-'
        : `${bb.lastKnownX.toFixed(1)} ${bb.lastKnownY.toFixed(1)} ${bb.lastKnownZ.toFixed(1)} @ ${bb.lastKnownRange.toFixed(1)}m` +
            ` · v ${Math.hypot(bb.lastKnownVx, bb.lastKnownVz).toFixed(1)}`,
    );
    set(
      this.fSelInvestigate,
      bb.investigateValid
        ? `${bb.investigateX.toFixed(1)} ${bb.investigateZ.toFixed(1)} (${bb.investigateAge.toFixed(1)}s)`
        : 'none',
    );
    set(
      this.fSelReaction,
      bb.reactionPaid ? 'paid' : `${bb.reactionTimer.toFixed(2)}s · dmg ${bb.damageThisContact.toFixed(0)}`,
    );
    set(
      this.fSelAim,
      `${combat.aimErrorDeg.toFixed(2)}° / ${combat.aimOffSolutionDeg.toFixed(2)}° · burst ${combat.burstRemaining}` +
        `${combat.wantsFire ? ' FIRE' : ''}${combat.wantsAds ? ' ADS' : ''}`,
    );
    set(
      this.fSelGoal,
      `${brain.goal} ${brain.goalX.toFixed(1)} ${brain.goalZ.toFixed(1)}` +
        `${brain.coverSlot >= 0 ? ` · cover #${brain.coverSlot}` : ''}`,
    );
    set(
      this.fSelPath,
      `${bot.path.cursor}/${bot.path.count} · ${bot.path.remainingDistance(bot.px, bot.pz).toFixed(1)}m` +
        ` · stuck ${brain.stuckEvents} · replans ${brain.replans} · fails ${brain.pathFailures}`,
    );
    set(
      this.fSelScore,
      `${bot.kills}/${bot.deaths} · ${bot.shotsHit}/${bot.shotsFired}` +
        `${bot.shotsFired > 0 ? ` (${((bot.shotsHit / bot.shotsFired) * 100).toFixed(0)}%)` : ''}`,
    );
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'F4') {
      e.preventDefault();
      this.aiDebug.setEnabled(!this.aiDebug.isEnabled);
    } else if (e.code === 'F5') {
      // F5 is reload; this is a debug build and the tool is worth more than the refresh.
      e.preventDefault();
      this.cycleSelection();
    }
  };
}

// -- small helpers ----------------------------------------------------------

interface Slot {
  el: HTMLElement | null;
  last: string;
}

function field(): Slot {
  return { el: null, last: '' };
}

function bind(section: { addField(label: string): { el: HTMLElement } }, label: string, slot: Slot): void {
  slot.el = section.addField(label).el;
}

function set(slot: Slot, text: string): void {
  if (slot.el === null || slot.last === text) return;
  slot.last = text;
  slot.el.textContent = text;
}

function button(label: string, onClick: () => void): HTMLElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'dbg-btn dbg-btn--block';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function toggle(label: string, initial: boolean, onChange: (on: boolean) => void): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'dbg-toggle';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = initial;
  const text = document.createElement('span');
  text.textContent = label;
  input.addEventListener('change', () => onChange(input.checked));
  wrap.append(input, text);
  return wrap;
}

/**
 * Tier, perception and scheduler values are read live every tick straight off the config
 * objects the sliders write to, so there is nothing to push on change.
 */
function noop(): void {
  /* nothing to re-apply */
}
