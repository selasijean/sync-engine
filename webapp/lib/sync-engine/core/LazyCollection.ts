/**
 * LazyReferenceCollection and LazyBackReference
 *
 * These are RUNTIME OBJECTS, not just metadata. When a model is hydrated,
 * each @ReferenceCollection property becomes a LazyReferenceCollection
 * instance, and each @BackReference becomes a LazyBackReference.
 *
 * In the engine, Model.hydrate() finds all referenceCollection/backReference
 * properties and calls their hydrate() methods. That hydrate() computes
 * the partial index values — the query parameters needed to lazy-load
 * the related models from IDB.
 *
 * Key behaviors:
 *
 *   LazyReferenceCollection:
 *     - Stores partial index values (e.g. "all Issues where teamId = team.id")
 *     - On first access, queries ObjectPool for already-loaded matches
 *     - If not fully loaded, queries IDB by index
 *     - Tracks loading state (idle → loading → loaded)
 *     - After a delta packet adds/removes items, can be invalidated and re-queried
 *
 *   LazyBackReference:
 *     - Resolves a single inverse model (e.g. Issue.favorite → Favorite)
 *     - Supports cascade delete: when the owning model is deleted,
 *       the back-referenced model is also removed from the pool
 *
 * Usage from React:
 *   const team = useModel("Team", teamId);
 *   const { items, isLoading, load } = team.issues;  // LazyReferenceCollection
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

  constructor(referencedModelName: string) {
    this.referencedModelName = referencedModelName;
    makeObservable(this, {
      items: observable.shallow,
      state: observable,
      error: observable,
    });
  }

  abstract load(): Promise<T[]>;

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
// LazyReferenceCollection — one-to-many queried by foreign key index
// ---------------------------------------------------------------------------

export class LazyReferenceCollection<T extends BaseModel = BaseModel> extends LazyCollectionBase<T> {
  /** The foreign key on the child model (e.g. "teamId"). */
  readonly inverseKey: string;

  /** The ID of the parent model (e.g. team.id). Set during hydrate(). */
  parentId: string = "";

  // In the engine, getCoveringPartialIndexValues() computes these.
  // For a simple case: [{ key: "teamId", value: "t-eng" }]
  private partialIndexValues: Array<{ key: string; value: string }> = [];

  private loader:
    | ((modelName: string, queries: Array<{ key: string; value: string }>) => Promise<T[]>)
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
    loader: (modelName: string, queries: Array<{ key: string; value: string }>) => Promise<T[]>,
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
    return all.filter((m) => (m as Record<string, unknown>)[this.inverseKey] === this.parentId);
  }

  async load(): Promise<T[]> {
    if (this.state === CollectionState.Loading) {
      return this.items;
    }

    runInAction(() => {
      this.state = CollectionState.Loading;
      this.error = null;
    });

    try {
      const results =
        this.loader != null
          ? await this.loader(this.referencedModelName, this.partialIndexValues)
          : [];

      runInAction(() => {
        this.items = results;
        this.state = CollectionState.Loaded;
      });

      this.notifyListeners();
      return results;
    } catch (err) {
      runInAction(() => {
        this.error = err as Error;
        this.state = CollectionState.Error;
      });
      this.notifyListeners();
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// LazyBackReference
//
// A single inverse reference. When the owning model is deleted, the
// back-referenced model should also be removed (cascade).
//
// Example: Issue has @BackReference("Favorite", "issueId")
// → issue.favorite is a LazyBackReference that resolves the Favorite
//   where issueId === issue.id
// → when Issue is deleted, the Favorite is cascade-removed from the pool
// ---------------------------------------------------------------------------

export class LazyBackReference<T extends BaseModel = BaseModel> {
  value: T | null = null;

  state: CollectionState = CollectionState.Idle;
  error: Error | null = null;

  readonly referencedModelName: string;
  readonly inverseOf: string; // the property on the other model (e.g. "issueId")

  parentId: string = "";

  private loader: ((modelName: string, key: string, value: string) => Promise<T | null>) | null =
    null;

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

  setLoader(loader: (modelName: string, key: string, value: string) => Promise<T | null>) {
    this.loader = loader;
  }

  /** Resolve from pool synchronously. */
  resolveFromPool(pool: { getAll(name: string): BaseModel[] }): T | null {
    if (pool == null || this.parentId === "") {
      return null;
    }
    const all = pool.getAll(this.referencedModelName) as T[];
    return all.find((m) => (m as Record<string, unknown>)[this.inverseOf] === this.parentId) ?? null;
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
          ? await this.loader(this.referencedModelName, this.inverseOf, this.parentId)
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

  get isLoaded() {
    return this.state === CollectionState.Loaded;
  }
  get isLoading() {
    return this.state === CollectionState.Loading;
  }
}
