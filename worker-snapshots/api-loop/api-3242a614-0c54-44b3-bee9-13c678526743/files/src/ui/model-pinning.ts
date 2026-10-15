/**
 * Model version pinning and the memory budget gate (goals 17-19). Pure and DOM-free: no fetch, no storage, no clock.
 * Digests come from the local Ollama listing; memory figures come from the existing systemResources snapshot.
 * Nothing here switches a model: it only says whether a switch needs the user's explicit "Use anyway".
 */
import type { ModelPinMap } from '../shared/contracts';

export type PinStatus = 'pinned-match' | 'pinned-mismatch' | 'pinned-missing' | 'unpinned';

export interface PinnableModel { name: string; digest?: string | null; sizeBytes?: number | null }

export interface PinEvaluation {
  name: string;
  status: PinStatus;
  installed: boolean;
  /** Digest reported by Ollama now; null when not installed or not reported. */
  currentDigest: string | null;
  /** Digest recorded at pin time; null when unpinned. */
  pinnedDigest: string | null;
  pinnedAt: string | null;
}

const norm = (n: string) => (n.includes(':') ? n : `${n}:latest`).toLowerCase();
const cleanDigest = (d: unknown): string | null => {
  if (typeof d !== 'string') return null;
  const s = d.trim().toLowerCase().replace(/^sha256:/, '');
  return /^[0-9a-f]{12,128}$/.test(s) ? s : null;
};

/**
 * One entry per installed model (in list order), then one 'pinned-missing' entry per pin whose model is no longer
 * installed. A pinned model whose current digest is unknown counts as a mismatch: the pinned version cannot be confirmed.
 */
export function evaluatePins(models: readonly PinnableModel[], pins: ModelPinMap | null | undefined): PinEvaluation[] {
  const pinEntries = Object.entries(pins ?? {}).filter(([, p]) => p && typeof p === 'object');
  const used = new Set<string>();
  const out: PinEvaluation[] = [];
  for (const m of models) {
    if (!m || typeof m.name !== 'string' || !m.name) continue;
    const current = cleanDigest(m.digest);
    const hit = pinEntries.find(([k]) => norm(k) === norm(m.name));
    if (!hit) { out.push({ name: m.name, status: 'unpinned', installed: true, currentDigest: current, pinnedDigest: null, pinnedAt: null }); continue; }
    used.add(hit[0]);
    const pinned = cleanDigest(hit[1].digest);
    out.push({ name: m.name, status: pinned && current && pinned === current ? 'pinned-match' : 'pinned-mismatch', installed: true, currentDigest: current, pinnedDigest: pinned, pinnedAt: typeof hit[1].pinnedAt === 'string' ? hit[1].pinnedAt : null });
  }
  for (const [name, p] of pinEntries) {
    if (used.has(name)) continue;
    out.push({ name, status: 'pinned-missing', installed: false, currentDigest: null, pinnedDigest: cleanDigest(p.digest), pinnedAt: typeof p.pinnedAt === 'string' ? p.pinnedAt : null });
  }
  return out;
}

/** First 12 hex characters, the short form Ollama itself prints. Empty for an unknown digest. */
export function shortDigest(d: string | null | undefined): string {
  const c = cleanDigest(d);
  return c ? c.slice(0, 12) : '';
}

export const PIN_STATUS_TEXT: Record<PinStatus, string> = {
  'pinned-match': 'Pinned version',
  'pinned-mismatch': 'Changed since pinned',
  'pinned-missing': 'Pinned, not installed',
  unpinned: 'Not pinned',
};

/** Plain explanation of a mismatch, with both short digests. */
export function mismatchExplanation(e: PinEvaluation): string {
  if (e.status !== 'pinned-mismatch') return '';
  if (!e.currentDigest) return `Pinned at ${shortDigest(e.pinnedDigest)}, but Ollama did not report a digest now, so the pinned version cannot be confirmed.`;
  return `Pinned at ${shortDigest(e.pinnedDigest)}, but Ollama now reports ${shortDigest(e.currentDigest)}. The model was replaced or updated after you pinned it.`;
}

export const DEFAULT_HEADROOM = 1.2;

export type BudgetReason = 'within-budget' | 'exceeds-budget' | 'exceeds-total-memory' | 'unmeasured';

export interface BudgetInput {
  sizeBytes: number | null | undefined;
  totalMemBytes: number | null | undefined;
  freeMemBytes?: number | null;
  /** Optional configured budget. Absent, zero or invalid means only host total memory applies. */
  budgetBytes?: number | null;
  /** Multiplier applied to the model file size. Values below 1 or non-finite fall back to 1.2. */
  headroomRatio?: number;
}

