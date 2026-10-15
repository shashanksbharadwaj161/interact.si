import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppState, JarvisAPI, Settings, SystemInfo } from '../shared/contracts';
import { errMsg } from './util';
import { applyAssociation, buildAssociationSessions, toAssociationOp, type AssociationChange } from './session-association';
import { readPref, writePref } from './prefs';
import { DEFAULT_SCENE, isKnownScene } from './scenes';
import { readReducedMotion } from './companion';
import { createAnimMachine, finish, isSettled, setReducedMotion, transition, viewAt, type AnimMachine, type AnimView } from './anim-state';
import {
  CAPSULE_SCENE_PREF_KEY,
  clearCapsuleScene as clearCapsuleSceneMap,
  normalizeCapsuleScenes,
  planSceneTransition,
  resolveSceneForCapsule,
  setCapsuleScene as setCapsuleSceneMap,
  type CapsuleSceneMap,
  type SceneResolution,
} from './capsule-scene';
// Type-only imports: erased at build time, so no Node-side module reaches the renderer bundle.
import type { ProductivityOp, ProductivityState } from '../../electron/services/store';
import type { PackImport, PathMapping, PathRoot, RestorePreview } from '../../electron/services/capsules';
import type { ExternalDoc } from '../../electron/services/search';

export type ToastKind = 'ok' | 'error' | 'info';
export type Toast = { id: number; kind: ToastKind; text: string };
export type LoadStatus = 'loading' | 'ready' | 'error';

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
  /** Goal 44: per-capsule project scenes, kept renderer-side under the CAPSULE_SCENE_PREF_KEY preference. */
  capsuleScenes: CapsuleSceneMap;
  setCapsuleScene: (capsuleId: string, sceneId: string) => boolean;
  clearCapsuleScene: (capsuleId: string) => boolean;
  /** Goal 67: resolves the capsule's scene and makes it the app backdrop through the interruptible anim machine. */
  applyCapsuleScene: (capsuleId: string) => SceneResolution | null;
  /** Ends a pending scene transition at once on its target (no stuck state). */
  cancelSceneTransition: () => void;
  /** Current state of the backdrop transition machine. */
  sceneTransition: AnimView;
};

/** Existing app-wide scene preference (App's `usePref('scene', DEFAULT_SCENE)`). */
const SCENE_PREF_KEY = 'scene';
/** Storage key the prefs helper uses for SCENE_PREF_KEY; announcing it lets every usePref('scene') hook re-read the value. */
const SCENE_STORAGE_KEY = `jarvis.ui.${SCENE_PREF_KEY}`;

function sceneNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function currentAppScene(): string {
  const s = readPref<unknown>(SCENE_PREF_KEY, DEFAULT_SCENE);
  return typeof s === 'string' && isKnownScene(s) ? s : DEFAULT_SCENE;
}

/** Loads saved project scenes; any failure falls back to an empty map with a warning instead of throwing. */
export function loadCapsuleScenes(): CapsuleSceneMap {
  try {
    return normalizeCapsuleScenes(readPref<unknown>(CAPSULE_SCENE_PREF_KEY, {}));
  } catch (e) {
    try {
      console.warn(`Project scenes could not be loaded; using none. ${errMsg(e)}`);
    } catch {
      /* no console */
    }
    return normalizeCapsuleScenes({});
  }
}

