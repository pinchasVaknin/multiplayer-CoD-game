import { NAV_DIRS, type NavGrid } from '../world/Navmesh';

/**
 * A* over the navmesh grid, with string-pulled smoothing (brief S6.5 / S6.6).
 *
 * Two properties matter more than the search itself.
 *
 * **It is resumable.** S6.6 requires a cap on A* node expansions per tick with the
 * overflow deferred, and you cannot defer a search that only exists inside one function
 * call. So the open set, the came-from chain and the score arrays live on the instance,
 * `begin` seeds a search and `expand(budget)` pushes it forward by at most `budget`
 * nodes, returning RUNNING when it has more to do. A search that needs 3000 expansions
 * costs eight quiet ticks instead of one 12 ms spike — and a bot that gets its path
 * 130 ms late is invisible, which is the whole trade S6.6 is asking for.
 *
 * **Only one search runs at a time.** That is what lets the working set be a single
 * allocation rather than one per bot: ten bots replanning at 3 Hz is thirty searches a
 * second, which is three per tick if they all landed together and they never do, because
 * `AiScheduler` staggers the requests. Requests queue; a client that asks again while
 * still queued replaces its own entry rather than adding a second.
 *
 * Scores are stamped rather than cleared. Clearing three arrays of 8000 floats per search
 * is cheap but it is not free, and it is exactly the sort of cost that shows up as a
 * sawtooth in a ten-minute soak.
 */

/** Waypoints a smoothed path may hold. Well past the diagonal of any M4 map at 0.5 m. */
export const MAX_WAYPOINTS = 64;

export const enum SearchState {
  Idle = 0,
  Running = 1,
  Found = 2,
  Failed = 3,
}

/**
 * A smoothed path, owned by its client and rewritten in place.
 *
 * `serial` is what makes a stale result harmless: the client bumps it on every request,
 * and a path written with an older serial is discarded rather than followed.
 */
export class Path {
  readonly x = new Float32Array(MAX_WAYPOINTS);
  readonly y = new Float32Array(MAX_WAYPOINTS);
  readonly z = new Float32Array(MAX_WAYPOINTS);
  count = 0;
  /** Waypoint the follower is currently steering toward. */
  cursor = 0;
  /** Grid cell the path was built toward, for "is my goal still current" tests. */
  goalIndex = -1;

  get complete(): boolean {
    return this.count > 0 && this.cursor >= this.count;
  }

  get active(): boolean {
    return this.count > 0 && this.cursor < this.count;
  }

  clear(): void {
    this.count = 0;
    this.cursor = 0;
    this.goalIndex = -1;
  }

  /** Straight-line remaining distance through the waypoints from `fromX/fromZ`. */
  remainingDistance(fromX: number, fromZ: number): number {
    if (!this.active) return 0;
    let px = fromX;
    let pz = fromZ;
    let total = 0;
    for (let i = this.cursor; i < this.count; i++) {
      const wx = this.x[i] ?? px;
      const wz = this.z[i] ?? pz;
      total += Math.hypot(wx - px, wz - pz);
      px = wx;
      pz = wz;
    }
    return total;
  }
}

export interface PathClient {
  /** Entity id, for the debug read-out and for de-duplicating queued requests. */
  readonly pathClientId: number;
  readonly path: Path;
  /** Called on the tick the search finished, before the bot's next steering tick. */
  onPathReady(found: boolean): void;
}

interface QueuedRequest {
  client: PathClient | null;
  start: number;
  goal: number;
}

/** How many outstanding requests are held. One per bot plus slack. */
const QUEUE_CAPACITY = 32;

export class Pathfinder {
  /** Nodes expanded during the current tick. Reset by `beginTick`. */
  nodesThisTick = 0;
  /** Requests still queued at the end of the last tick. Instrumentation (S7). */
  deferredRequests = 0;
  /** Cumulative count of ticks that ran out of budget with work left. */
  budgetExhaustedTicks = 0;
  /** Worst nodes-per-tick seen since the last reset. */
  worstNodesPerTick = 0;
  searchesCompleted = 0;
  searchesFailed = 0;

  private readonly grid: NavGrid;
  private readonly stepHeight: number;
  private readonly maxDrop: number;

