// Goal 50 (reusing goal 31 checkpoints and goal 41 capsules): historical branches of a project.
// Pure and DOM-free. A branch is a NEW capsule created from a saved checkpoint of a source capsule; the branch record
// only remembers lineage (parent capsule + source checkpoint). Nothing here touches storage, network or the clock.

export const BRANCH_PREF_KEY = 'projectBranches.v1';
export const BRANCH_LIMITS = Object.freeze({ maxPerProject: 50, nameMin: 1, nameMax: 40, idChars: 120 });

export type BranchDraft = Readonly<{ id: string; name: string; parentCapsuleId: string; sourceCheckpointId: string; createdAt: string }>;
/** A persisted branch: the draft plus the id of the capsule that was created for it. */
export type BranchRecord = Readonly<BranchDraft & { capsuleId: string }>;

type Ref = { kind?: string; id: string };
export type BranchCheckpoint = { id: string; title?: string; createdAt?: string; capsuleId?: string; refs?: readonly Ref[] };
type Item = { kind: 'file' | 'folder' | 'url' | 'app'; target: string; label: string };
type Goal = { id?: string; text: string; done?: boolean };
type Reference = { id?: string; kind: 'file' | 'folder' | 'url' | 'note' | 'task'; target: string; label?: string; note?: string };
/** Structural subset of Capsule plus its optional productivity metadata (goals/references). Extra fields are ignored. */
export type BranchSourceCapsule = { id: string; name: string; description?: string; scene?: string; items?: readonly Item[]; goals?: readonly Goal[]; references?: readonly Reference[] };

export type NewCapsuleInput = {
  name: string;
  description: string;
  scene: string;
  items: Item[];
  goals: { text: string; done: boolean }[];
  references: { kind: Reference['kind']; target: string; label: string; note?: string }[];
};

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const validId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= BRANCH_LIMITS.idChars && !/[\u0000-\u001f]/.test(v);

/** Trims and validates a branch name; throws a descriptive Error. */
export function validateBranchName(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('Branch name must be text');
  const name = raw.trim();
  const len = Array.from(name).length;
  if (len < BRANCH_LIMITS.nameMin) throw new Error('Branch name is required');
  if (len > BRANCH_LIMITS.nameMax) throw new Error(`Branch name must be at most ${BRANCH_LIMITS.nameMax} characters (got ${len})`);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('Branch name must not contain control characters');
  return name;
}

function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** URL targets that embed credentials (user:pass@ or token-like query keys) are never copied into a branch. */
function looksSecret(kind: string, target: string): boolean {
  if (kind !== 'url') return false;
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(target)) return true;
  return /[?&#](access_token|api[_-]?key|apikey|token|secret|password|passwd|auth|sig|signature|key)=/i.test(target);
}

/**
 * Plans a branch. Returns the lineage record (without the new capsule id, which only exists after saving) and the
 * capsule input to save. Goals/references are copied when the checkpoint referenced them; when the checkpoint has no
 * specific refs (empty, or only the capsule itself) everything is copied. Ids, timestamps, window geometry and any
 * other runtime data are never copied; URL targets carrying credentials are dropped.
 */