/** Sets the existing app-wide scene preference and tells the same-window usePref('scene') hooks to re-read it. */
function setAppScene(sceneId: string): void {
  writePref(SCENE_PREF_KEY, sceneId);
  try {
    if (typeof window !== 'undefined' && typeof StorageEvent === 'function') window.dispatchEvent(new StorageEvent('storage', { key: SCENE_STORAGE_KEY }));
  } catch {
    /* the next mount reads the saved value */
  }
}

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

  // ---- Goal 44/67: project scenes and the project-to-project backdrop transition ----
  const [capsuleScenes, setCapsuleScenesState] = useState<CapsuleSceneMap>(loadCapsuleScenes);
  const capsuleScenesRef = useRef<CapsuleSceneMap>(capsuleScenes);
  const sceneMachine = useRef<AnimMachine | null>(null);
  const sceneRaf = useRef(0);
  const [sceneTransition, setSceneTransition] = useState<AnimView>(() => viewAt(createAnimMachine({ reducedMotion: true, now: 0, initial: currentAppScene() }), 0));

  const persistCapsuleScenes = useCallback((next: CapsuleSceneMap) => {
    capsuleScenesRef.current = next;
    setCapsuleScenesState(next);
    writePref(CAPSULE_SCENE_PREF_KEY, next);
  }, []);

  const setCapsuleScene = useCallback(
    (capsuleId: string, sceneId: string) => {
      try {
        persistCapsuleScenes(setCapsuleSceneMap(capsuleScenesRef.current, capsuleId, sceneId));
        return true;
      } catch (e) {
        toast('error', errMsg(e));
        return false;
      }
    },
    [persistCapsuleScenes, toast],
  );

  const clearCapsuleScene = useCallback(
    (capsuleId: string) => {
      try {
        persistCapsuleScenes(clearCapsuleSceneMap(capsuleScenesRef.current, capsuleId));
        return true;
      } catch (e) {
        toast('error', errMsg(e));
        return false;
      }
    },
    [persistCapsuleScenes, toast],
  );

  const stopSceneFrames = useCallback(() => {
    if (sceneRaf.current && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(sceneRaf.current);
    sceneRaf.current = 0;
  }, []);

  const cancelSceneTransition = useCallback(() => {
    stopSceneFrames();
    const m = sceneMachine.current;
    if (!m) return;
    const t = sceneNow();
    const done = finish(m, t);
    sceneMachine.current = done;
    setSceneTransition(viewAt(done, t));
  }, [stopSceneFrames]);

  const applyCapsuleScene = useCallback(
    (capsuleId: string): SceneResolution | null => {
      try {
        const from = currentAppScene();
        const capsule = state?.capsules.find((c) => c.id === capsuleId);
        // "Use default" means the capsule's own saved scene when it is a known one, else the current app scene.
        const fallbackSceneId = capsule && isKnownScene(capsule.scene) ? capsule.scene : from;
        const reducedMotion = readReducedMotion();
        const resolved = resolveSceneForCapsule({ capsuleId, mappings: capsuleScenesRef.current, fallbackSceneId, reducedMotion });
        const now = sceneNow();
        const plan = planSceneTransition(from, resolved.sceneId, { reducedMotion, now });
        // A second resume (or Preview) interrupts the pending leg: stop its frame loop and retarget the same machine.
        stopSceneFrames();
        let m = sceneMachine.current ?? createAnimMachine({ reducedMotion, now, initial: from });
        m = setReducedMotion(m, reducedMotion || plan.kind === 'none', now);
        m = transition(m, { type: 'show', target: resolved.sceneId }, now);
        sceneMachine.current = m;
        setSceneTransition(viewAt(m, now));
        setAppScene(resolved.sceneId);
        if (!isSettled(m)) {
          if (typeof requestAnimationFrame === 'function') {
            const step = () => {
              sceneRaf.current = 0;
              const t = sceneNow();
              const next = transition(sceneMachine.current ?? m, { type: 'tick' }, t);
              sceneMachine.current = next;
              setSceneTransition(viewAt(next, t));
              if (!isSettled(next)) sceneRaf.current = requestAnimationFrame(step);
            };
            sceneRaf.current = requestAnimationFrame(step);
          } else {
            const done = finish(m, now);
            sceneMachine.current = done;
            setSceneTransition(viewAt(done, now));
          }
        }
        return resolved;
      } catch (e) {
        toast('error', errMsg(e));
        return null;
      }
    },
    [state, stopSceneFrames, toast],
  );

  useEffect(() => stopSceneFrames, [stopSceneFrames]);

  const value = useMemo<Store>(
    () => ({
      api,
      productivityApi,
      productivity,
      productivityError,
      applyProductivity,
      refreshProductivity,
      setSessionAssociation,
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
      capsuleScenes,
      setCapsuleScene,
      clearCapsuleScene,
      applyCapsuleScene,
      cancelSceneTransition,
      sceneTransition,
    }),
    [api, productivityApi, productivity, productivityError, applyProductivity, refreshProductivity, setSessionAssociation, isPreview, status, loadError, state, system, systemError, systemLoading, cloudConfigured, toasts, toast, dismissToast, reload, refreshSystem, refreshCloud, mutate, run, capsuleScenes, setCapsuleScene, clearCapsuleScene, applyCapsuleScene, cancelSceneTransition, sceneTransition],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
