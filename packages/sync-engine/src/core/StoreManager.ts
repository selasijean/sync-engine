/**
 * StoreManager — the top-level orchestrator.
 *
 * Owns: ObjectPool, Database, TransactionQueue, SyncConnection, all Stores.
 *
 * Bootstrap phases (for loading indicators):
 *   idle → creatingStores → connectingDatabase → determiningBootstrapType
 *        → fetching → writingToDatabase → hydrating → connectingSync → ready
 *
 * Batch API:
 *   storeManager.batch(() => {
 *     issue.title = "x"; issue.save();
 *     team.name = "y"; team.save();
 *   });
 *   storeManager.undo(); // reverts both
 *
 * Lazy loading:
 *   storeManager.loadCollection("Issue", "teamId", teamId)
 *   storeManager.loadOne("DocumentContent", docId)
 */

import { ModelRegistry } from "./ModelRegistry";
import { ObjectPool } from "./ObjectPool";
import { Database, BootstrapType, type StorageAdapter } from "./Database";
import { FullStore, PartialStore, type ModelStore } from "./Store";
import { TransactionQueue, type TransactionSender } from "./TransactionQueue";
import {
  SyncConnection,
  type DeltaPacket,
  type SSEClientFactory,
} from "./SyncConnection";
import { BaseModel } from "./BaseModel";
import {
  BootstrapPhase,
  LoadStrategy,
  PropertyType,
  type PropertyChange,
} from "./types";

function prop(model: BaseModel, key: string): unknown {
  return (model as unknown as Record<string, unknown>)[key];
}

/**
 * Thrown when a delete/archive is blocked by an onDelete: "restrict" relationship.
 *
 * Example: if Label has @Reference("Team", { onDelete: "restrict" }) and you
 * try to delete a Team that has Labels pointing to it, this error is thrown
 * with details about which model and property blocked the deletion.
 */
export class RestrictDeleteError extends Error {
  constructor(
    public deletedModelName: string,
    public deletedModelId: string,
    public restrictedByModel: string,
    public restrictedByProperty: string,
  ) {
    super(
      `Cannot delete ${deletedModelName} "${deletedModelId}": ` +
        `referenced by ${restrictedByModel}.${restrictedByProperty} with onDelete: "restrict"`,
    );
    this.name = "RestrictDeleteError";
  }
}

export interface BootstrapResponse {
  lastSyncId: number;
  subscribedSyncGroups: string[];
  models: Record<string, Record<string, unknown>[]>;
  /** Server-side schema version. Mismatch with stored value → full bootstrap. */
  backendDatabaseVersion?: number;
}

/**
 * Fetches bootstrap data from the server.
 * @param type "full" for everything, "partial" for delta since sinceSyncId
 * @param sinceSyncId for partial: the lastSyncId to fetch changes since
 * @param onlyModels optional: restrict to these model types (for two-phase bootstrap)
 */
export type BootstrapFetcher = (
  type: BootstrapType.Full | BootstrapType.Partial,
  sinceSyncId?: number,
  onlyModels?: string[],
) => Promise<BootstrapResponse>;

/**
 * Fetches models scoped to specific sync groups.
 * Called when a delta packet adds the user to new sync groups
 * (e.g. user joins a new team → fetch all Issues for that team).
 */
export type SyncGroupFetcher = (
  addedGroups: string[],
) => Promise<Record<string, Record<string, unknown>[]>>;

export interface StoreManagerConfig {
  workspaceId: string;
  bootstrapFetcher: BootstrapFetcher;
  transactionSender?: TransactionSender;
  syncGroupFetcher?: SyncGroupFetcher;
  syncUrl?: string;

  /**
   * Custom SSE client factory. Defaults to the browser's built-in EventSource.
   * Override to use the engine outside the browser — e.g. in Node.js or an agent:
   *
   *   import EventSource from "eventsource";
   *   sseClientFactory: (url) => new EventSource(url)
   */
  sseClientFactory?: SSEClientFactory;

