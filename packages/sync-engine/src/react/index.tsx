/**
 * React integration for the Linear Sync Engine.
 *
 * Key behavior: when a delta packet arrives from another client and adds,
 * updates, or removes a model, any component using useModel/useModels for
 * that model type automatically re-renders. This works because the hooks
 * subscribe to ObjectPool change notifications via useSyncExternalStore.
 */

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  useSyncExternalStore,
} from "react";
import { StoreManager, type StoreManagerConfig } from "../core/StoreManager";
import { BootstrapPhase } from "../core/types";
import { LazyCollectionBase, LazyBackReference } from "../core/LazyCollection";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface SyncStatus {
  phase: BootstrapPhase;
  detail?: string;
  error?: string;
}

const SyncContext = createContext<{
  sm: StoreManager;
  status: SyncStatus;
} | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function SyncProvider({
  config,
  children,
  fallback,
}: {
  config: StoreManagerConfig;
  children: React.ReactNode;
  /** Shown while bootstrap is in progress. */
  fallback?: React.ReactNode;
}) {
  const [status, setStatus] = useState<SyncStatus>({
    phase: BootstrapPhase.Idle,
  });
  const smRef = useRef<StoreManager | null>(null);
  const cfgRef = useRef(config);
  cfgRef.current = config;

  // Detect bfcache restores. When a tab is duplicated (or the user navigates
  // back/forward) the browser may restore the page from its back/forward cache
  // (bfcache). In that case the JS heap is frozen and thawed — React effects do
  // NOT re-run, so the StoreManager never bootstraps and the fallback stays
  // visible forever. Reloading on persisted pageshow breaks out of that state.
  useEffect(() => {
    const handlePageShow = (e: PageTransitionEvent) => {
      if (e.persisted) {
        window.location.reload();
      }
    };
    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, []);

  useEffect(() => {
    let active = true;

    const sm = new StoreManager({
      ...cfgRef.current,
      onPhaseChange: (phase, detail) => {
        if (active) { setStatus({ phase, detail }); }
      },
    });
    smRef.current = sm;
    sm.bootstrap().catch((err) => {
      if (active) {
        setStatus({ phase: BootstrapPhase.Error, error: String(err) });
      }
    });
    return () => {
      active = false;
      sm.teardown();
      smRef.current = null;
    };
  }, [cfgRef.current.workspaceId]);

  if (smRef.current == null) {
    return fallback != null ? <>{fallback}</> : null;
  }
  if (
    status.phase !== BootstrapPhase.Ready &&
    status.phase !== BootstrapPhase.Error &&
    fallback != null
  ) {
    return <>{fallback}</>;
  }
  return (
    <SyncContext.Provider value={{ sm: smRef.current, status }}>
      {children}
    </SyncContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Core hook
// ---------------------------------------------------------------------------

export function useSyncEngine() {
  const ctx = useContext(SyncContext);
  if (ctx == null) {
    throw new Error("useSyncEngine() must be inside <SyncProvider>");
  }
  return ctx;
}

export function useBootstrapStatus(): SyncStatus {
  return useSyncEngine().status;
}

// ---------------------------------------------------------------------------
// useModels — reactive list of all instances of a model type
//
// Re-renders when:
//   - A delta packet adds a new instance of this type (another client creates)
//   - A delta packet removes an instance (another client deletes)
//   - A delta packet updates an instance (handled by MobX on the model itself)
//
// Uses useSyncExternalStore to subscribe to ObjectPool change events.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useModels<T = any>(modelName: string): T[] {
  const { sm, status } = useSyncEngine();
  const pool = sm.objectPool;

  // Subscribe to ObjectPool change notifications for this model type.
  // When pool.put() or pool.remove() is called for this model (e.g. by
  // SyncConnection processing a delta packet), the listener fires
  // and React re-renders this component.
  const subscribe = useCallback(
    (onStoreChange: () => void) => pool.subscribe(modelName, onStoreChange),
    [pool, modelName],
  );

  // Read current data from the pool.
  // useSyncExternalStore calls this on subscribe and after every notification.
  const getSnapshot = useCallback(
    () => pool.getAll(modelName),
    [pool, modelName],
  );

  const models = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  if (status.phase !== BootstrapPhase.Ready) {
    return [];
  }
  return models as T[];
}

// ---------------------------------------------------------------------------
// useModel — reactive single model by ID
//
// Re-renders when the pool changes for this model type (including when
// this specific model is updated/deleted by a delta packet).
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useModel<T = any>(
  modelName: string,
  id: string | null | undefined,
): T | null {
  const { sm, status } = useSyncEngine();
  const pool = sm.objectPool;

  const subscribe = useCallback(
    (onStoreChange: () => void) => pool.subscribe(modelName, onStoreChange),
    [pool, modelName],
  );

  const getSnapshot = useCallback(
    () => (id != null ? (pool.getById(modelName, id) ?? null) : null),
    [pool, modelName, id],
  );

  const model = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  if (status.phase !== BootstrapPhase.Ready) {
    return null;
  }
  return model as T | null;
}

// ---------------------------------------------------------------------------
// useLazyCollection — load a related collection with loading state
//
// For querying by foreign key: "all Issues where teamId === X".
// Checks ObjectPool first (instant), falls back to IndexedDB.
// Also subscribes to pool changes so new delta-packet arrivals show up.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useLazyCollection<T = any>(
  modelName: string,
  indexKey: string,
  value: string | null | undefined,
) {
  const { sm, status } = useSyncEngine();
  const [items, setItems] = useState<T[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const gen = useRef(0);

  const doLoad = useCallback(async () => {
    if (value == null || status.phase !== BootstrapPhase.Ready) {
      return;
    }
    const g = ++gen.current;
    setIsLoading(true);
    setError(null);
    try {
      const result = await sm.loadCollection(modelName, indexKey, value);
      if (g === gen.current) {
        setItems(result as T[]);
        setIsLoading(false);
      }
    } catch (e) {
      if (g === gen.current) {
        setError(e as Error);
        setIsLoading(false);
      }
    }
  }, [sm, modelName, indexKey, value, status.phase]);

  // Initial load
  useEffect(() => {
    doLoad();
  }, [doLoad]);

  // Re-load when pool changes (e.g. delta packet adds a new Issue to this team)
  useEffect(() => {
    if (value == null || status.phase !== BootstrapPhase.Ready) {
      return;
    }
    return sm.objectPool.subscribe(modelName, doLoad);
  }, [sm, modelName, value, status.phase, doLoad]);

  return { items, isLoading, error, reload: doLoad };
}

// ---------------------------------------------------------------------------
// useLazyIds — load a specific set of models by ID with loading state
//
// The reactive complement to useModel for multiple IDs:
//
//   const { items, isLoading } = useLazyIds("Issue", ["id-1", "id-2"]);
//
// Calls loadByIds on mount (and when IDs change). Re-renders when the pool
// changes for this model type (e.g. a delta packet updates one of the items).
// The ids array is compared by value, so inline arrays won't cause re-fetches.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useLazyIds<T = any>(
  modelName: string,
  ids: string[] | null | undefined,
) {
  const { sm, status } = useSyncEngine();
  const [items, setItems] = useState<T[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const gen = useRef(0);

  // Stable key so inline array literals don't cause infinite re-fetches.
  const idsKey = ids?.join(",") ?? "";

  const doLoad = useCallback(async () => {
    if (ids == null || ids.length === 0 || status.phase !== BootstrapPhase.Ready) {
      return;
    }
    const g = ++gen.current;
    setIsLoading(true);
    setError(null);
    try {
      const result = await sm.loadByIds(modelName, ids);
      if (g === gen.current) {
        setItems(result as T[]);
        setIsLoading(false);
      }
    } catch (e) {
      if (g === gen.current) {
        setError(e as Error);
        setIsLoading(false);
      }
    }
  }, [sm, modelName, idsKey, status.phase]);

  useEffect(() => {
    doLoad();
  }, [doLoad]);

  // Re-render when pool changes (e.g. delta packet updates one of the items)
  useEffect(() => {
    if (idsKey === "" || status.phase !== BootstrapPhase.Ready) {
      return;
    }
    return sm.objectPool.subscribe(modelName, doLoad);
  }, [sm, modelName, idsKey, status.phase, doLoad]);

  return { items, isLoading, error, reload: doLoad };
}

// ---------------------------------------------------------------------------
// useLazyRef — load a single partial/lazy model by ID
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useLazyRef<T = any>(
  modelName: string,
  id: string | null | undefined,
) {
  const { sm, status } = useSyncEngine();
  const [value, setValue] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const gen = useRef(0);

  const doLoad = useCallback(async () => {
    if (id == null || status.phase !== BootstrapPhase.Ready) {
      return;
    }
    const g = ++gen.current;
    setIsLoading(true);
    setError(null);
    try {
      const result = await sm.loadOne(modelName, id);
      if (g === gen.current) {
        setValue(result as T | null);
        setIsLoading(false);
      }
    } catch (e) {
      if (g === gen.current) {
        setError(e as Error);
        setIsLoading(false);
      }
    }
  }, [sm, modelName, id, status.phase]);

  useEffect(() => {
    doLoad();
  }, [doLoad]);

  // Re-load on pool changes (e.g. delta packet updates this model)
  useEffect(() => {
    if (id == null || status.phase !== BootstrapPhase.Ready) {
      return;
    }
    return sm.objectPool.subscribe(modelName, doLoad);
  }, [sm, modelName, id, status.phase, doLoad]);

  return { value, isLoading, error, reload: doLoad };
}

// ---------------------------------------------------------------------------
// Batch and undo/redo
// ---------------------------------------------------------------------------

export function useBatch() {
  const { sm } = useSyncEngine();
  return useCallback(
    (fn: () => void | Promise<void>) => sm.batch(fn as () => void),
    [sm],
  );
}

export function useUndoRedo() {
  const { sm } = useSyncEngine();
  return {
    undo: useCallback(() => sm.undo(), [sm]),
    redo: useCallback(() => sm.redo(), [sm]),
    canUndo: sm.transactionQueue.undoDepth > 0,
    canRedo: sm.transactionQueue.redoDepth > 0,
  };
}

// ---------------------------------------------------------------------------
// useCollection — subscribe to a LazyReferenceCollection directly
//
// The cleanest way to use ReferenceCollections in components:
//
//   const team = useModel("Team", teamId);
//   const { items, isLoading, reload } = useCollection(team?.issues);
//
// Triggers load() on mount. Re-renders when the collection is invalidated
// (e.g. delta packet adds an Issue to this team). Uses the collection's
// subscribe() method for proper reactivity.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useCollection<T = any>(
  collection: LazyCollectionBase | null | undefined,
) {
  const [tick, forceRender] = useState(0);

  // Subscribe to collection invalidation events
  useEffect(() => {
    if (collection == null) {
      return;
    }
    return collection.subscribe(() => forceRender((n) => n + 1));
  }, [collection]);

  // Trigger load on mount or after invalidation
  useEffect(() => {
    if (collection != null && !collection.isLoaded && !collection.isLoading) {
      collection.load().then(() => forceRender((n) => n + 1));
    }
  }, [collection, tick]);

  if (collection == null) {
    return {
      items: [] as T[],
      isLoading: false,
      isLoaded: false,
      error: null,
      reload: () => {},
    };
  }

  return {
    items: (collection.items ?? []) as T[],
    isLoading: collection.isLoading ?? false,
    isLoaded: collection.isLoaded ?? false,
    error: collection.error ?? null,
    reload: () => collection.reload(),
  };
}

// ---------------------------------------------------------------------------
// useBackRef — subscribe to a LazyBackReference directly
//
//   const issue = useModel("Issue", issueId);
//   const { value: favorite, isLoading } = useBackRef(issue?.favorite);
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useBackRef<T = any>(
  backRef: LazyBackReference | null | undefined,
) {
  const [tick, forceRender] = useState(0);

  useEffect(() => {
    if (backRef != null && !backRef.isLoaded && !backRef.isLoading) {
      backRef.load().then(() => forceRender((n) => n + 1));
    }
  }, [backRef, tick]);

  if (backRef == null) {
    return {
      value: null as T | null,
      isLoading: false,
      isLoaded: false,
      error: null,
      reload: () => {},
    };
  }

  return {
    value: (backRef.value ?? null) as T | null,
    isLoading: backRef.isLoading ?? false,
    isLoaded: backRef.isLoaded ?? false,
    error: backRef.error ?? null,
    reload: () => backRef.load(),
  };
}
