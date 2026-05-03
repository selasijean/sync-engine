/**
 * RefCollection and BackRef
 *
 * Runtime objects backing the collection / back-reference decorators. When a
 * model is hydrated, each @ReferenceCollection / @LazyReferenceCollection
 * property becomes a `RefCollection` instance, and each @BackReference becomes
 * a `BackRef`. The runtime shape is identical regardless of whether the
 * decorator is eager or lazy — eager just auto-fires `.load()` during
 * makeModelObservable().
 *
 * Key behaviors:
 *
 *   RefCollection:
 *     - Stores partial index values (e.g. "all Issues where teamId = team.id")
 *     - On first access, queries ObjectPool for already-loaded matches
 *     - If not fully loaded, queries IDB by index
 *     - Tracks loading state (idle → loading → loaded)
 *     - After a delta packet adds/removes items, can be invalidated and re-queried
 *
 *   BackRef:
 *     - Resolves a single inverse model (e.g. Issue.favorite → Favorite)
 *     - Supports cascade delete: when the owning model is deleted,
 *       the back-referenced model is also removed from the pool
 *
 * Usage from React:
 *   const team = useModel("Team", teamId);
 *   const { items, isLoading, load } = team.issues;  // RefCollection
 *   // or via hook:
 *   const { items, isLoading } = useLazyCollection(team?.issues);
 */

import { observable, runInAction, makeObservable } from "mobx";
import type { BaseModel } from "./BaseModel";

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

export enum CollectionState {
  /** Never accessed — hydrate() computed the index values but no load yet. */
  Idle = "idle",
  /** Async load from IDB/server is in progress. */
  Loading = "loading",
  /** Load completed. Items are available. */
  Loaded = "loaded",
  /** Load failed. */
  Error = "error",
}

// ---------------------------------------------------------------------------
// LazyCollectionBase — shared foundation for all lazy collection types
// ---------------------------------------------------------------------------

export abstract class LazyCollectionBase<T extends BaseModel = BaseModel> {
  items: T[] = [];
  state: CollectionState = CollectionState.Idle;
  error: Error | null = null;
  readonly referencedModelName: string;

  private listeners = new Set<() => void>();
  private inFlight: Promise<T[]> | null = null;
  private onErrorHandler: ((err: Error) => void) | null = null;

  constructor(referencedModelName: string) {
    this.referencedModelName = referencedModelName;
    makeObservable(this, {
      items: observable.shallow,
      state: observable,
      error: observable,
    });
  }

  /** Wire a side-channel error reporter. Called by the loader's catch block in
   * subclasses, in addition to setting `state = Error` and `.error`. Used by
   * StoreManager to route into `config.onError` for telemetry. */
  setOnError(handler: (err: Error) => void) {
    this.onErrorHandler = handler;
  }

  protected reportError(err: Error) {
    this.onErrorHandler?.(err);
  }

  /** Subclass implementation. `load()` wraps this with concurrent-call dedup. */
  protected abstract runLoad(): Promise<T[]>;