  private readonly gScore: Float32Array;
  private readonly fScore: Float32Array;
  private readonly cameFrom: Int32Array;
  private readonly stamp: Int32Array;
  /** 1 = in the open heap, 2 = closed. Only meaningful when `stamp` is current. */
  private readonly nodeState: Uint8Array;
  private readonly heap: Int32Array;
  private readonly rawPath: Int32Array;
  private stampCounter = 0;
  private heapCount = 0;

  private readonly queue: QueuedRequest[] = [];
  private queueCount = 0;

  private state: SearchState = SearchState.Idle;
  private activeClient: PathClient | null = null;
  private activeStart = -1;
  private activeGoal = -1;
  private expansionsThisSearch = 0;

  constructor(grid: NavGrid, stepHeight: number, maxDrop: number) {
    this.grid = grid;
    this.stepHeight = stepHeight;
    this.maxDrop = maxDrop;
    const n = grid.cellCount;
    this.gScore = new Float32Array(n);
    this.fScore = new Float32Array(n);
    this.cameFrom = new Int32Array(n);
    this.stamp = new Int32Array(n);
    this.nodeState = new Uint8Array(n);
    this.heap = new Int32Array(n + 1);
    this.rawPath = new Int32Array(n);
    for (let i = 0; i < QUEUE_CAPACITY; i++) this.queue.push({ client: null, start: -1, goal: -1 });
  }

  get busy(): boolean {
    return this.state === SearchState.Running;
  }

  get pending(): number {
    return this.queueCount;
  }

  /**
   * Queue a search. Replaces this client's outstanding request if it has one, so a bot
   * that changes its mind twice in a second never has two searches owed to it.
   */
  request(client: PathClient, startIndex: number, goalIndex: number): void {
    if (startIndex < 0 || goalIndex < 0) {
      client.onPathReady(false);
      return;
    }
    for (let i = 0; i < this.queueCount; i++) {
      const entry = this.queue[i];
      if (entry === undefined || entry.client !== client) continue;
      entry.start = startIndex;
      entry.goal = goalIndex;
      return;
    }
    if (this.queueCount >= QUEUE_CAPACITY) {
      // The queue only fills if every bot asked on the same tick and none has been
      // served yet. Dropping the newest is right: it will ask again in 300 ms.
      this.deferredRequests++;
      return;
    }
    const slot = this.queue[this.queueCount];
    if (slot === undefined) return;
    slot.client = client;
    slot.start = startIndex;
    slot.goal = goalIndex;
    this.queueCount++;
  }

  /** Drop a client's queued request and abandon its search if it is the active one. */
  cancel(client: PathClient): void {
    for (let i = 0; i < this.queueCount; i++) {
      const entry = this.queue[i];
      if (entry === undefined || entry.client !== client) continue;
      const last = this.queue[this.queueCount - 1];
      if (last !== undefined) {
        entry.client = last.client;
        entry.start = last.start;
        entry.goal = last.goal;
      }
      this.queueCount--;
      break;
    }
    if (this.activeClient === client) {
      this.activeClient = null;
      this.state = SearchState.Idle;
    }
  }

  resetCounters(): void {
    this.worstNodesPerTick = 0;
    this.budgetExhaustedTicks = 0;
    this.searchesCompleted = 0;
    this.searchesFailed = 0;
  }

  /**
   * Spend up to `nodeBudget` expansions across the active search and any queued ones.
   * Called once per sim tick by `AiScheduler`.
   */
  step(nodeBudget: number): void {
    this.nodesThisTick = 0;
    let budget = nodeBudget;

    while (budget > 0) {
      if (this.state !== SearchState.Running && !this.beginNext()) break;
      const spent = this.expand(budget);
      budget -= spent;
      this.nodesThisTick += spent;
      if (this.state === SearchState.Running) break;
      this.finishActive();
    }

    if (this.nodesThisTick > this.worstNodesPerTick) this.worstNodesPerTick = this.nodesThisTick;
    this.deferredRequests = this.queueCount + (this.state === SearchState.Running ? 1 : 0);
    if (this.deferredRequests > 0 && budget <= 0) this.budgetExhaustedTicks++;
  }

  // -- search ---------------------------------------------------------------

