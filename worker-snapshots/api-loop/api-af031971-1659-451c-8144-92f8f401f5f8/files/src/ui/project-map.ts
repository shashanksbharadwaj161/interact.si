// Goal 50: spatial project map with historical branches. Pure and DOM-free: lays out the user's REAL capsules,
// checkpoints and tasks as lanes on a 2D plane. Nothing is invented; records without a lane are not drawn.
// No network, no model, no clock unless a single dated checkpoint needs a fallback range and opts.now is omitted.

export const MAP_LIMITS = Object.freeze({ capsules: 100, nodesPerCapsule: 200, labelChars: 60 });

export type MapNodeKind = 'capsule' | 'checkpoint' | 'task';
export type MapNode = Readonly<{ id: string; kind: MapNodeKind; label: string; x: number; y: number; at: string | null; refs: number }>;
/** lineage is present only for branch capsules when a branch graph was given (depth counts from the drawn root). */
export type MapLane = Readonly<{ capsuleId: string; name: string; y: number; nodes: readonly MapNode[]; lineage?: Readonly<{ parentCapsuleId: string; depth: number }> }>;
export type MapEdge = Readonly<{ from: string; to: string; kind: 'timeline' | 'reference' | 'branch' }>;
/** Structural subset of project-branches' BranchGraph (built by buildBranchGraph and passed in by the caller). */
export type MapBranchGraph = {
  edges?: readonly { from: string; to: string; kind?: string }[];
  lanes?: readonly { capsuleId: string; parentCapsuleId: string | null }[];
};
export type ProjectMap = Readonly<{
  lanes: readonly MapLane[];
  edges: readonly MapEdge[];
  timeRange: Readonly<{ since: string; until: string }> | null;
  truncated: Readonly<{ capsules: number; nodes: number }>;
}>;

/** Structural subsets of Capsule, Checkpoint (productivity store) and Task. Extra fields are ignored. */
export type ProjectMapInput = {
  capsules: readonly { id: string; name: string; goals?: readonly unknown[]; items?: readonly unknown[] }[];
  checkpoints?: readonly { id: string; title: string; createdAt?: string; capsuleId?: string; refs?: readonly { kind?: string; id: string }[] }[];
  tasks?: readonly { id: string; title: string; done?: boolean; capsuleId?: string }[];
  /** Optional lineage from buildBranchGraph: branch lanes are placed under their parent and 'branch' edges are drawn. */
  branchGraph?: MapBranchGraph | null;
};
export type ProjectMapOptions = { width: number; height: number; now?: string; selectedCapsuleId?: string };

const PAD = 16;
const GUTTER = 120; // capsule node column + lane label
const UNDATED_W = 96; // trailing column for undated checkpoints and tasks
const DAY = 86_400_000;

/** Node id prefixes keep capsule, checkpoint and task ids from colliding. */
export const mapNodeId = (kind: MapNodeKind, id: string) => `${kind}:${id}`;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function truncateLabel(text: unknown, fallback = 'Untitled'): string {
  const t = str(text).replace(/\s+/g, ' ').trim() || fallback;
  const chars = Array.from(t);
  return chars.length > MAP_LIMITS.labelChars ? `${chars.slice(0, MAP_LIMITS.labelChars - 1).join('')}…` : t;
}

function dateMs(v: unknown): number {
  if (typeof v !== 'string' || !v.trim()) return NaN;
  return Date.parse(v);
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
}

type Pending = { id: string; kind: MapNodeKind; label: string; t: number; at: string | null; refs: number; refIds: string[]; key: string };

/**
 * Builds a frozen, deterministic map. Lanes are capsules sorted by name then id (max MAP_LIMITS.capsules; the selected
 * capsule is kept even when it would be cut). Each lane holds its capsule node, its checkpoints placed on x by createdAt
 * within timeRange, then undated checkpoints and tasks with a matching capsuleId in a trailing column (at:null).
 * 'timeline' edges chain each lane's dated checkpoints in time order; 'reference' edges link a checkpoint to another
 * lane when one of its refs names that lane's capsule or one of its nodes. Throws on invalid size, inputs or now.
 */
