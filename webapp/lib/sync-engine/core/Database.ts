/**
 * Database — wraps IndexedDB for a single workspace.
 *
 * Schema Migration:
 *   Instead of falling back to full bootstrap on every schemaHash change,
 *   we run actual IDB migrations:
 *     1. Open the DB at its current version to read meta
 *     2. If schemaHash matches → use as-is
 *     3. If schemaHash differs → close, reopen at version+1
 *     4. In onupgradeneeded: add new stores, remove old stores, update indexes
 *   This preserves existing data for unchanged models.
 *
 * Determines bootstrap type:
 *   - Full: no DB or meta, or a critical migration that can't be handled
 *   - Partial: DB exists with valid data, just need delta since lastSyncId
 *   - Local: DB exists, no server contact needed (offline start)
 */

import { ModelRegistry } from "./ModelRegistry";

export interface DatabaseMeta {
  lastSyncId: number;
  firstSyncId: number;
  subscribedSyncGroups: string[];
  schemaHash: string;
  /** IDB version number. Incremented on each client-side schema migration. */
  dbVersion: number;
  /**
   * Server-side schema version. The server sends this with every bootstrap response.
   * If the server's version changes (e.g. renamed columns, restructured models),
   * the client detects the mismatch and forces a full bootstrap to avoid
   * interpreting data against the wrong schema.
   */
  backendDatabaseVersion: number;
}

export enum BootstrapType {
  Full = "full",
  Partial = "partial",
  Local = "local",
}

export class Database {
  private db: IDBDatabase | null = null;
  private workspaceId: string;
  private meta: DatabaseMeta | null = null;

  /** Set to true if a migration added new model stores that need data. */
  migrationAddedNewModels = false;

  constructor(workspaceId: string) {
    this.workspaceId = workspaceId;
  }

  // =========================================================================
  // Connection with schema migration
  // =========================================================================

  async connect(): Promise<void> {
    const dbName = `sync_${this.workspaceId}`;

    // Step 1: Open at current version to read meta and check schema
    this.db = await this.openDB(dbName);
    const meta = await this.loadMeta();

    // Step 2: If schema matches (or first-time connect with no saved meta),
    // the DB is already in the right shape — no migration needed.
    // On a first connect, createAllStores just ran via onupgradeneeded and
    // created all current model stores; closing and reopening would only risk
    // losing that work on some IDB implementations.
    if (meta == null || meta.schemaHash === ModelRegistry.schemaHash) {
      return;
    }

    // Step 3: Schema changed (or first time). Close and reopen with migration.
    const oldVersion = this.db.version;
    const newVersion = (meta.dbVersion ?? oldVersion) + 1;
    this.db.close();
    this.db = null;

    // Step 4: Reopen at newVersion → triggers onupgradeneeded
    this.db = await this.openDBWithMigration(dbName, newVersion);

    // Update the dbVersion in meta after migration
    if (meta != null) {
      meta.dbVersion = newVersion;
      meta.schemaHash = ModelRegistry.schemaHash;
      await this.saveMeta(meta);
    }
  }

  /** Open DB at its current version (no migration). */
  private openDB(dbName: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName);
      request.onupgradeneeded = (event) => {
        // First time creating this DB — set up everything from scratch
        this.createAllStores((event.target as IDBOpenDBRequest).result);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /** Open DB at a specific version, triggering migration in onupgradeneeded. */
  private openDBWithMigration(dbName: string, version: number): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, version);
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        // IMPORTANT: use the upgrade transaction from the event, not db.transaction().
        // IDB doesn't allow new transactions during an upgrade.
        const upgradeTx = (event.target as IDBOpenDBRequest).transaction!;
        this.migrateSchema(db, upgradeTx);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // =========================================================================
  // Schema migration logic
  //
  // Diffs the current IDB object stores against the ModelRegistry:
  //   - New models → create object store + indexes
  //   - Removed models → delete object store
  //   - Changed models → add/remove indexes
  // =========================================================================

  /** Create all stores from scratch (first-time DB creation). */
  private createAllStores(db: IDBDatabase) {
    if (!db.objectStoreNames.contains("__meta")) {
      db.createObjectStore("__meta");
    }
    if (!db.objectStoreNames.contains("__transactions")) {
      db.createObjectStore("__transactions", { autoIncrement: true });
    }
    for (const modelMeta of ModelRegistry.allModels()) {
      this.createModelStore(db, modelMeta.name);
    }
  }

