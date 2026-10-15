import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppState, JarvisAPI, Settings, SystemInfo } from '../shared/contracts';
import { errMsg } from './util';
import { applyAssociation, buildAssociationSessions, toAssociationOp, type AssociationChange } from './session-association';
import { BRANCH_PREF_KEY, attachBranchCapsule, createBranchFromCheckpoint, normalizeBranches, type BranchRecord } from './project-branches';
import { readPref, usePref } from './prefs';
// Type-only imports: erased at build time, so no Node-side module reaches the renderer bundle.
import type { ProductivityOp, ProductivityState } from '../../electron/services/store';
import type { PackImport, PathMapping, PathRoot, RestorePreview } from '../../electron/services/capsules';
import type { ExternalDoc } from '../../electron/services/search';

export type ToastKind = 'ok' | 'error' | 'info';
export type Toast = { id: number; kind: ToastKind; text: string };
export type LoadStatus = 'loading' | 'ready' | 'error';
export type CreateBranchResult = { ok: true; capsuleId: string; branch: BranchRecord; warning?: string } | { ok: false; error: string };

/**
 * Optional local productivity API (window.jarvis.productivity). The main process exposes it when the sidecar store is
 * wired; until then the views that need it say so instead of pretending. Every call is validated in the main process.
 */
export interface ProductivityAPI {
  get(): Promise<ProductivityState>;
  apply(op: ProductivityOp): Promise<ProductivityState>;
  /** Forget chat and/or activity history (optionally older than an ISO date). Resolves with the counts removed. */
  forgetHistory?(opts: { chat?: boolean; activity?: boolean; before?: string }): Promise<{ removed: { chat: number; activity: number } }>;
  capsule?: {
    previewRestore(id: string): Promise<RestorePreview>;
    /** Lists open windows the user may tick to save their positions. Reads titles and process names only. */
    listWindows?(): Promise<{ hwnd: number; title: string; process: string }[]>;
    captureGeometry?(id: string, hwnds: number[]): Promise<{ saved: number; skipped: { process: string; reason: string }[] }>;
    exportPack?(id: string, roots: PathRoot[]): Promise<{ saved: boolean; unmapped: string[] }>;
    /** Main-process open dialog; resolves with the chosen pack's text (at most 1 MB) or null when cancelled. */
    readPack?(): Promise<string | null>;
    /** Validates pack text and applies path mappings (parseCapsulePack). Saves nothing. */
    parsePack?(raw: string, mappings: PathMapping[]): Promise<PackImport>;
  };
  /** Records owned by the calendar and clipboard modules, shared only when the user enabled those modules. */
  signals?(): Promise<ExternalDoc[]>;
}

type Store = {
  api: JarvisAPI;
  productivityApi: ProductivityAPI | null;
  /** Sidecar data; null until loaded or when the API is not connected. */
  productivity: ProductivityState | null;
  productivityError: string | null;
  /** Apply one validated sidecar operation, then refresh. Resolves true on success. */
  applyProductivity: (op: ProductivityOp, okMessage?: string) => Promise<boolean>;
  refreshProductivity: () => Promise<void>;
  /** Goal 36: user correction of a session's task/project link, validated by applyAssociation and persisted through association.set / association.clear so it survives reload. */
  setSessionAssociation: (sessionId: string, change: AssociationChange) => Promise<boolean>;
  /** Goal 50: branch lineage records (UI prefs, key projectBranches.v1), normalized. */
  branches: BranchRecord[];
  /** Goal 50: creates a new capsule from a checkpoint through the existing saveCapsule path, then records its lineage. */
  createBranch: (input: { checkpointId: string; name: string }) => Promise<CreateBranchResult>;
  isPreview: boolean;
  status: LoadStatus;
  loadError: string | null;
  state: AppState | null;
  settings: Settings | null;
  system: SystemInfo | null;
  systemError: string | null;
  systemLoading: boolean;
  cloudConfigured: boolean | null;
  toasts: Toast[];
  toast: (kind: ToastKind, text: string) => void;
  dismissToast: (id: number) => void;
  reload: () => Promise<void>;
  refreshSystem: () => Promise<void>;
  refreshCloud: () => Promise<void>;
  /** Run a write that returns AppState, then re-read persisted state. Resolves true on success. */
  mutate: (op: () => Promise<AppState>, okMessage?: string) => Promise<boolean>;
  /** Run any other call, then re-read persisted state. Returns the result or undefined on failure. */
  run: <T>(op: () => Promise<T>, okMessage?: string) => Promise<T | undefined>;
};

const Ctx = createContext<Store | null>(null);

/** The store when rendered inside AppProvider, otherwise null. For components that also work with props alone. */
export function useOptionalStore(): Store | null {
  return useContext(Ctx);
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore outside AppProvider');
  return s;
}