export interface BudgetCheck {
  ok: boolean;
  reason: BudgetReason;
  /** ceil(sizeBytes * headroomRatio); null when the size is unknown. */
  requiredBytes: number | null;
  /** The limit compared against: min(budget, total memory) of those that are known; null when neither is known. */
  availableBytes: number | null;
  headroomRatio: number;
  /** Which limit was the smaller one. */
  limit: 'budget' | 'total-memory' | null;
  /** True when the requirement is above current free memory (informational; never blocks by itself). Null when unknown. */
  exceedsFree: boolean | null;
}

const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/**
 * Blocks when size x headroom exceeds the configured budget or the host's total memory. Unknown size (or no known
 * limit at all) is never blocked: it returns ok with reason 'unmeasured', because nothing is estimated.
 */
export function checkMemoryBudget(input: BudgetInput): BudgetCheck {
  const headroomRatio = typeof input.headroomRatio === 'number' && Number.isFinite(input.headroomRatio) && input.headroomRatio >= 1 ? input.headroomRatio : DEFAULT_HEADROOM;
  const budget = positive(input.budgetBytes) ? input.budgetBytes : null;
  const total = positive(input.totalMemBytes) ? input.totalMemBytes : null;
  const free = typeof input.freeMemBytes === 'number' && Number.isFinite(input.freeMemBytes) && input.freeMemBytes >= 0 ? input.freeMemBytes : null;
  let availableBytes: number | null = null, limit: BudgetCheck['limit'] = null;
  if (budget !== null && (total === null || budget <= total)) { availableBytes = budget; limit = 'budget'; }
  else if (total !== null) { availableBytes = total; limit = 'total-memory'; }
  if (!positive(input.sizeBytes)) return { ok: true, reason: 'unmeasured', requiredBytes: null, availableBytes, headroomRatio, limit, exceedsFree: null };
  const requiredBytes = Math.ceil(input.sizeBytes * headroomRatio);
  const exceedsFree = free === null ? null : requiredBytes > free;
  if (availableBytes === null) return { ok: true, reason: 'unmeasured', requiredBytes, availableBytes, headroomRatio, limit, exceedsFree };
  if (requiredBytes <= availableBytes) return { ok: true, reason: 'within-budget', requiredBytes, availableBytes, headroomRatio, limit, exceedsFree };
  return { ok: false, reason: budget !== null && requiredBytes > budget ? 'exceeds-budget' : 'exceeds-total-memory', requiredBytes, availableBytes, headroomRatio, limit, exceedsFree };
}

/** Bytes as GiB with two decimals plus the exact byte count, e.g. "4.00 GB (4294967296 bytes)". */
export function exactBytes(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return 'unknown';
  return `${(n / 1024 ** 3).toFixed(2)} GB (${Math.round(n)} bytes)`;
}

/** One sentence per budget result, with the exact figures used. */
export function budgetExplanation(b: BudgetCheck, sizeBytes: number | null | undefined): string {
  if (b.reason === 'unmeasured') return b.requiredBytes === null ? 'The model size is not reported, so the memory check could not be made.' : 'Total memory is not measured and no budget is set, so the memory check could not be made.';
  const needs = `Needs ${exactBytes(b.requiredBytes)}: model ${exactBytes(positive(sizeBytes) ? sizeBytes : null)} x ${b.headroomRatio} headroom.`;
  const limit = `${b.limit === 'budget' ? 'Memory budget' : 'Total memory'}: ${exactBytes(b.availableBytes)}.`;
  if (b.ok) return `${needs} ${limit}`;
  return `${needs} ${limit} ${b.reason === 'exceeds-budget' ? 'This is over your memory budget.' : 'This is more than this computer has.'}`;
}

/** What the selection gate needs from the UI: whether a confirmation is required and the lines to show. */
export interface SwitchGate { confirm: boolean; reasons: string[] }

export function switchGate(evaluation: PinEvaluation | null | undefined, budget: BudgetCheck, sizeBytes: number | null | undefined): SwitchGate {
  const reasons: string[] = [];
  if (evaluation?.status === 'pinned-mismatch') reasons.push(mismatchExplanation(evaluation));
  if (!budget.ok) reasons.push(budgetExplanation(budget, sizeBytes));
  return { confirm: reasons.length > 0, reasons };
}