  /** Run an incremental migration: add/remove/update stores. */
  private migrateSchema(db: IDBDatabase, upgradeTx: IDBTransaction) {
    // Ensure system stores exist
    if (!db.objectStoreNames.contains("__meta")) {
      db.createObjectStore("__meta");
    }
    if (!db.objectStoreNames.contains("__transactions")) {
      db.createObjectStore("__transactions", { autoIncrement: true });
    }

    const registeredModels = new Set(ModelRegistry.allModels().map((m) => m.name));
    const existingStores = new Set<string>();
    for (let i = 0; i < db.objectStoreNames.length; i++) {
      const name = db.objectStoreNames[i];
      if (!name.startsWith("__")) {
        existingStores.add(name);
      }
    }

    // Add new model stores
    for (const modelName of registeredModels) {
      if (!existingStores.has(modelName)) {
        this.createModelStore(db, modelName);
        this.migrationAddedNewModels = true;
      }
    }

    // Remove stores for models that no longer exist
    for (const storeName of existingStores) {
      if (!registeredModels.has(storeName)) {
        db.deleteObjectStore(storeName);
      }
    }

    // Update indexes on existing stores using the upgrade transaction
    for (const modelName of registeredModels) {
      if (existingStores.has(modelName)) {
        this.migrateIndexes(upgradeTx, modelName);
      }
    }
  }

  /** Create an object store for a model with its indexed properties. */
  private createModelStore(db: IDBDatabase, modelName: string) {
    const store = db.createObjectStore(modelName, { keyPath: "id" });
    const meta = ModelRegistry.getModelMeta(modelName);
    if (meta != null) {
      for (const [propName, propMeta] of meta.properties) {
        if (propMeta.indexed === true) {
          store.createIndex(propName, propName, { unique: false });
        }
      }
    }
  }

  /** Add/remove indexes on an existing store to match current ModelRegistry. */
  private migrateIndexes(upgradeTx: IDBTransaction, modelName: string) {
    const meta = ModelRegistry.getModelMeta(modelName);
    if (meta == null) {
      return;
    }

    // Use the upgrade transaction — the only transaction that can modify indexes.
    const store = upgradeTx.objectStore(modelName);

    // Indexes that should exist based on current metadata
    const wantedIndexes = new Set<string>();
    for (const [propName, propMeta] of meta.properties) {
      if (propMeta.indexed === true) {
        wantedIndexes.add(propName);
      }
    }

    // Remove indexes that shouldn't exist anymore
    const existingIndexes: string[] = [];
    for (let i = 0; i < store.indexNames.length; i++) {
      existingIndexes.push(store.indexNames[i]);
    }
    for (const indexName of existingIndexes) {
      if (!wantedIndexes.has(indexName)) {
        store.deleteIndex(indexName);
      }
    }

    // Add indexes that don't exist yet
    for (const indexName of wantedIndexes) {
      if (!store.indexNames.contains(indexName)) {
        store.createIndex(indexName, indexName, { unique: false });
      }
    }
  }

  // =========================================================================
  // Bootstrap type detection
  // =========================================================================

  async determineBootstrapType(): Promise<BootstrapType> {
    const meta = await this.loadMeta();

    // No meta → first time → full bootstrap
    if (meta == null) {
      return BootstrapType.Full;
    }

    // If migration added new model stores, those stores need data.
    // A partial bootstrap (delta since lastSyncId) should cover this —
    // the server sends all data for models the client doesn't have.
    // But if the delta is too old, fall back to full.
    if (this.migrationAddedNewModels) {
      // Partial bootstrap should work — server sends everything since lastSyncId,
      // which includes data for the new model types.
      // Only fall back to full if there's no lastSyncId at all.
      if (meta.lastSyncId <= 0) {
        return BootstrapType.Full;
      }
    }

    // Valid data exists
    if (meta.lastSyncId > 0) {
      return BootstrapType.Partial;
    }

    return BootstrapType.Local;
  }

  // =========================================================================
  // Meta
  // =========================================================================

  async loadMeta(): Promise<DatabaseMeta | null> {
    if (this.db == null) {
      return null;
    }
    try {
      const result = await this.idbGet<DatabaseMeta>("__meta", "meta");
      this.meta = result;
      return result;
    } catch {
      // __meta store might not exist yet (first open before upgrade)
      return null;
    }
  }

  async saveMeta(meta: DatabaseMeta): Promise<void> {
    if (this.db == null) {
      return;
    }
    this.meta = meta;
    await this.idbPut("__meta", meta, "meta");
  }

  get currentMeta() {
    return this.meta;
  }

  // =========================================================================
  // Model data operations
  // =========================================================================

