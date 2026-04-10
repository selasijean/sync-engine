/**
 * ObjectPool — the in-memory cache of all hydrated model instances.
 *
 * Structure: Map<modelName, Map<uuid, modelInstance>>
 *
 * This is what @Reference getters resolve against when you access
 * `issue.assignee` — it looks up the User by ID in this pool.
 *
 * Subscription system:
 *   React hooks subscribe to specific model types. When a delta packet
 *   adds, updates, or removes an instance of that type, all subscribers
 *   are notified and their components re-render.
 */

import type { BaseModel } from "./BaseModel";
import { type ModelMeta } from "./types";

type Listener = () => void;

export class ObjectPool {
  private pool = new Map<string, Map<string, BaseModel>>();
  private snapshotCache = new Map<string, BaseModel[]>();

  /**
   * Subscribers per model type. When the pool changes for a given type,
   * all listeners for that type are called, triggering React re-renders.
   */
  private listeners = new Map<string, Set<Listener>>();

  /** Subscribe to changes for a model type. Returns an unsubscribe function. */
  subscribe(modelName: string, listener: Listener): () => void {
    if (!this.listeners.has(modelName)) {
      this.listeners.set(modelName, new Set());
    }
    this.listeners.get(modelName)!.add(listener);
    return () => {
      this.listeners.get(modelName)?.delete(listener);
    };
  }

  private notify(modelName: string) {
    const subs = this.listeners.get(modelName);
    if (subs != null) {
      subs.forEach((fn) => fn());
    }
  }

  // ── Core operations (notify on mutation) ──────────────────────────────────

  getById(modelName: string, id: string): BaseModel | undefined {
    return this.pool.get(modelName)?.get(id);
  }

  /** Store a model instance. Notifies subscribers. */
  put(modelName: string, instance: BaseModel) {
    if (!this.pool.has(modelName)) {
      this.pool.set(modelName, new Map());
    }
    this.pool.get(modelName)!.set(instance.id, instance);
    instance.store = this;
    this.snapshotCache.delete(modelName);
    this.notify(modelName);
  }

  /** Remove a model. Notifies subscribers. */
  remove(modelName: string, id: string) {
    this.pool.get(modelName)?.delete(id);
    this.snapshotCache.delete(modelName);
    this.notify(modelName);
  }

  getAll(modelName: string): BaseModel[] {
    let snapshot = this.snapshotCache.get(modelName);
    if (snapshot === undefined) {
      const bucket = this.pool.get(modelName);
      snapshot = bucket != null ? [...bucket.values()] : [];
      this.snapshotCache.set(modelName, snapshot);
    }
    return snapshot;
  }

  get size(): number {
    let total = 0;
    for (const bucket of this.pool.values()) {
      total += bucket.size;
    }
    return total;
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, bucket] of this.pool) {
      out[name] = bucket.size;
    }
    return out;
  }

  /**
   * Create an instance from raw data, hydrate it, make it observable,
   * and add it to the pool. Used everywhere a new model arrives from
   * the server or IDB — eliminates the repeated 4-line pattern.
   */
  hydrateAndPut(modelName: string, meta: ModelMeta, data: Record<string, unknown>): BaseModel {
    const inst = new meta.ctor();
    inst.hydrate(data);
    inst.makeModelObservable();
    this.put(modelName, inst);
    return inst;
  }

  clear() {
    const names = [...this.pool.keys()];
    this.pool.clear();
    this.snapshotCache.clear();
    names.forEach((n) => this.notify(n));
  }
}