  private beginNext(): boolean {
    if (this.queueCount === 0) return false;
    const entry = this.queue[0];
    if (entry === undefined || entry.client === null) {
      this.queueCount = 0;
      return false;
    }
    const client = entry.client;
    const start = entry.start;
    const goal = entry.goal;

    // Shift the queue down. It holds at most one entry per bot, so this is a handful.
    for (let i = 1; i < this.queueCount; i++) {
      const src = this.queue[i];
      const dst = this.queue[i - 1];
      if (src === undefined || dst === undefined) continue;
      dst.client = src.client;
      dst.start = src.start;
      dst.goal = src.goal;
    }
    this.queueCount--;
    const tail = this.queue[this.queueCount];
    if (tail !== undefined) tail.client = null;

    this.activeClient = client;
    this.activeStart = start;
    this.activeGoal = goal;
    this.expansionsThisSearch = 0;
    this.stampCounter++;
    this.heapCount = 0;

    if (start === goal) {
      this.state = SearchState.Found;
      return true;
    }

    this.touch(start);
    this.gScore[start] = 0;
    this.fScore[start] = this.heuristic(start, goal);
    this.nodeState[start] = 1;
    this.heapPush(start);
    this.state = SearchState.Running;
    return true;
  }

  /** Expand at most `budget` nodes. Returns how many were actually expanded. */
  private expand(budget: number): number {
    const grid = this.grid;
    const goal = this.activeGoal;
    let spent = 0;

    while (spent < budget) {
      if (this.heapCount === 0) {
        this.state = SearchState.Failed;
        return spent;
      }
      const current = this.heapPop();
      if (current === goal) {
        this.state = SearchState.Found;
        return spent;
      }
      this.nodeState[current] = 2;
      spent++;
      this.expansionsThisSearch++;

      const ix = grid.indexOfX(current);
      const iz = grid.indexOfZ(current);
      const gHere = this.gScore[current] ?? 0;

      for (let d = 0; d < 8; d++) {
        if (!grid.linked(current, d)) continue;
        const dir = NAV_DIRS[d];
        if (dir === undefined) continue;
        const jx = ix + dir.dx;
        const jz = iz + dir.dz;
        if (!grid.inBounds(jx, jz)) continue;
        const next = grid.index(jx, jz);
        this.touch(next);
        if (this.nodeState[next] === 2) continue;

        // Climbing costs more than flat ground so a bot prefers the ramp to the step
        // when both reach the same place, which reads as picking the sensible route.
        const rise = Math.abs((grid.height[next] ?? 0) - (grid.height[current] ?? 0));
        const cost = dir.cost * grid.cellSize + rise * 1.5;
        const tentative = gHere + cost;
        if (this.nodeState[next] === 1 && tentative >= (this.gScore[next] ?? Infinity)) continue;

        this.cameFrom[next] = current;
        this.gScore[next] = tentative;
        this.fScore[next] = tentative + this.heuristic(next, goal);
        if (this.nodeState[next] === 1) {
          this.heapUpdate(next);
        } else {
          this.nodeState[next] = 1;
          this.heapPush(next);
        }
      }
    }
    return spent;
  }

  private finishActive(): void {
    const client = this.activeClient;
    this.activeClient = null;
    const found = this.state === SearchState.Found;
    this.state = SearchState.Idle;
    if (client === null) return;

    if (!found) {
      this.searchesFailed++;
      client.path.clear();
      client.onPathReady(false);
      return;
    }

    const raw = this.reconstruct();
    this.smooth(client.path, raw);
    client.path.goalIndex = this.activeGoal;
    this.searchesCompleted++;
    client.onPathReady(client.path.count > 0);
  }

  /** Walk the came-from chain back from the goal, writing it forward into `rawPath`. */
  private reconstruct(): number {
    let node = this.activeGoal;
    let n = 0;
    const cap = this.rawPath.length;
    while (node !== this.activeStart && n < cap) {
      this.rawPath[n++] = node;
      const prev = this.cameFrom[node] ?? -1;
      if (prev < 0) break;
      node = prev;
    }
    if (n < cap) this.rawPath[n++] = this.activeStart;
    // Reverse in place: the chain was built goal-first.
    for (let i = 0, j = n - 1; i < j; i++, j--) {
      const tmp = this.rawPath[i] ?? 0;
      this.rawPath[i] = this.rawPath[j] ?? 0;
      this.rawPath[j] = tmp;
    }
    return n;
  }