export function createBranchFromCheckpoint(args: {
  checkpoint: BranchCheckpoint | null | undefined;
  sourceCapsule: BranchSourceCapsule | null | undefined;
  name: unknown;
  now: string;
  existing?: readonly BranchRecord[];
}): { branchRecord: BranchDraft; newCapsuleInput: NewCapsuleInput } {
  const { checkpoint, sourceCapsule, now } = args ?? ({} as typeof args);
  if (!checkpoint || !validId(checkpoint.id)) throw new Error('Branch: the source checkpoint was not found (it may have been deleted)');
  if (!sourceCapsule || !validId(sourceCapsule.id)) throw new Error('Branch: the source capsule was not found (it may have been deleted)');
  if (checkpoint.capsuleId !== undefined && checkpoint.capsuleId !== sourceCapsule.id) throw new Error(`Branch: checkpoint ${checkpoint.id} belongs to another capsule`);
  const name = validateBranchName(args.name);
  const t = typeof now === 'string' ? Date.parse(now) : NaN;
  if (Number.isNaN(t)) throw new Error(`Branch: now must be a valid date string, got ${String(now)}`);
  const siblings = normalizeBranches(args.existing ?? []).filter((b) => b.parentCapsuleId === sourceCapsule.id);
  if (siblings.length >= BRANCH_LIMITS.maxPerProject) throw new Error(`Branch limit reached: a project holds at most ${BRANCH_LIMITS.maxPerProject} branches`);
  const lower = name.toLowerCase();
  if (siblings.some((b) => b.name.toLowerCase() === lower)) throw new Error(`A branch named “${name}” already exists in this project`);

  const refs = (Array.isArray(checkpoint.refs) ? checkpoint.refs : []).filter((r) => r && typeof r.id === 'string');
  const specific = new Set(refs.filter((r) => !(r.kind === 'capsule' && r.id === sourceCapsule.id)).map((r) => r.id));
  const all = specific.size === 0;
  const goals = (Array.isArray(sourceCapsule.goals) ? sourceCapsule.goals : [])
    .filter((g) => g && typeof g.text === 'string' && g.text.trim() && (all || (typeof g.id === 'string' && specific.has(g.id))))
    .map((g) => ({ text: g.text, done: g.done === true }));
  const references = (Array.isArray(sourceCapsule.references) ? sourceCapsule.references : [])
    .filter((r) => r && typeof r.target === 'string' && ['file', 'folder', 'url', 'note', 'task'].includes(r.kind) && !looksSecret(r.kind, r.target))
    .filter((r) => all || (typeof r.id === 'string' && specific.has(r.id)) || ((r.kind === 'note' || r.kind === 'task') && specific.has(r.target)))
    .map((r) => ({ kind: r.kind, target: r.target, label: str(r.label), ...(typeof r.note === 'string' && r.note ? { note: r.note } : {}) }));
  const items = (Array.isArray(sourceCapsule.items) ? sourceCapsule.items : [])
    .filter((i) => i && typeof i.target === 'string' && ['file', 'folder', 'url', 'app'].includes(i.kind) && !looksSecret(i.kind, i.target))
    .map((i) => ({ kind: i.kind, target: i.target, label: str(i.label) }));

  const createdAt = new Date(t).toISOString();
  const branchRecord: BranchDraft = {
    id: `branch-${t.toString(36)}-${hash(`${checkpoint.id}|${sourceCapsule.id}|${lower}`)}`,
    name,
    parentCapsuleId: sourceCapsule.id,
    sourceCheckpointId: checkpoint.id,
    createdAt,
  };
  const cpTitle = str(checkpoint.title).trim();
  const description = `Branch of “${str(sourceCapsule.name).trim() || 'Untitled capsule'}” from checkpoint “${cpTitle || checkpoint.id}”.`.slice(0, 400);
  return { branchRecord, newCapsuleInput: { name, description, scene: str(sourceCapsule.scene) || 'deep-space', items, goals, references } };
}

/** Completes a planned branch with the id of the capsule that was saved for it. */
export function attachBranchCapsule(draft: BranchDraft, capsuleId: string): BranchRecord {
  if (!validId(capsuleId)) throw new Error('Branch: the new capsule id is missing');
  return { id: draft.id, name: draft.name, parentCapsuleId: draft.parentCapsuleId, sourceCheckpointId: draft.sourceCheckpointId, createdAt: draft.createdAt, capsuleId };
}

const byTime = (a: BranchRecord, b: BranchRecord) => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id);

/**
 * Validates persisted branch records. Malformed records, duplicate ids, duplicate branch capsules, duplicate names
 * within a project (case-insensitive) and records over the per-project limit are dropped. Output is sorted by
 * createdAt then id and contains only known fields.
 */