  /**
   * Custom storage backend. Defaults to IndexedDB (`Database`).
   * Override for environments without IndexedDB — e.g. Node.js agents:
   *
   *   import { MemoryAdapter } from "./MemoryAdapter";
   *   storageAdapter: new MemoryAdapter()
   *
   * Implement `StorageAdapter` to plug in SQLite, Redis, or any other backend.
   * If omitted, `Database` is used and gracefully falls back to in-memory when
   * IndexedDB is unavailable (no crash, but no persistence across restarts).
   */
  storageAdapter?: StorageAdapter;

  /**
   * Maximum number of undo entries kept in memory. Defaults to 100.
   * Lower this for long-running agents that make many writes and don't need
   * deep undo history (each entry holds model snapshots).
   */
  undoLimit?: number;

  /**
   * Two-phase full bootstrap. If provided, the first fetch loads only
   * the critical models (everything NOT in this list). Once hydrated
   * and the UI is interactive, a second background fetch loads these
   * deferred models. The first fetch loads critical models (e.g.
   * Issue/Team/User) and the second loads the rest (e.g. Comment/Reaction/Attachment).
   *
   * If not provided, all models are fetched in a single request.
   */
  deferredModels?: string[];

  /**
   * Progressive / on-demand loading. When provided, models with
   * Partial/Lazy/ExplicitlyRequested load strategies are NOT included
   * in the bootstrap fetch. Instead, the first time a collection is
   * accessed (e.g. issue.comments.load()), this fetcher is called with
   * the scoped query. Results are written to IDB and hydrated into the
   * pool, so subsequent accesses are served locally.
   *
   * SSE deltas still write to IDB for these model types, but new
   * inserts are only hydrated into the pool if the relevant collection
   * has already been loaded for that parent.
   */
  onDemandFetcher?: (
    modelName: string,
    indexKey: string,
    value: string,
  ) => Promise<Record<string, unknown>[]>;

  /** Batch ID lookup used by loadByIds — receives all missing IDs at once so
   * the caller can make a single server request instead of one per ID. */
  onDemandBatchFetcher?: (
    modelName: string,
    ids: string[],
  ) => Promise<Record<string, unknown>[]>;

  onPhaseChange?: (phase: BootstrapPhase, detail?: string) => void;
  onDeltaPacket?: (packet: DeltaPacket) => void;
  onReady?: () => void;
}

export class StoreManager {
  readonly objectPool: ObjectPool;
  readonly database: StorageAdapter;
  readonly transactionQueue: TransactionQueue;

  private stores = new Map<string, ModelStore>();
  private syncConnection: SyncConnection | null = null;
  private config: StoreManagerConfig;
  private _phase = BootstrapPhase.Idle;
  private _error: Error | null = null;

  /**
   * Tracks collections that have been loaded into the pool this session.
   * Key format: "ModelName:indexKey:value" (e.g. "Comment:issueId:abc").
   * Serves two purposes: gates repeat server fetches and signals SyncConnection
   * whether SSE inserts should be hydrated into the pool immediately.
   */
  private loadedCollections = new Set<string>();
  private loadedIds = new Set<string>();

  constructor(config: StoreManagerConfig) {
    this.config = config;
    this.objectPool = new ObjectPool();
    this.database = config.storageAdapter ?? new Database(config.workspaceId);
    this.transactionQueue = new TransactionQueue(
      this.database,
      this.objectPool,
      config.undoLimit,
    );
    if (config.transactionSender != null) {
      this.transactionQueue.setSender(config.transactionSender);
    }
    BaseModel.storeManager = this; // wire auto-commit
  }

  // ── Bootstrap phases ──────────────────────────────────────────────────────

  get phase() {
    return this._phase;
  }
  get error() {
    return this._error;
  }
  get isReady() {
    return this._phase === BootstrapPhase.Ready;
  }

  private setPhase(phase: BootstrapPhase, detail?: string) {
    this._phase = phase;
    this.config.onPhaseChange?.(phase, detail);
  }

  // ── Bootstrap pipeline ────────────────────────────────────────────────────