  async writeModels(modelName: string, records: Record<string, unknown>[]): Promise<void> {
    if (!this.hasStore(modelName)) {
      return;
    }
    const tx = this.db!.transaction(modelName, "readwrite");
    const store = tx.objectStore(modelName);
    for (const record of records) {
      store.put(record);
    }
    return this.waitForTransaction(tx);
  }

  async readAllModels(modelName: string): Promise<Record<string, unknown>[]> {
    if (!this.hasStore(modelName)) {
      return [];
    }
    return this.idbGetAll(modelName);
  }

  async readModel(modelName: string, id: string): Promise<Record<string, unknown> | null> {
    if (!this.hasStore(modelName)) {
      return null;
    }
    return this.idbGet(modelName, id);
  }

  async readModelsByIndex(
    modelName: string,
    indexName: string,
    value: string,
  ): Promise<Record<string, unknown>[]> {
    if (!this.hasStore(modelName)) {
      return [];
    }
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(modelName, "readonly");
      const store = tx.objectStore(modelName);
      if (store.indexNames.contains(indexName)) {
        const r = store.index(indexName).getAll(value);
        r.onsuccess = () => resolve(r.result ?? []);
        r.onerror = () => reject(r.error);
      } else {
        // Fallback: full scan + filter (slower, but correct)
        const r = store.getAll();
        r.onsuccess = () =>
          resolve((r.result ?? []).filter((rec: Record<string, unknown>) => rec[indexName] === value));
        r.onerror = () => reject(r.error);
      }
    });
  }

  async deleteModel(modelName: string, id: string): Promise<void> {
    if (!this.hasStore(modelName)) {
      return;
    }
    const tx = this.db!.transaction(modelName, "readwrite");
    tx.objectStore(modelName).delete(id);
    return this.waitForTransaction(tx);
  }

  /** Delete multiple records in a single IDB transaction. */
  async deleteModels(modelName: string, ids: string[]): Promise<void> {
    if (!this.hasStore(modelName) || ids.length === 0) {
      return;
    }
    const tx = this.db!.transaction(modelName, "readwrite");
    const store = tx.objectStore(modelName);
    for (const id of ids) {
      store.delete(id);
    }
    return this.waitForTransaction(tx);
  }

  async clearModelStore(modelName: string): Promise<void> {
    if (!this.hasStore(modelName)) {
      return;
    }
    const tx = this.db!.transaction(modelName, "readwrite");
    tx.objectStore(modelName).clear();
    return this.waitForTransaction(tx);
  }

  // =========================================================================
  // Transaction cache
  // =========================================================================

  async cacheTransaction(data: unknown): Promise<number> {
    if (this.db == null) {
      return -1;
    }
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction("__transactions", "readwrite");
      const r = tx.objectStore("__transactions").add(data);
      r.onsuccess = () => resolve(r.result as number);
      r.onerror = () => reject(r.error);
    });
  }

  async getCachedTransactions(): Promise<unknown[]> {
    if (this.db == null) {
      return [];
    }
    return this.idbGetAll("__transactions");
  }

  async deleteCachedTransactions(idbKeys: number[]): Promise<void> {
    if (this.db == null || idbKeys.length === 0) {
      return;
    }
    const tx = this.db.transaction("__transactions", "readwrite");
    const store = tx.objectStore("__transactions");
    for (const key of idbKeys) {
      store.delete(key);
    }
    return this.waitForTransaction(tx);
  }

  async clearCachedTransactions(): Promise<void> {
    if (this.db == null) {
      return;
    }
    const tx = this.db.transaction("__transactions", "readwrite");
    tx.objectStore("__transactions").clear();
    return this.waitForTransaction(tx);
  }

  // =========================================================================
  // Cleanup
  // =========================================================================

  async destroy() {
    this.db?.close();
    this.db = null;
    indexedDB.deleteDatabase(`sync_${this.workspaceId}`);
  }

  get isConnected() {
    return this.db !== null;
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private hasStore(name: string): boolean {
    return this.db != null && this.db.objectStoreNames.contains(name);
  }

  private idbGet<T>(storeName: string, key: string): Promise<T | null> {
    return new Promise((resolve, reject) => {
      const r = this.db!.transaction(storeName, "readonly").objectStore(storeName).get(key);
      r.onsuccess = () => resolve(r.result ?? null);
      r.onerror = () => reject(r.error);
    });
  }

  private idbGetAll<T>(storeName: string): Promise<T[]> {
    return new Promise((resolve, reject) => {
      const r = this.db!.transaction(storeName, "readonly").objectStore(storeName).getAll();
      r.onsuccess = () => resolve(r.result ?? []);
      r.onerror = () => reject(r.error);
    });
  }

  private idbPut(storeName: string, value: unknown, key?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private waitForTransaction(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