  load(): Promise<T[]> {
    if (this.inFlight != null) {
      return this.inFlight;
    }
    this.inFlight = this.runLoad().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  invalidate() {
    if (this.state === CollectionState.Loaded) {
      runInAction(() => {
        this.state = CollectionState.Idle;
      });
      this.notifyListeners();
    }
  }

  async reload(): Promise<T[]> {
    runInAction(() => {
      this.state = CollectionState.Idle;
    });
    return this.load();
  }

  /**
   * Splice an instance into items reactively. Idempotent — duplicates by id are
   * skipped. Called by the ObjectPool when a child enters the pool with a
   * matching foreign key, or moves into this parent.
   */
  attach(item: T) {
    if (this.items.some((existing) => existing.id === item.id)) {
      return;
    }
    runInAction(() => {
      this.items = [...this.items, item];
    });
    this.notifyListeners();
  }

  /**
   * Remove an instance from items reactively. No-op if missing. Called by the
   * ObjectPool when a child is removed from the pool, or moves to a different
   * parent.
   */
  detach(itemId: string) {
    if (!this.items.some((existing) => existing.id === itemId)) {
      return;
    }
    runInAction(() => {
      this.items = this.items.filter((existing) => existing.id !== itemId);
    });
    this.notifyListeners();
  }

  /**
   * Replace items wholesale. Used by the ObjectPool to backfill when a parent
   * enters the pool after children were already present.
   */
  setItems(items: T[]) {
    runInAction(() => {
      this.items = items;
    });
    this.notifyListeners();
  }

  get isLoaded() {
    return this.state === CollectionState.Loaded;
  }
  get isLoading() {
    return this.state === CollectionState.Loading;
  }
  get length() {
    return this.items.length;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  protected notifyListeners() {
    this.listeners.forEach((fn) => fn());
  }
}

// ---------------------------------------------------------------------------
// RefCollection — one-to-many queried by foreign key index. The runtime shape
// is identical for eager and lazy decorators; the decorator only chooses
// whether `.load()` fires automatically during makeModelObservable().
// ---------------------------------------------------------------------------

export class RefCollection<
  T extends BaseModel = BaseModel,
> extends LazyCollectionBase<T> {
  /** The foreign key on the child model (e.g. "teamId"). */
  readonly inverseKey: string;

  /** The ID of the parent model (e.g. team.id). Set during hydrate(). */
  parentId: string = "";

  // In the engine, getCoveringPartialIndexValues() computes these.
  // For a simple case: [{ key: "teamId", value: "t-eng" }]
  private partialIndexValues: Array<{ key: string; value: string }> = [];

  private loader:
    | ((
        modelName: string,
        queries: Array<{ key: string; value: string }>,
      ) => Promise<T[]>)
    | null = null;

  constructor(referencedModelName: string, inverseKey: string) {
    super(referencedModelName);
    this.inverseKey = inverseKey;
  }

  /**
   * Called by Model.hydrate() after the parent model is populated.
   * Computes the partial index values for future IDB queries.
   */
  hydrate(parentId: string) {
    this.parentId = parentId;
    this.partialIndexValues = [{ key: this.inverseKey, value: parentId }];
  }

  /** Wire the loader function. Called by StoreManager. */
  setLoader(
    loader: (
      modelName: string,
      queries: Array<{ key: string; value: string }>,
    ) => Promise<T[]>,
  ) {
    this.loader = loader;
  }

  /**
   * Resolve items already in the ObjectPool synchronously.
   * Used for instant-load models where everything is in memory after bootstrap.
   */
  resolveFromPool(pool: { getAll(name: string): BaseModel[] }): T[] {
    if (pool == null || this.parentId === "") {
      return [];
    }
    const all = pool.getAll(this.referencedModelName) as T[];
    return all.filter(
      (m) => (m as Record<string, unknown>)[this.inverseKey] === this.parentId,
    );
  }

  protected async runLoad(): Promise<T[]> {
    runInAction(() => {
      this.state = CollectionState.Loading;
      this.error = null;
    });

    try {
      // The loader hydrates records into the ObjectPool, which synchronously
      // dispatches attach() back into this collection. By the time the loader
      // resolves, items already reflects every record the loader produced (plus
      // anything else in the pool with a matching foreign key).
      if (this.loader != null) {
        await this.loader(this.referencedModelName, this.partialIndexValues);
      }

      runInAction(() => {
        this.state = CollectionState.Loaded;
      });

      this.notifyListeners();
      return [...this.items] as T[];
    } catch (err) {
      runInAction(() => {
        this.error = err as Error;
        this.state = CollectionState.Error;
      });
      this.notifyListeners();
      this.reportError(err as Error);
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// BackRef — single inverse reference.
//
// When the owning model is deleted, the back-referenced model is cascade-removed.
//
// Example: Issue has @BackReference("Favorite", "issueId")
// → issue.favorite is a BackRef that resolves the Favorite where
//   issueId === issue.id
// ---------------------------------------------------------------------------

export class BackRef<T extends BaseModel = BaseModel> {
  value: T | null = null;

  state: CollectionState = CollectionState.Idle;
  error: Error | null = null;

  readonly referencedModelName: string;
  readonly inverseOf: string; // the property on the other model (e.g. "issueId")

  parentId: string = "";

  private loader:
    | ((modelName: string, key: string, value: string) => Promise<T | null>)
    | null = null;

  private onErrorHandler: ((err: Error) => void) | null = null;

  constructor(referencedModelName: string, inverseOf: string) {
    this.referencedModelName = referencedModelName;
    this.inverseOf = inverseOf;

    makeObservable(this, {
      value: observable.ref,
      state: observable,
      error: observable,
    });
  }

  hydrate(parentId: string) {
    this.parentId = parentId;
  }

  setLoader(
    loader: (
      modelName: string,
      key: string,
      value: string,
    ) => Promise<T | null>,
  ) {
    this.loader = loader;
  }

  setOnError(handler: (err: Error) => void) {
    this.onErrorHandler = handler;
  }

  /** Resolve from pool synchronously. */
  resolveFromPool(pool: { getAll(name: string): BaseModel[] }): T | null {
    if (pool == null || this.parentId === "") {
      return null;
    }
    const all = pool.getAll(this.referencedModelName) as T[];
    return (
      all.find(
        (m) => (m as Record<string, unknown>)[this.inverseOf] === this.parentId,
      ) ?? null
    );
  }

  async load(): Promise<T | null> {
    if (this.state === CollectionState.Loading) {
      return this.value;
    }

    runInAction(() => {
      this.state = CollectionState.Loading;
      this.error = null;
    });

    try {
      const result =
        this.loader != null
          ? await this.loader(
              this.referencedModelName,
              this.inverseOf,
              this.parentId,
            )
          : null;
      runInAction(() => {
        this.value = result;
        this.state = CollectionState.Loaded;
      });
      return result;
    } catch (err) {
      runInAction(() => {
        this.error = err as Error;
        this.state = CollectionState.Error;
      });
      this.onErrorHandler?.(err as Error);
      return null;
    }
  }

  invalidate() {
    if (this.state === CollectionState.Loaded) {
      runInAction(() => {
        this.state = CollectionState.Idle;
      });
    }
  }

  /**
   * Set the resolved value reactively. Used by the ObjectPool when a model
   * matching this back-reference enters the pool. Idempotent on identity.
   */
  attach(item: T) {
    if (this.value === item) {
      return;
    }
    runInAction(() => {
      this.value = item;
    });
  }

  /**
   * Clear the resolved value reactively. Used by the ObjectPool when the
   * referenced model leaves the pool or its inverse key changes.
   */
  detach(itemId: string) {
    if (this.value == null || this.value.id !== itemId) {
      return;
    }
    runInAction(() => {
      this.value = null;
    });
  }

  get isLoaded() {
    return this.state === CollectionState.Loaded;
  }
  get isLoading() {
    return this.state === CollectionState.Loading;
  }
}