  async bootstrap(): Promise<void> {
    if (ModelRegistry.allModels().length === 0) {
      throw new Error(
        "No models registered. Import your model files before calling bootstrap().\n" +
          'Example: import "@/lib/models"; // register models',
      );
    }
    try {
      this.setPhase(BootstrapPhase.CreatingStores);
      for (const meta of ModelRegistry.allModels()) {
        const isPartial =
          meta.loadStrategy === LoadStrategy.Partial ||
          meta.loadStrategy === LoadStrategy.ExplicitlyRequested;
        this.stores.set(
          meta.name,
          isPartial
            ? new PartialStore(meta, this.database, this.objectPool)
            : new FullStore(meta, this.database, this.objectPool),
        );
      }

      this.setPhase(BootstrapPhase.ConnectingDatabase);
      await this.database.connect();

      this.setPhase(BootstrapPhase.DeterminingBootstrapType);
      const type = await this.database.determineBootstrapType();

      if (type === BootstrapType.Full) {
        await this.fullBootstrap();
      } else if (type === BootstrapType.Partial) {
        await this.partialBootstrap();
      } else {
        await this.localBootstrap();
      }

      this.setPhase(BootstrapPhase.ConnectingSync);
      if (this.config.syncUrl != null) {
        this.syncConnection = new SyncConnection(
          this.config.syncUrl,
          this.database,
          this.objectPool,
          this.transactionQueue,
          this.config.onDeltaPacket,
          this.config.syncGroupFetcher != null
            ? (added, _removed) => this.handleSyncGroupsAdded(added)
            : undefined,
          this.isCollectionLoaded.bind(this),
          this.config.sseClientFactory,
        );
        this.syncConnection.connect();
      }
      await this.transactionQueue.resendCached();

      this.setPhase(BootstrapPhase.Ready);
      this.config.onReady?.();
    } catch (err) {
      this._error = err as Error;
      this.setPhase(BootstrapPhase.Error, (err as Error).message);
      throw err;
    }
  }

  /**
   * Full bootstrap — two-phase fetch.
   *
   * Phase 1: Fetch critical models (everything NOT in deferredModels).
   *          Write to IDB, hydrate into ObjectPool. UI can render.
   *
   * Phase 2: Fetch deferred models (Comment, Reaction, Attachment, etc.)
   *          in the background after the engine is marked ready.
   *          These are less critical for the initial render.
   *
   * If deferredModels is not configured, everything is fetched in one request.
   */
  private async fullBootstrap() {
    const deferred = new Set(this.config.deferredModels ?? []);
    const allModelNames = ModelRegistry.allModels().map((m) => m.name);

    if (deferred.size > 0) {
      // Phase 1: critical models only
      const criticalModels = allModelNames.filter((n) => !deferred.has(n));
      this.setPhase(
        BootstrapPhase.Fetching,
        `phase 1: ${criticalModels.length} critical models`,
      );
      const res = await this.config.bootstrapFetcher(
        BootstrapType.Full,
        undefined,
        criticalModels,
      );

      this.setPhase(BootstrapPhase.WritingToDatabase);
      await Promise.all(
        Object.entries(res.models).map(([name, records]) => {
          const store = this.stores.get(name);
          return store != null
            ? store.loadFromServer(records)
            : Promise.resolve();
        }),
      );

      this.setPhase(BootstrapPhase.Hydrating, `${this.objectPool.size} models`);
      await this.database.saveMeta({
        lastSyncId: res.lastSyncId,
        firstSyncId: res.lastSyncId,
        subscribedSyncGroups: res.subscribedSyncGroups,
        schemaHash: ModelRegistry.schemaHash,
        dbVersion: this.database.currentMeta?.dbVersion ?? 1,
        backendDatabaseVersion: res.backendDatabaseVersion ?? 0,
      });

      // Phase 2: deferred models — runs AFTER bootstrap() returns and the
      // engine is marked ready. The UI is already interactive at this point.
      const deferredModels = allModelNames.filter((n) => deferred.has(n));
      if (deferredModels.length > 0) {
        this.fetchDeferredModels(deferredModels, res.lastSyncId);
      }
    } else {
      // Single-phase: fetch everything at once
      this.setPhase(BootstrapPhase.Fetching, "full");
      const res = await this.config.bootstrapFetcher(BootstrapType.Full);

      this.setPhase(BootstrapPhase.WritingToDatabase);
      await Promise.all(
        Object.entries(res.models).map(([name, records]) => {
          const store = this.stores.get(name);
          return store != null
            ? store.loadFromServer(records)
            : Promise.resolve();
        }),
      );

      this.setPhase(BootstrapPhase.Hydrating, `${this.objectPool.size} models`);
      await this.database.saveMeta({
        lastSyncId: res.lastSyncId,
        firstSyncId: res.lastSyncId,
        subscribedSyncGroups: res.subscribedSyncGroups,
        schemaHash: ModelRegistry.schemaHash,
        dbVersion: this.database.currentMeta?.dbVersion ?? 1,
        backendDatabaseVersion: res.backendDatabaseVersion ?? 0,
      });
    }
  }