/** Ready-state accessor for views rendered only after the first successful load. */
export function useReady(): Store & { state: AppState; settings: Settings } {
  const s = useStore();
  if (!s.state || !s.settings) throw new Error('useReady before state loaded');
  return s as Store & { state: AppState; settings: Settings };
}

let toastSeq = 0;

export function AppProvider({ api, isPreview, children }: { api: JarvisAPI; isPreview: boolean; children: ReactNode }) {
  const [state, setState] = useState<AppState | null>(null);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [systemError, setSystemError] = useState<string | null>(null);
  const [systemLoading, setSystemLoading] = useState(false);
  const [cloudConfigured, setCloudConfigured] = useState<boolean | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const productivityApi = useMemo<ProductivityAPI | null>(() => {
    const p = (api as JarvisAPI & { productivity?: ProductivityAPI }).productivity;
    return p && typeof p.get === 'function' && typeof p.apply === 'function' ? p : null;
  }, [api]);
  const [productivity, setProductivity] = useState<ProductivityState | null>(null);
  const [productivityError, setProductivityError] = useState<string | null>(null);
  const timers = useRef(new Map<number, number>());

  const dismissToast = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
    const h = timers.current.get(id);
    if (h) window.clearTimeout(h);
    timers.current.delete(id);
  }, []);

  const toast = useCallback(
    (kind: ToastKind, text: string) => {
      const id = ++toastSeq;
      setToasts((t) => [...t.slice(-3), { id, kind, text }]);
      timers.current.set(id, window.setTimeout(() => dismissToast(id), kind === 'error' ? 9000 : 4500));
    },
    [dismissToast],
  );

  const refreshSystem = useCallback(async () => {
    setSystemLoading(true);
    try {
      setSystem(await api.getSystemInfo());
      setSystemError(null);
    } catch (e) {
      setSystemError(errMsg(e, 'System information is unavailable.'));
    } finally {
      setSystemLoading(false);
    }
  }, [api]);

  const refreshCloud = useCallback(async () => {
    try {
      setCloudConfigured((await api.cloudKeyStatus()).configured);
    } catch {
      setCloudConfigured(null);
    }
  }, [api]);

  const reload = useCallback(async () => {
    setStatus((s) => (s === 'ready' ? s : 'loading'));
    try {
      setState(await api.getState());
      setLoadError(null);
      setStatus('ready');
    } catch (e) {
      setLoadError(errMsg(e, 'Saved data could not be loaded.'));
      setStatus((s) => (s === 'ready' ? s : 'error'));
      throw e;
    }
  }, [api]);

  const refreshProductivity = useCallback(async () => {
    if (!productivityApi) return;
    try {
      setProductivity(await productivityApi.get());
      setProductivityError(null);
    } catch (e) {
      setProductivityError(errMsg(e, 'Local productivity data could not be loaded.'));
    }
  }, [productivityApi]);

  useEffect(() => {
    void refreshProductivity();
  }, [refreshProductivity]);

  const applyProductivity = useCallback(
    async (op: ProductivityOp, okMessage?: string) => {
      if (!productivityApi) {
        toast('error', 'Local productivity storage is not connected in this build.');
        return false;
      }
      try {
        setProductivity(await productivityApi.apply(op));
        setProductivityError(null);
        if (okMessage) toast('ok', okMessage);
        return true;
      } catch (e) {
        toast('error', errMsg(e));
        return false;
      }
    },
    [productivityApi, toast],
  );

  useEffect(() => {
    reload().catch(() => undefined);
    void refreshSystem();
    void refreshCloud();
  }, [reload, refreshSystem, refreshCloud]);

  useEffect(() => {
    if (typeof api.onActivity !== 'function') return undefined;
    const off = api.onActivity((a) => {
      setState((s) => (s && !s.activity.some((x) => x.id === a.id) ? { ...s, activity: [a, ...s.activity].slice(0, 300) } : s));
    });
    return () => {
      if (typeof off === 'function') off();
    };
  }, [api]);

  const mutate = useCallback(
    async (op: () => Promise<AppState>, okMessage?: string) => {
      try {
        const next = await op();
        setState(next);
        try {
          setState(await api.getState());
        } catch {
          /* the write result already reflects persisted state */
        }
        if (okMessage) toast('ok', okMessage);
        return true;
      } catch (e) {
        toast('error', errMsg(e));
        return false;
      }
    },
    [api, toast],
  );

  const run = useCallback(
    async <T,>(op: () => Promise<T>, okMessage?: string) => {
      try {
        const out = await op();
        try {
          setState(await api.getState());
        } catch {
          /* keep the previous snapshot */
        }
        if (okMessage) toast('ok', okMessage);
        return out;
      } catch (e) {
        toast('error', errMsg(e));
        return undefined;
      }
    },
    [api, toast],
  );

  const setSessionAssociation = useCallback(
    async (sessionId: string, change: AssociationChange) => {
      if (!productivity) {
        toast('error', 'Local productivity data is not loaded yet.');
        return false;
      }
      let op: ReturnType<typeof toAssociationOp>;
      try {
        const next = applyAssociation(buildAssociationSessions(productivity), sessionId, change, { tasks: state?.tasks ?? [], capsules: state?.capsules ?? [], now: new Date().toISOString() });
        const session = next.find((s) => s.id === sessionId);
        if (!session) throw new Error(`Unknown session id: ${sessionId}`);
        op = toAssociationOp(session);
      } catch (e) {
        toast('error', errMsg(e));
        return false;
      }
      return applyProductivity(op, op.op === 'association.set' ? 'Association saved; marked as corrected by you.' : 'Association cleared.');
    },
    [productivity, state, toast, applyProductivity],
  );

  // Goal 50: branch lineage lives in UI prefs; the branch capsule itself goes through the existing saveCapsule bridge
  // and its copied goals/references through the existing capsule.setMeta productivity op. No new IPC channel.
  const [branchPref, setBranchPref] = usePref<unknown>(BRANCH_PREF_KEY, []);
  const branches = useMemo(() => normalizeBranches(branchPref), [branchPref]);
  const branchBusy = useRef(false);

  const createBranch = useCallback(
    async ({ checkpointId, name }: { checkpointId: string; name: string }): Promise<CreateBranchResult> => {
      if (branchBusy.current) return { ok: false, error: 'Another branch is being created; wait for it to finish.' };
      if (!state) return { ok: false, error: 'Saved data is not loaded yet.' };
      const checkpoint = productivity?.checkpoints.find((c) => c.id === checkpointId);
      const capsule = checkpoint?.capsuleId ? state.capsules.find((c) => c.id === checkpoint.capsuleId) : undefined;
      const meta = capsule ? productivity?.capsuleMeta[capsule.id] : undefined;
      let plan: ReturnType<typeof createBranchFromCheckpoint>;
      try {
        if (checkpoint && !capsule) throw new Error('Branch: the source capsule was not found (it may have been deleted)');
        plan = createBranchFromCheckpoint({
          checkpoint,
          sourceCapsule: capsule ? { ...capsule, goals: meta?.goals ?? [], references: meta?.references ?? [] } : undefined,
          name,
          now: new Date().toISOString(),
          existing: normalizeBranches(readPref<unknown>(BRANCH_PREF_KEY, [])),
        });
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
      branchBusy.current = true;
      try {
        const input = plan.newCapsuleInput;
        const before = new Set(state.capsules.map((c) => c.id));
        const next = await api.saveCapsule({ name: input.name, description: input.description, scene: input.scene, items: input.items });
        setState(next);
        const created = next.capsules.find((c) => !before.has(c.id) && c.name === input.name);
        if (!created) throw new Error('The branch capsule was saved but could not be identified; reload and check the capsule list.');
        const record = attachBranchCapsule(plan.branchRecord, created.id);
        setBranchPref([...normalizeBranches(readPref<unknown>(BRANCH_PREF_KEY, [])), record]);
        let warning: string | undefined;
        if (input.goals.length || input.references.length) {
          if (!productivityApi) warning = 'Goals and references were not copied because local productivity storage is not connected.';
          else {
            try {
              setProductivity(await productivityApi.apply({ op: 'capsule.setMeta', capsuleId: created.id, goals: input.goals, references: input.references } as ProductivityOp));
            } catch (e) {
              warning = `The branch was created, but its goals and references could not be copied: ${errMsg(e)}`;
            }
          }
        }
        toast(warning ? 'info' : 'ok', warning ?? `Branch “${record.name}” created.`);
        return { ok: true, capsuleId: created.id, branch: record, ...(warning ? { warning } : {}) };
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      } finally {
        branchBusy.current = false;
      }
    },
    [api, state, productivity, productivityApi, setBranchPref, toast],
  );

  const value = useMemo<Store>(
    () => ({
      api,
      productivityApi,
      productivity,
      productivityError,
      applyProductivity,
      refreshProductivity,
      setSessionAssociation,
      branches,
      createBranch,
      isPreview,
      status,
      loadError,
      state,
      settings: state?.settings ?? null,
      system,
      systemError,
      systemLoading,
      cloudConfigured,
      toasts,
      toast,
      dismissToast,
      reload,
      refreshSystem,
      refreshCloud,
      mutate,
      run,
    }),
    [api, productivityApi, productivity, productivityError, applyProductivity, refreshProductivity, setSessionAssociation, branches, createBranch, isPreview, status, loadError, state, system, systemError, systemLoading, cloudConfigured, toasts, toast, dismissToast, reload, refreshSystem, refreshCloud, mutate, run],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