export function normalizeBranches(raw: unknown): BranchRecord[] {
  if (!Array.isArray(raw)) return [];
  const clean: BranchRecord[] = [];
  for (const r of raw) {
    if (!isRec(r)) continue;
    if (!validId(r.id) || !validId(r.parentCapsuleId) || !validId(r.sourceCheckpointId) || !validId(r.capsuleId)) continue;
    if (r.capsuleId === r.parentCapsuleId) continue;
    let name: string;
    try { name = validateBranchName(r.name); } catch { continue; }
    const t = typeof r.createdAt === 'string' ? Date.parse(r.createdAt) : NaN;
    if (Number.isNaN(t)) continue;
    clean.push({ id: r.id, name, parentCapsuleId: r.parentCapsuleId, sourceCheckpointId: r.sourceCheckpointId, createdAt: new Date(t).toISOString(), capsuleId: r.capsuleId });
  }
  clean.sort(byTime);
  const ids = new Set<string>(), caps = new Set<string>(), names = new Set<string>();
  const perParent = new Map<string, number>();
  const out: BranchRecord[] = [];
  for (const b of clean) {
    const nk = `${b.parentCapsuleId}\u0000${b.name.toLowerCase()}`;
    const n = perParent.get(b.parentCapsuleId) ?? 0;
    if (ids.has(b.id) || caps.has(b.capsuleId) || names.has(nk) || n >= BRANCH_LIMITS.maxPerProject) continue;
    ids.add(b.id); caps.add(b.capsuleId); names.add(nk); perParent.set(b.parentCapsuleId, n + 1);
    out.push(b);
  }
  return out;
}

export type BranchGraphNode = Readonly<{ id: string; kind: 'capsule' | 'checkpoint'; refId: string; label: string; capsuleId: string | null; at: string | null }>;
export type BranchGraphEdge = Readonly<{ from: string; to: string; kind: 'branch'; branchId: string }>;
export type BranchLane = Readonly<{ capsuleId: string; parentCapsuleId: string | null; branchId: string | null; depth: number }>;
export type BranchGraph = Readonly<{
  nodes: readonly BranchGraphNode[];
  edges: readonly BranchGraphEdge[];
  lanes: readonly BranchLane[];
  broken: readonly Readonly<{ branchId: string; reason: string }>[];
}>;

/** Same id scheme as project-map's mapNodeId so the edges can be drawn on the project map. */
const nodeId = (kind: 'capsule' | 'checkpoint', id: string) => `${kind}:${id}`;

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
}

/**
 * Deterministic lineage graph: capsule nodes sorted by id, checkpoint nodes in time order (undated last, ties by id),
 * one 'branch' edge per branch from its source checkpoint to its branch capsule, and lineage lanes (depth-first from
 * root capsules, children by branch time). Branches whose capsule or checkpoint is missing are listed in `broken`.
 * The result does not depend on input order.
 */
