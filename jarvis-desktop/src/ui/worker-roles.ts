// Pure, DOM-free worker role definitions for the Developer task board.
// Roles only describe the intended scope of a task record. Nothing here launches workers,
// contacts a network, calls a model or runs commands.

export type ToolScope = 'read-files' | 'edit-files' | 'run-tests' | 'write-docs' | 'none';
export type WorkerRoleId = 'planner' | 'implementer' | 'reviewer' | 'tester' | 'docs';

export type WorkerRole = {
  readonly id: WorkerRoleId;
  readonly label: string;
  readonly purpose: string;
  readonly toolScopes: readonly ToolScope[];
  readonly allowedModels: readonly string[];
  readonly defaultModel: string;
};

/** Model IDs offered by the Developer task board model select. */
export const KNOWN_MODELS: readonly string[] = Object.freeze(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']);
export const TOOL_SCOPES: readonly ToolScope[] = Object.freeze(['read-files', 'edit-files', 'run-tests', 'write-docs', 'none'] as ToolScope[]);
export const ROLE_PREF_KEY = 'developer.roleOverrides';

const role = (r: WorkerRole): WorkerRole =>
  Object.freeze({ ...r, toolScopes: Object.freeze([...r.toolScopes]), allowedModels: Object.freeze([...r.allowedModels]) });

export const WORKER_ROLES: readonly WorkerRole[] = Object.freeze([
  role({
    id: 'planner',
    label: 'Planner',
    purpose: 'Breaks a goal into ordered tasks and records the plan.',
    toolScopes: ['read-files', 'write-docs'],
    allowedModels: ['claude-opus-5-5', 'claude-sonnet-5-5'],
    defaultModel: 'claude-opus-5-5',
  }),
  role({
    id: 'implementer',
    label: 'Implementer',
    purpose: 'Makes the code change for one task and checks it with the test suite.',
    toolScopes: ['read-files', 'edit-files', 'run-tests'],
    allowedModels: ['claude-opus-5-5', 'claude-sonnet-5-5'],
    defaultModel: 'claude-sonnet-5-5',
  }),
  role({
    id: 'reviewer',
    label: 'Reviewer',
    purpose: 'Reads a finished change and reports problems without editing it.',
    toolScopes: ['read-files'],
    allowedModels: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    defaultModel: 'claude-sonnet-5-5',
  }),
  role({
    id: 'tester',
    label: 'Tester',
    purpose: 'Runs the existing tests and records which ones pass or fail.',
    toolScopes: ['read-files', 'run-tests'],
    allowedModels: ['claude-sonnet-5-5', 'claude-haiku-5-5'],
    defaultModel: 'claude-haiku-5-5',
  }),
  role({
    id: 'docs',
    label: 'Docs writer',
    purpose: 'Updates user and developer documentation to match a change.',
    toolScopes: ['read-files', 'write-docs'],
    allowedModels: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
    defaultModel: 'claude-haiku-5-5',
  }),
]);

const typeName = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function assertId(v: unknown, what: string): asserts v is string {
  if (typeof v !== 'string') throw new Error(`${what} must be a string, got ${typeName(v)}.`);
}

export function getRole(roleId: string): WorkerRole | undefined {
  assertId(roleId, 'Role id');
  return WORKER_ROLES.find((r) => r.id === roleId);
}

export type RoleOverrides = Partial<Record<WorkerRoleId, { defaultModel: string }>>;
export type Recommendation = { model: string | null; reason: string };

/**
 * Picks a model for a role from the models on offer: the (override or built-in) default when offered,
 * otherwise the first allowed model that is offered, otherwise null. Always includes a reason.
 */
export function recommendModel(roleId: string, availableModels: readonly string[] = KNOWN_MODELS, overrides: RoleOverrides = {}): Recommendation {
  assertId(roleId, 'Role id');
  const r = getRole(roleId);
  if (!r) return { model: null, reason: `Unknown role "${roleId}".` };
  const offered = Array.isArray(availableModels) ? availableModels.filter((m): m is string => typeof m === 'string') : [];
  const override = overrides && typeof overrides === 'object' ? overrides[r.id]?.defaultModel : undefined;
  if (typeof override === 'string' && r.allowedModels.includes(override) && offered.includes(override)) {
    return { model: override, reason: `Saved default model for ${r.id}.` };
  }
  if (offered.includes(r.defaultModel)) return { model: r.defaultModel, reason: `Default model for ${r.id}.` };
  const fallback = r.allowedModels.find((m) => offered.includes(m));
  if (fallback) return { model: fallback, reason: `Default model ${r.defaultModel} is not offered; using the first allowed model for ${r.id}.` };
  return { model: null, reason: `No model allowed for ${r.id} is offered. Allowed: ${r.allowedModels.join(', ')}.` };
}

export type Assignment = { roleId: string; model: string; scopes: readonly string[] };
export type AssignmentCheck = { ok: boolean; problems: string[] };

/** Checks a role/model/scope assignment. Messages are exact and stable for display. */
export function validateAssignment(a: Assignment): AssignmentCheck {
  if (!a || typeof a !== 'object') throw new Error(`Assignment must be an object, got ${typeName(a)}.`);
  assertId(a.roleId, 'Role id');
  assertId(a.model, 'Model id');
  if (!Array.isArray(a.scopes)) throw new Error(`Scopes must be an array, got ${typeName(a.scopes)}.`);
  const problems: string[] = [];
  const r = getRole(a.roleId);
  if (!r) problems.push(`Unknown role "${a.roleId}".`);
  if (r && !r.allowedModels.includes(a.model)) problems.push(`Model "${a.model}" is not allowed for role ${r.id}. Allowed: ${r.allowedModels.join(', ')}.`);
  if (a.scopes.length === 0) problems.push('Select at least one tool scope.');
  if (r) {
    for (const s of a.scopes) {
      if (!(r.toolScopes as readonly string[]).includes(s)) problems.push(`Scope "${String(s)}" is not in the tool scopes of role ${r.id}. Allowed: ${r.toolScopes.join(', ')}.`);
    }
  }
  return { ok: problems.length === 0, problems };
}

export type NormalizedOverrides = { overrides: RoleOverrides; warnings: string[] };

/** Keeps only per-role { defaultModel } overrides whose model is allowed for that role; everything else is dropped with a warning. */
export function normalizeOverrides(input: unknown): NormalizedOverrides {
  const overrides: RoleOverrides = {};
  const warnings: string[] = [];
  if (input === undefined || input === null) return { overrides, warnings };
  if (typeof input !== 'object' || Array.isArray(input)) {
    warnings.push(`Role overrides must be an object, got ${typeName(input)}; ignored.`);
    return { overrides, warnings };
  }
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const r = WORKER_ROLES.find((x) => x.id === key);
    if (!r) {
      warnings.push(`Override for unknown role "${key}" dropped.`);
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      warnings.push(`Override for ${key} dropped: expected { defaultModel }.`);
      continue;
    }
    const v = value as Record<string, unknown>;
    for (const extra of Object.keys(v)) if (extra !== 'defaultModel') warnings.push(`Override for ${key}: field "${extra}" ignored.`);
    if (typeof v.defaultModel !== 'string') {
      warnings.push(`Override for ${key} dropped: defaultModel must be a string.`);
      continue;
    }
    if (!r.allowedModels.includes(v.defaultModel)) {
      warnings.push(`Override for ${key} dropped: model "${v.defaultModel}" is not allowed for role ${key}.`);
      continue;
    }
    overrides[r.id] = { defaultModel: v.defaultModel };
  }
  return { overrides, warnings };
}

/** One-paragraph plain description of a role. */
export function describeRole(roleId: string): string {
  assertId(roleId, 'Role id');
  const r = getRole(roleId);
  if (!r) throw new Error(`Unknown role "${roleId}".`);
  return `${r.label}: ${r.purpose} Tool scopes: ${r.toolScopes.join(', ')}. Allowed models: ${r.allowedModels.join(', ')}; default ${r.defaultModel}. This describes intended scope for a task record only.`;
}