export function buildProjectMap(input: ProjectMapInput, opts: ProjectMapOptions): ProjectMap {
  if (!input || typeof input !== 'object') throw new Error('Project map: input must be an object with capsules, checkpoints and tasks');
  if (!Array.isArray(input.capsules)) throw new Error('Project map: capsules must be an array');
  if (input.checkpoints !== undefined && !Array.isArray(input.checkpoints)) throw new Error('Project map: checkpoints must be an array');
  if (input.tasks !== undefined && !Array.isArray(input.tasks)) throw new Error('Project map: tasks must be an array');
  if (!opts || typeof opts !== 'object') throw new Error('Project map: options with width and height are required');
  const { width, height } = opts;
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) throw new Error(`Project map: width must be a positive number, got ${String(width)}`);
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) throw new Error(`Project map: height must be a positive number, got ${String(height)}`);
  let nowMs: number | undefined;
  if (opts.now !== undefined) {
    nowMs = dateMs(opts.now);
    if (Number.isNaN(nowMs)) throw new Error(`Project map: now must be a valid date string, got ${String(opts.now)}`);
  }

  // Lanes: unique capsules with a string id, sorted by name then id.
  const seenCaps = new Set<string>();
  const caps = input.capsules
    .filter((c) => c && typeof c.id === 'string' && c.id && !seenCaps.has(c.id) && (seenCaps.add(c.id), true))
    .map((c) => ({ id: c.id, name: str(c.name), items: Array.isArray(c.items) ? c.items.length : 0 }))
    .sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id));
  let kept = caps.slice(0, MAP_LIMITS.capsules);
  const sel = opts.selectedCapsuleId;
  if (sel && caps.length > MAP_LIMITS.capsules && !kept.some((c) => c.id === sel)) {
    const s = caps.find((c) => c.id === sel);
    if (s) kept = [...kept.slice(0, MAP_LIMITS.capsules - 1), s].sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id));
  }
  const truncatedCapsules = caps.length - kept.length;
  // Lineage lanes: with a branch graph, each branch capsule follows its parent (depth-first, siblings by name then id).
  const lineage = new Map<string, { parentCapsuleId: string; depth: number }>();
  const bg = input.branchGraph;
  if (bg && Array.isArray(bg.lanes) && bg.lanes.length) {
    const inKept = new Set(kept.map((c) => c.id));
    const parent = new Map<string, string>();
    for (const l of bg.lanes) {
      if (l && typeof l.capsuleId === 'string' && typeof l.parentCapsuleId === 'string' && inKept.has(l.capsuleId) && inKept.has(l.parentCapsuleId) && l.capsuleId !== l.parentCapsuleId) parent.set(l.capsuleId, l.parentCapsuleId);
    }
    const ordered: typeof kept = [];
    const placed = new Set<string>();
    const visit = (c: (typeof kept)[number], depth: number) => {
      if (placed.has(c.id)) return;
      placed.add(c.id);
      ordered.push(c);
      if (depth > 0) lineage.set(c.id, { parentCapsuleId: parent.get(c.id) as string, depth });
      for (const child of kept) if (parent.get(child.id) === c.id) visit(child, depth + 1);
    };
    for (const c of kept) if (!parent.has(c.id)) visit(c, 0);
    for (const c of kept) visit(c, 0); // cycles in hand-edited data: anything left becomes a root
    kept = ordered;
  }
  const laneOf = new Map(kept.map((c, i) => [c.id, i]));

  // Collect per-lane nodes.
  const perLane: Pending[][] = kept.map((c) => [{ id: mapNodeId('capsule', c.id), kind: 'capsule', label: truncateLabel(c.name, 'Untitled capsule'), t: NaN, at: null, refs: c.items, refIds: [], key: '' }]);
  const seenCp = new Set<string>();
  for (const cp of input.checkpoints ?? []) {
    if (!cp || typeof cp.id !== 'string' || !cp.id || seenCp.has(cp.id)) continue;
    seenCp.add(cp.id);
    const lane = typeof cp.capsuleId === 'string' ? laneOf.get(cp.capsuleId) : undefined;
    if (lane === undefined) continue;
    const t = dateMs(cp.createdAt);
    type Ref = { kind?: string; id: string };
    const rawRefs: readonly Ref[] = Array.isArray(cp.refs) ? (cp.refs as readonly Ref[]) : [];
    const refs = rawRefs.filter((r: Ref) => r && typeof r.id === 'string');
    perLane[lane].push({ id: mapNodeId('checkpoint', cp.id), kind: 'checkpoint', label: truncateLabel(cp.title, 'Untitled checkpoint'), t, at: Number.isNaN(t) ? null : (cp.createdAt as string), refs: refs.length, refIds: refs.map((r) => r.id), key: cp.id });
  }
  const seenTask = new Set<string>();
  for (const tk of input.tasks ?? []) {
    if (!tk || typeof tk.id !== 'string' || !tk.id || seenTask.has(tk.id)) continue;
    seenTask.add(tk.id);
    const lane = typeof tk.capsuleId === 'string' ? laneOf.get(tk.capsuleId) : undefined;
    if (lane === undefined) continue;
    perLane[lane].push({ id: mapNodeId('task', tk.id), kind: 'task', label: truncateLabel(`${tk.done ? '✓ ' : ''}${str(tk.title)}`, 'Untitled task'), t: NaN, at: null, refs: 0, refIds: [], key: tk.id });
  }

  // Order inside a lane: capsule, dated checkpoints by time, undated checkpoints, tasks; then cap the count.
  const rank = (p: Pending) => (p.kind === 'capsule' ? 0 : p.kind === 'checkpoint' ? (p.at !== null ? 1 : 2) : 3);
  let truncatedNodes = 0;
  const lists = perLane.map((list) => {
    list.sort((a, b) => rank(a) - rank(b) || (rank(a) === 1 ? a.t - b.t : 0) || cmp(a.key, b.key));
    if (list.length > MAP_LIMITS.nodesPerCapsule) {
      truncatedNodes += list.length - MAP_LIMITS.nodesPerCapsule;
      return list.slice(0, MAP_LIMITS.nodesPerCapsule);
    }
    return list;
  });

  // Time range over the drawn dated checkpoints.
  let min = Infinity, max = -Infinity;
  for (const list of lists) for (const p of list) if (p.at !== null) { min = Math.min(min, p.t); max = Math.max(max, p.t); }
  let timeRange: { since: string; until: string } | null = null;
  if (Number.isFinite(min)) {
    if (min === max) {
      const now = nowMs ?? Date.now();
      if (now > min) max = now;
      else if (now < min) min = now;
      else { min -= DAY; max += DAY; }
    }
    timeRange = { since: new Date(min).toISOString(), until: new Date(max).toISOString() };
  }

  // Geometry.
  const laneH = (height - 2 * PAD) / Math.max(1, kept.length);
  const capX = Math.round(Math.min(PAD + GUTTER / 3, width / 2));
  const x0 = Math.min(PAD + GUTTER, width);
  const undatedStart = Math.max(x0, width - PAD - UNDATED_W);
  const x1 = Math.max(x0, undatedStart - PAD);
  const span = max - min;

  const lanes: MapLane[] = [];
  const nodeLane = new Map<string, number>();
  lists.forEach((list, i) => {
    const y = Math.round(PAD + (i + 0.5) * laneH);
    const trailing = list.filter((p) => p.kind !== 'capsule' && p.at === null);
    const nodes: MapNode[] = list.map((p) => {
      let x: number;
      if (p.kind === 'capsule') x = capX;
      else if (p.at !== null) x = span > 0 ? x0 + ((p.t - min) / span) * (x1 - x0) : x0;
      else x = undatedStart + ((trailing.indexOf(p) + 0.5) / trailing.length) * (width - PAD - undatedStart);
      nodeLane.set(p.id, i);
      return { id: p.id, kind: p.kind, label: p.label, x: Math.round(x), y, at: p.at, refs: p.refs };
    });
    const lin = lineage.get(kept[i].id);
    lanes.push({ capsuleId: kept[i].id, name: truncateLabel(kept[i].name, 'Untitled capsule'), y, nodes, ...(lin ? { lineage: { ...lin } } : {}) });
  });

  // Edges: timeline chains, then cross-lane references (deduplicated, deterministic order).
  const edges: MapEdge[] = [];
  const seenEdge = new Set<string>();
  const addEdge = (from: string, to: string, kind: MapEdge['kind']) => {
    const k = `${kind}|${from}|${to}`;
    if (from === to || seenEdge.has(k)) return;
    seenEdge.add(k);
    edges.push({ from, to, kind });
  };
  lists.forEach((list) => {
    const dated = list.filter((p) => p.kind === 'checkpoint' && p.at !== null);
    for (let j = 1; j < dated.length; j++) addEdge(dated[j - 1].id, dated[j].id, 'timeline');
  });
  lists.forEach((list, i) => {
    for (const p of list) {
      if (p.kind !== 'checkpoint') continue;
      for (const ref of p.refIds) {
        const capLane = laneOf.get(ref);
        if (capLane !== undefined && capLane !== i) { addEdge(p.id, mapNodeId('capsule', ref), 'reference'); continue; }
        for (const kind of ['checkpoint', 'task'] as const) {
          const target = mapNodeId(kind, ref);
          const l = nodeLane.get(target);
          if (l !== undefined && l !== i) addEdge(p.id, target, 'reference');
        }
      }
    }
  });
  // Branch edges: source checkpoint -> branch capsule, only when both ends are drawn.
  if (bg && Array.isArray(bg.edges)) {
    const branchEdges = bg.edges
      .filter((e) => e && (e.kind === undefined || e.kind === 'branch') && typeof e.from === 'string' && typeof e.to === 'string' && nodeLane.has(e.from) && nodeLane.has(e.to))
      .map((e) => ({ from: e.from, to: e.to }))
      .sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to));
    for (const e of branchEdges) addEdge(e.from, e.to, 'branch');
  }

  return deepFreeze({ lanes, edges, timeRange, truncated: { capsules: truncatedCapsules, nodes: truncatedNodes } });
}