export function buildBranchGraph(capsules: readonly { id: string; name?: string }[], checkpoints: readonly BranchCheckpoint[], branches: unknown): BranchGraph {
  const capList = (Array.isArray(capsules) ? capsules : []).filter((c) => c && validId(c.id));
  const capMap = new Map<string, { id: string; name?: string }>();
  for (const c of [...capList].sort((a, b) => cmp(a.id, b.id) || cmp(str(a.name), str(b.name)))) if (!capMap.has(c.id)) capMap.set(c.id, c);
  const capIds = [...capMap.keys()];

  const cpMap = new Map<string, BranchCheckpoint>();
  const cpSorted = (Array.isArray(checkpoints) ? checkpoints : []).filter((c) => c && validId(c.id)).sort((a, b) => cmp(a.id, b.id) || cmp(str(a.createdAt), str(b.createdAt)) || cmp(str(a.title), str(b.title)));
  for (const c of cpSorted) if (!cpMap.has(c.id)) cpMap.set(c.id, c);
  const ms = (c: BranchCheckpoint) => { const t = Date.parse(str(c.createdAt)); return Number.isNaN(t) ? Infinity : t; };
  const cps = [...cpMap.values()].sort((a, b) => (ms(a) === ms(b) ? 0 : ms(a) < ms(b) ? -1 : 1) || cmp(a.id, b.id));

  const nodes: BranchGraphNode[] = [
    ...capIds.map((id) => ({ id: nodeId('capsule', id), kind: 'capsule' as const, refId: id, label: str(capMap.get(id)?.name) || 'Untitled capsule', capsuleId: id, at: null })),
    ...cps.map((c) => ({ id: nodeId('checkpoint', c.id), kind: 'checkpoint' as const, refId: c.id, label: str(c.title) || 'Untitled checkpoint', capsuleId: typeof c.capsuleId === 'string' ? c.capsuleId : null, at: Number.isFinite(ms(c)) ? new Date(ms(c)).toISOString() : null })),
  ];

  const edges: BranchGraphEdge[] = [];
  const broken: { branchId: string; reason: string }[] = [];
  const parentOf = new Map<string, { parent: string; branchId: string; createdAt: string }>();
  for (const b of normalizeBranches(branches)) {
    if (!capMap.has(b.capsuleId)) { broken.push({ branchId: b.id, reason: 'branch capsule was deleted' }); continue; }
    if (!cpMap.has(b.sourceCheckpointId)) broken.push({ branchId: b.id, reason: 'source checkpoint was deleted' });
    else edges.push({ from: nodeId('checkpoint', b.sourceCheckpointId), to: nodeId('capsule', b.capsuleId), kind: 'branch', branchId: b.id });
    if (capMap.has(b.parentCapsuleId)) parentOf.set(b.capsuleId, { parent: b.parentCapsuleId, branchId: b.id, createdAt: b.createdAt });
  }
  // Break cycles (only possible with hand-edited prefs): a capsule whose ancestry loops back to itself becomes a root.
  for (const id of capIds) {
    const seen = new Set<string>([id]);
    let cur = parentOf.get(id)?.parent;
    while (cur !== undefined) {
      if (seen.has(cur)) { parentOf.delete(id); break; }
      seen.add(cur);
      cur = parentOf.get(cur)?.parent;
    }
  }
  const children = new Map<string, string[]>();
  for (const [child, p] of parentOf) children.set(p.parent, [...(children.get(p.parent) ?? []), child]);
  for (const list of children.values()) list.sort((a, b) => cmp(parentOf.get(a)!.createdAt, parentOf.get(b)!.createdAt) || cmp(a, b));
  const lanes: BranchLane[] = [];
  const walk = (id: string, depth: number) => {
    const p = parentOf.get(id);
    lanes.push({ capsuleId: id, parentCapsuleId: p?.parent ?? null, branchId: p?.branchId ?? null, depth });
    for (const c of children.get(id) ?? []) walk(c, depth + 1);
  };
  for (const id of capIds) if (!parentOf.has(id)) walk(id, 0);

  return deepFreeze({ nodes, edges, lanes, broken });
}

export type RestoreBranchResult = { ok: true; capsuleId: string } | { ok: false; error: string };

/** The capsule to activate for a branch, or a descriptive error when the record is invalid or its capsule was deleted. */
export function restoreBranchTarget(branch: BranchRecord | null | undefined, capsules: readonly { id: string }[]): RestoreBranchResult {
  if (!branch || !validId(branch.capsuleId)) return { ok: false, error: 'This branch record is incomplete and cannot be opened' };
  if (!(Array.isArray(capsules) ? capsules : []).some((c) => c && c.id === branch.capsuleId)) {
    return { ok: false, error: `The capsule for branch “${str(branch.name) || branch.id}” was deleted; it cannot be opened` };
  }
  return { ok: true, capsuleId: branch.capsuleId };
}