  /**
   * Background fetch for deferred models (phase 2).
   * Runs after the engine is ready — the UI is already interactive.
   * Fetches as partial (since the lastSyncId we already have) to pick up
   * any changes that happened during phase 1.
   */
  private async fetchDeferredModels(modelNames: string[], sinceSyncId: number) {
    try {
      const res = await this.config.bootstrapFetcher(
        BootstrapType.Partial,
        sinceSyncId,
        modelNames,
      );
      await Promise.all(
        Object.entries(res.models).map(([name, records]) => {
          const store = this.stores.get(name);
          return store != null
            ? store.loadFromServer(records)
            : Promise.resolve();
        }),
      );
      // Update lastSyncId if the server advanced during our fetch
      const meta = this.database.currentMeta;
      if (meta != null && res.lastSyncId > meta.lastSyncId) {
        meta.lastSyncId = res.lastSyncId;
        await this.database.saveMeta(meta);
      }
    } catch {
      // Deferred fetch failure is non-fatal — models load on demand later
    }
  }

  private async partialBootstrap() {
    const existing = this.database.currentMeta!;

    // Load from IDB first — UI renders immediately with cached data
    this.setPhase(BootstrapPhase.Hydrating, "from IndexedDB");
    await Promise.all(
      [...this.stores.entries()]
        .filter(
          ([name]) =>
            ModelRegistry.getModelMeta(name)?.loadStrategy ===
            LoadStrategy.Instant,
        )
        .map(([, store]) => store.loadFromDatabase()),
    );

    // Fetch delta from server
    this.setPhase(
      BootstrapPhase.Fetching,
      `since syncId ${existing.lastSyncId}`,
    );
    const res = await this.config.bootstrapFetcher(
      BootstrapType.Partial,
      existing.lastSyncId,
    );

    // Check backendDatabaseVersion. If the server's schema changed since our
    // last bootstrap, the delta data might be structured differently (renamed
    // fields, restructured models). We can't safely apply it — fall back to full.
    if (
      res.backendDatabaseVersion !== undefined &&
      existing.backendDatabaseVersion !== undefined &&
      res.backendDatabaseVersion !== existing.backendDatabaseVersion
    ) {
      this.objectPool.clear();
      await this.fullBootstrap();
      return;
    }

    // Apply delta
    this.setPhase(BootstrapPhase.WritingToDatabase);
    for (const [name, records] of Object.entries(res.models)) {
      await this.database.writeModels(name, records);
      const meta = ModelRegistry.getModelMeta(name);
      if (meta?.loadStrategy === LoadStrategy.Instant) {
        for (const r of records) {
          const existing = this.objectPool.getById(name, r.id as string);
          if (existing != null) {
            for (const [k, v] of Object.entries(r)) {
              if (k !== "id") {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (existing as any)[k] = v;
              }
            }
          } else {
            this.objectPool.hydrateAndPut(name, meta, r);
          }
        }
      }
    }
    await this.database.saveMeta({
      ...existing,
      lastSyncId: res.lastSyncId,
      subscribedSyncGroups: res.subscribedSyncGroups,
      schemaHash: ModelRegistry.schemaHash,
      dbVersion: existing.dbVersion ?? 1,
      backendDatabaseVersion:
        res.backendDatabaseVersion ?? existing.backendDatabaseVersion ?? 0,
    });
  }