export type MapKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

/**
 * Roving-focus helper. Returns the next node id or null when the key is not handled or there is nowhere to go.
 * Left/Right move within the lane by x; Up/Down go to the nearest-x node in the adjacent lane; Home/End go to the first
 * or last node of the current lane. An unknown currentId starts at the first node of the first lane.
 */
export function mapKeyboardTarget(map: ProjectMap, currentId: string | null | undefined, key: string): string | null {
  if (!map || !Array.isArray(map.lanes as unknown)) return null;
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) return null;
  const lanes = map.lanes.filter((l) => l.nodes.length > 0);
  if (!lanes.length) return null;
  const sorted = (l: MapLane) => l.nodes.map((n, i) => ({ n, i })).sort((a, b) => a.n.x - b.n.x || a.i - b.i).map((e) => e.n);
  const li = lanes.findIndex((l) => l.nodes.some((n) => n.id === currentId));
  if (li < 0) return sorted(lanes[0])[0].id;
  const row = sorted(lanes[li]);
  const pos = row.findIndex((n) => n.id === currentId);
  const cur = row[pos];
  const pick = (id: string | undefined) => (id && id !== currentId ? id : null);
  switch (key) {
    case 'ArrowLeft': return pick(row[pos - 1]?.id);
    case 'ArrowRight': return pick(row[pos + 1]?.id);
    case 'Home': return pick(row[0].id);
    case 'End': return pick(row[row.length - 1].id);
    default: {
      const other = lanes[li + (key === 'ArrowUp' ? -1 : 1)];
      if (!other) return null;
      let best: MapNode | null = null;
      for (const n of sorted(other)) if (!best || Math.abs(n.x - cur.x) < Math.abs(best.x - cur.x)) best = n;
      return pick(best?.id);
    }
  }
}