  /**
   * String pulling: keep an anchor and advance a probe as long as the straight line from
   * the anchor is walkable. The last cell that still worked becomes a waypoint.
   *
   * A grid path is a staircase; a bot following it looks like it is following a grid. This
   * is the difference between "the AI moves" and "the AI walks somewhere".
   */
  private smooth(path: Path, rawCount: number): void {
    const grid = this.grid;
    path.clear();
    if (rawCount === 0) return;

    let anchor = this.rawPath[0] ?? 0;
    let probe = 1;
    let lastGood = anchor;

    while (probe < rawCount && path.count < MAX_WAYPOINTS - 1) {
      const candidate = this.rawPath[probe] ?? anchor;
      if (grid.lineWalkable(anchor, candidate, this.stepHeight, this.maxDrop)) {
        lastGood = candidate;
        probe++;
        continue;
      }
      // The line broke: commit the last reachable cell and restart from there.
      if (lastGood === anchor) {
        // Adjacent cell not line-reachable (a diagonal squeeze); take it directly.
        lastGood = candidate;
        probe++;
      }
      this.pushWaypoint(path, lastGood);
      anchor = lastGood;
    }

    const goal = this.rawPath[rawCount - 1] ?? anchor;
    if (path.count === 0 || anchor !== goal) this.pushWaypoint(path, goal);
  }

  private pushWaypoint(path: Path, cell: number): void {
    if (path.count >= MAX_WAYPOINTS) return;
    const grid = this.grid;
    const i = path.count;
    path.x[i] = grid.centerX(grid.indexOfX(cell));
    path.y[i] = grid.heightAt(cell);
    path.z[i] = grid.centerZ(grid.indexOfZ(cell));
    path.count++;
  }

  /** Octile distance, scaled to metres. Admissible for 8-connected movement. */
  private heuristic(from: number, to: number): number {
    const grid = this.grid;
    const dx = Math.abs(grid.indexOfX(from) - grid.indexOfX(to));
    const dz = Math.abs(grid.indexOfZ(from) - grid.indexOfZ(to));
    const lo = dx < dz ? dx : dz;
    const hi = dx < dz ? dz : dx;
    return (hi + (Math.SQRT2 - 1) * lo) * grid.cellSize;
  }

  /** Bring a node's score slots into the current search epoch without clearing arrays. */
  private touch(node: number): void {
    if (this.stamp[node] === this.stampCounter) return;
    this.stamp[node] = this.stampCounter;
    this.gScore[node] = Infinity;
    this.fScore[node] = Infinity;
    this.cameFrom[node] = -1;
    this.nodeState[node] = 0;
  }

  // -- binary min-heap over fScore -------------------------------------------

  private heapPush(node: number): void {
    let i = ++this.heapCount;
    this.heap[i] = node;
    this.heapSiftUp(i);
  }

  private heapPop(): number {
    const top = this.heap[1] ?? 0;
    const last = this.heap[this.heapCount] ?? 0;
    this.heapCount--;
    if (this.heapCount > 0) {
      this.heap[1] = last;
      this.heapSiftDown(1);
    }
    return top;
  }

  /** A node's score improved; it can only need to move up. */
  private heapUpdate(node: number): void {
    for (let i = 1; i <= this.heapCount; i++) {
      if (this.heap[i] !== node) continue;
      this.heapSiftUp(i);
      return;
    }
  }

  private heapSiftUp(from: number): void {
    let i = from;
    const node = this.heap[i] ?? 0;
    const score = this.fScore[node] ?? 0;
    while (i > 1) {
      const parent = i >> 1;
      const pNode = this.heap[parent] ?? 0;
      if ((this.fScore[pNode] ?? 0) <= score) break;
      this.heap[i] = pNode;
      i = parent;
    }
    this.heap[i] = node;
  }

  private heapSiftDown(from: number): void {
    let i = from;
    const node = this.heap[i] ?? 0;
    const score = this.fScore[node] ?? 0;
    for (;;) {
      let child = i << 1;
      if (child > this.heapCount) break;
      const rightChild = child + 1;
      if (rightChild <= this.heapCount) {
        const l = this.heap[child] ?? 0;
        const r = this.heap[rightChild] ?? 0;
        if ((this.fScore[r] ?? 0) < (this.fScore[l] ?? 0)) child = rightChild;
      }
      const cNode = this.heap[child] ?? 0;
      if ((this.fScore[cNode] ?? 0) >= score) break;
      this.heap[i] = cNode;
      i = child;
    }
    this.heap[i] = node;
  }
}