  private async localBootstrap() {
    this.setPhase(BootstrapPhase.Hydrating, "from IndexedDB");
    await Promise.all(
      [...this.stores.entries()]
        .filter(
          ([name]) =>
            ModelRegistry.getModelMeta(name)?.loadStrategy ===
            LoadStrategy.Instant,
        )
        .map(([, store]) => store.loadFromDatabase()),
    );
  }

  // ── Transaction API ────────────────────────────────────────────────────────

  commitCreate(model: BaseModel) {
    const meta = ModelRegistry.getMetaForInstance(model);
    if (meta == null) {
      return;
    }
    model.makeModelObservable();
    this.objectPool.put(meta.name, model);
    const data = model.serialize();
    this.transactionQueue.enqueueCreate(model.id, meta.name, data);
  }

  commitUpdate(
    modelId: string,
    modelName: string,
    changes: Record<string, PropertyChange>,
  ) {
    this.transactionQueue.enqueueUpdate(modelId, modelName, changes);
  }

  /**
   * Delete a model WITH client-side cascade and restrict validation.
   *
   * Pre-validation: checks for References with onDelete: "restrict".
   * If any model instance references the one being deleted via a restrict
   * relationship, the delete is refused with a RestrictDeleteError.
   *
   * Cascade: walks the ModelRegistry for:
   *   - BackReferences pointing at this model → delete those "owned" models
   *   - References with onDelete: "cascade" → delete those dependent models
   *   - References with onDelete: "nullify" → set the reference to null
   *
   * All operations are grouped in a batch so undo reverses everything.
   */
  deleteModel(model: BaseModel) {
    const meta = ModelRegistry.getMetaForInstance(model);
    if (meta == null) {
      return this.transactionQueue.enqueueDelete(model);
    }

    // Pre-validate: check onDelete: "restrict"
    const restriction = this.checkDeleteRestriction(meta.name, model.id);
    if (restriction != null) {
      throw new RestrictDeleteError(
        meta.name,
        model.id,
        restriction.modelName,
        restriction.propertyName,
      );
    }

    const batchId = this.transactionQueue.beginBatch();
    try {
      this.cascadeDeleteClient(meta.name, model.id);
      this.transactionQueue.enqueueDelete(model);
    } finally {
      this.transactionQueue.endBatch(batchId);
    }
  }

  /** Archive a model WITH client-side cascade and restrict validation. */
  archiveModel(model: BaseModel) {
    const meta = ModelRegistry.getMetaForInstance(model);
    if (meta == null) {
      return this.transactionQueue.enqueueArchive(model);
    }

    const restriction = this.checkDeleteRestriction(meta.name, model.id);
    if (restriction != null) {
      throw new RestrictDeleteError(
        meta.name,
        model.id,
        restriction.modelName,
        restriction.propertyName,
      );
    }

    const batchId = this.transactionQueue.beginBatch();
    try {
      this.cascadeArchiveClient(meta.name, model.id);
      this.transactionQueue.enqueueArchive(model);
    } finally {
      this.transactionQueue.endBatch(batchId);
    }
  }

  /**
   * Check if any Reference with onDelete: "restrict" blocks this deletion.
   *
   * Walks all registered models. For each Reference property that points
   * to the model type being deleted and has onDelete: "restrict", checks
   * if any instance in the ObjectPool actually references the target ID.
   *
   * Returns the first restriction found, or null if deletion is allowed.
   */
  private checkDeleteRestriction(
    deletedModelName: string,
    deletedModelId: string,
  ): { modelName: string; propertyName: string } | null {
    for (const meta of ModelRegistry.allModels()) {
      for (const [propName, propMeta] of meta.properties) {
        if (propMeta.type !== PropertyType.Reference) {
          continue;
        }
        if (propMeta.referenceTo !== deletedModelName) {
          continue;
        }
        if (propMeta.onDelete !== "restrict") {
          continue;
        }

        // Found a restrict relationship. Check if any instance references our target.
        for (const model of this.objectPool.getAll(meta.name)) {
          if (prop(model, propName) === deletedModelId) {
            return { modelName: meta.name, propertyName: propName };
          }
        }
      }
    }
    return null;
  }

  /**
   * Client-side cascade: find and delete/nullify models that reference the
   * one being deleted. Mirrors SyncConnection.cascadeDelete but creates
   * actual transactions (so undo works).
   */
  private cascadeDeleteClient(
    deletedModelName: string,
    deletedModelId: string,
  ) {
    for (const meta of ModelRegistry.allModels()) {
      for (const [propName, propMeta] of meta.properties) {
        // BackReference: "owned by" the deleted model → delete them
        if (
          propMeta.type === PropertyType.BackReference &&
          propMeta.referenceTo === deletedModelName
        ) {
          const inverseKey = propMeta.inverseOf!;
          for (const model of this.objectPool.getAll(meta.name)) {
            if (prop(model, inverseKey) === deletedModelId) {
              this.transactionQueue.enqueueDelete(model);
            }
          }
        }

        // Reference with onDelete: "cascade" → delete dependents
        if (
          propMeta.type === PropertyType.Reference &&
          propMeta.referenceTo === deletedModelName &&
          propMeta.onDelete === "cascade"
        ) {
          for (const model of this.objectPool.getAll(meta.name)) {
            if (prop(model, propName) === deletedModelId) {
              this.transactionQueue.enqueueDelete(model);
            }
          }
        }

        // Reference with onDelete: "nullify" → set reference to null
        if (
          propMeta.type === PropertyType.Reference &&
          propMeta.referenceTo === deletedModelName &&
          propMeta.onDelete === "nullify"
        ) {
          for (const model of this.objectPool.getAll(meta.name)) {
            if (prop(model, propName) === deletedModelId) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (model as any)[propName] = null;
              model.save();
            }
          }
        }
      }
    }
  }

  /** Same cascade logic for archive. */
  private cascadeArchiveClient(
    archivedModelName: string,
    archivedModelId: string,
  ) {
    // Archive cascade is similar but uses onArchive metadata
    for (const meta of ModelRegistry.allModels()) {
      for (const [_propName, propMeta] of meta.properties) {
        if (
          propMeta.type === PropertyType.BackReference &&
          propMeta.referenceTo === archivedModelName
        ) {
          const inverseKey = propMeta.inverseOf!;
          for (const model of this.objectPool.getAll(meta.name)) {
            if (prop(model, inverseKey) === archivedModelId) {
              this.transactionQueue.enqueueArchive(model);
            }
          }
        }
      }
    }
  }

  // ── Sync group scoped loading ─────────────────────────────────────────────

  /**
   * Called by SyncConnection when new sync groups are added.
   * Fetches all models scoped to those groups from the server,
   * writes to IDB, and hydrates instant-load ones into the pool.
   *
   * Example: user joins team "t-design" → fetch all Issues, Comments,
   * etc. that belong to that team.
   */
  private async handleSyncGroupsAdded(addedGroups: string[]): Promise<void> {
    if (this.config.syncGroupFetcher == null || addedGroups.length === 0) {
      return;
    }

    const models = await this.config.syncGroupFetcher(addedGroups);

    for (const [modelName, records] of Object.entries(models)) {
      // Write to IDB
      await this.database.writeModels(modelName, records);

      // Hydrate instant-load models into the pool
      const meta = ModelRegistry.getModelMeta(modelName);
      if (meta?.loadStrategy === LoadStrategy.Instant) {
        for (const record of records) {
          const existing = this.objectPool.getById(
            modelName,
            record.id as string,
          );
          if (existing != null) {
            // Update existing model with new data
            for (const [k, v] of Object.entries(record)) {
              if (k !== "id") {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (existing as any)[k] = v;
              }
            }
          } else {
            this.objectPool.hydrateAndPut(modelName, meta, record);
          }
        }
      }
    }
  }

  // ── Batch API ─────────────────────────────────────────────────────────────

  /** Run a function inside a batch. All save() calls share a batchId.
   * Accepts both sync and async functions — endBatch is always called
   * after the function (or its returned Promise) completes.
   */
  batch(fn: () => void): string;
  batch(fn: () => Promise<void>): Promise<string>;
  batch(fn: () => void | Promise<void>): string | Promise<string> {
    const id = this.transactionQueue.beginBatch();
    let result: void | Promise<void>;
    try {
      result = fn();
    } catch (err) {
      this.transactionQueue.endBatch(id);
      throw err;
    }
    if (result instanceof Promise) {
      return result
        .finally(() => this.transactionQueue.endBatch(id))
        .then(() => id);
    }
    this.transactionQueue.endBatch(id);
    return id;
  }

  beginBatch() {
    return this.transactionQueue.beginBatch();
  }
  endBatch(id: string) {
    this.transactionQueue.endBatch(id);
  }

  // ── Undo / Redo ───────────────────────────────────────────────────────────

  undo() {
    return this.transactionQueue.undo();
  }
  redo() {
    return this.transactionQueue.redo();
  }

  // ── Lazy loading ──────────────────────────────────────────────────────────

  private static collectionKey(
    modelName: string,
    indexKey: string,
    value: string,
  ): string {
    return `${modelName}:${indexKey}:${value}`;
  }

  /** Load all instances where indexKey === value (e.g. all Issues for a team). */
  async loadCollection<T extends BaseModel = BaseModel>(
    modelName: string,
    indexKey: string,
    value: string,
  ): Promise<T[]> {
    const inMemory = this.objectPool
      .getAll(modelName)
      .filter((m) => prop(m, indexKey) === value);
    const inMemoryIds = new Set(inMemory.map((m) => m.id));

    const key = StoreManager.collectionKey(modelName, indexKey, value);
    const meta = ModelRegistry.getModelMeta(modelName);

    if (
      meta?.loadStrategy !== LoadStrategy.Instant &&
      this.config.onDemandFetcher != null &&
      !this.loadedCollections.has(key)
    ) {
      // The server fetch intentionally happens before the IDB read.
      //
      // IDB may already contain some records for this collection — written by
      // prior SSE delta packets — but those are a partial view. There is no way
      // to tell from IDB alone whether the set is complete. The server is the
      // only authoritative source for "all records where indexKey = value".
      //
      // By fetching first and writing the results into IDB, the subsequent IDB
      // read below acts as a merge: it picks up both the freshly fetched records
      // and anything SSE had already written. loadedCollections is then marked,
      // so future calls skip the server entirely and trust IDB as complete.
      //
      // Contrast with loadOne: a single ID lookup is binary — either the record
      // is in IDB or it isn't — so the server is only consulted as a last resort.
      const serverRecords = await this.config.onDemandFetcher(
        modelName,
        indexKey,
        value,
      );
      if (serverRecords.length > 0) {
        await this.database.writeModels(modelName, serverRecords);
      }
      // Mark loaded before the IDB read so SSE inserts arriving during
      // that read are hydrated directly rather than waiting for next access.
      this.loadedCollections.add(key);
    }

    const idbRecords = await this.database.readModelsByIndex(
      modelName,
      indexKey,
      value,
    );
    const results = [...inMemory] as T[];

    if (meta != null) {
      for (const record of idbRecords) {
        if (!inMemoryIds.has(record.id as string)) {
          results.push(
            this.objectPool.hydrateAndPut(modelName, meta, record) as T,
          );
        }
      }
    }

    this.loadedCollections.add(key);
    return results;
  }

  private isCollectionLoaded(
    modelName: string,
    indexKey: string,
    value: string,
  ): boolean {
    return this.loadedCollections.has(
      StoreManager.collectionKey(modelName, indexKey, value),
    );
  }

  /** Load multiple models by ID (for OwnedCollection resolution). */
  async loadByIds(modelName: string, ids: string[]): Promise<BaseModel[]> {
    if (ids.length === 0) {
      return [];
    }

    const meta = ModelRegistry.getModelMeta(modelName);
    if (meta == null) {
      return [];
    }

    const missingFromPool = ids.filter(
      (id) => this.objectPool.getById(modelName, id) == null,
    );

    if (missingFromPool.length > 0) {
      const idbResults = await Promise.all(
        missingFromPool.map((id) => this.database.readModel(modelName, id)),
      );

      const stillMissing: string[] = [];
      for (let i = 0; i < missingFromPool.length; i++) {
        const record = idbResults[i];
        if (record != null) {
          this.objectPool.hydrateAndPut(modelName, meta, record);
        } else {
          stillMissing.push(missingFromPool[i]);
        }
      }

      if (stillMissing.length > 0) {
        const unloaded = stillMissing.filter(
          (id) => !this.loadedIds.has(`${modelName}:${id}`),
        );
        if (unloaded.length > 0) {
          if (this.config.onDemandBatchFetcher != null) {
            const serverRecords = await this.config.onDemandBatchFetcher(
              modelName,
              unloaded,
            );
            if (serverRecords.length > 0) {
              await this.database.writeModels(modelName, serverRecords);
              for (const record of serverRecords) {
                this.objectPool.hydrateAndPut(modelName, meta, record);
              }
            }
            for (const id of unloaded) {
              this.loadedIds.add(`${modelName}:${id}`);
            }
          } else {
            await Promise.all(
              unloaded.map((id) => this.loadOne(modelName, id)),
            );
          }
        }
      }
    }

    return ids
      .map((id) => this.objectPool.getById(modelName, id))
      .filter((m): m is BaseModel => m != null);
  }

  /** Load a single model by ID (for partial/lazy models not yet in memory). */
  async loadOne<T extends BaseModel = BaseModel>(
    modelName: string,
    id: string,
  ): Promise<T | null> {
    const existing = this.objectPool.getById(modelName, id);
    if (existing != null) {
      return existing as T;
    }

    // Check IDB before hitting the server — server is last resort.
    let record = await this.database.readModel(modelName, id);

    const idKey = `${modelName}:${id}`;
    if (
      record == null &&
      this.config.onDemandFetcher != null &&
      !this.loadedIds.has(idKey)
    ) {
      const serverRecords = await this.config.onDemandFetcher(
        modelName,
        "id",
        id,
      );
      if (serverRecords.length > 0) {
        await this.database.writeModels(modelName, serverRecords);
        record = await this.database.readModel(modelName, id);
      }
      this.loadedIds.add(idKey);
    }

    if (record == null) {
      return null;
    }

    const meta = ModelRegistry.getModelMeta(modelName);
    if (meta == null) {
      return null;
    }

    return this.objectPool.hydrateAndPut(modelName, meta, record) as T;
  }

  // ── Status ────────────────────────────────────────────────────────────────

  status() {
    return {
      phase: this._phase,
      error: this._error?.message,
      workspaceId: this.config.workspaceId,
      objectPoolSize: this.objectPool.size,
      objectPoolCounts: this.objectPool.counts(),
      pending: this.transactionQueue.pendingCount,
      undoDepth: this.transactionQueue.undoDepth,
      redoDepth: this.transactionQueue.redoDepth,
      syncConnected: this.syncConnection?.isConnected ?? false,
      lastSyncId: this.database.currentMeta?.lastSyncId ?? 0,
    };
  }

  async teardown() {
    BaseModel.storeManager = null;
    this.syncConnection?.disconnect();
    this.transactionQueue.destroy();
    await this.database.close();
    this.objectPool.clear();
    this.stores.clear();
    this.loadedCollections.clear();
    this.loadedIds.clear();
    this.setPhase(BootstrapPhase.Idle);
  }
}
