/**
 * TransactionQueue — manages transaction lifecycle and batch undo.
 *
 * Three queues:
 *   pending       → created, not yet sent
 *   executing     → sent to server, awaiting response
 *   awaitingSync  → server ACK'd, waiting for delta packet with syncId
 *
 * Batch undo:
 *   beginBatch() opens a batch. All save() calls inside share a batchId.
 *   endBatch() closes it. undo() pops the entire batch and reverts all.
 *
 * The undo stack stores "entries" — either a single tx or a batch of txs.
 */

import type { StorageAdapter } from "./Database";
import { ObjectPool } from "./ObjectPool";
import { ModelRegistry } from "./ModelRegistry";
import {
  BaseTransaction,
  UpdateTransaction,
  CreateTransaction,
  DeleteTransaction,
  ArchiveTransaction,
} from "./Transaction";
import { TransactionState, type PropertyChange } from "./types";
import type { BaseModel } from "./BaseModel";

export interface BatchResponse {
  success: boolean;
  lastSyncId: number;
}

export type TransactionSender = (
  batch: ReturnType<BaseTransaction["serialize"]>[],
) => Promise<BatchResponse>;

// Shape of a serialized transaction as stored in IndexedDB cache.
interface CachedTransactionRecord {
  action: string;
  modelId: string;
  modelName: string;
  batchId?: string | null;
  changes?: Record<string, PropertyChange>;
  data?: Record<string, unknown>;
  snapshot?: Record<string, unknown>;
}

// An undo entry: either one transaction or a group
type UndoEntry =
  | { kind: "single"; tx: BaseTransaction }
  | { kind: "batch"; batchId: string; txs: BaseTransaction[] };

export class TransactionQueue {
  private database: StorageAdapter;
  private pool: ObjectPool;
  private sender: TransactionSender | null = null;

  // The three queues
  private pending: BaseTransaction[] = [];
  private executing: BaseTransaction[] = [];
  private awaitingSync: BaseTransaction[] = [];

  // Undo/redo
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];

  // Active batch state
  private activeBatchId: string | null = null;
  private activeBatchTxs: BaseTransaction[] = [];

  // When true, enqueue() and endBatch() skip undo stack mutations.
  // Set during undo/redo so their inverse operations don't re-enter the stack.
  private suppressUndoStack = false;

  // Flush timer
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushDelay = 50; // ms — batches rapid saves
  private undoLimit: number;

  constructor(database: StorageAdapter, pool: ObjectPool, undoLimit = 100) {
    this.database = database;
    this.pool = pool;
    this.undoLimit = undoLimit;
  }

  setSender(sender: TransactionSender) {
    this.sender = sender;
  }

  // ── Batch API ─────────────────────────────────────────────────────────────

  beginBatch(): string {
    const batchId = crypto.randomUUID();
    this.activeBatchId = batchId;
    this.activeBatchTxs = [];
    return batchId;
  }

  endBatch(batchId: string) {
    if (this.activeBatchId !== batchId) {
      return;
    }
    if (this.activeBatchTxs.length > 0 && !this.suppressUndoStack) {
      this.undoStack.push({
        kind: "batch",
        batchId,
        txs: [...this.activeBatchTxs],
      });
      if (this.undoStack.length > this.undoLimit) {
        this.undoStack.shift();
      }
      this.redoStack = [];
    }
    this.activeBatchId = null;
    this.activeBatchTxs = [];
  }

  // ── Enqueue methods (one per transaction type) ────────────────────────────

  async enqueueUpdate(
    modelId: string,
    modelName: string,
    changes: Record<string, PropertyChange>,
  ) {
    const tx = new UpdateTransaction(modelId, modelName, changes);
    await this.enqueue(tx);
    return tx;
  }

  async enqueueCreate(
    modelId: string,
    modelName: string,
    data: Record<string, unknown>,
  ) {
    await this.enqueue(new CreateTransaction(modelId, modelName, data));
  }

  async enqueueDelete(model: BaseModel) {
    const meta = ModelRegistry.getMetaForInstance(model);
    const tx = new DeleteTransaction(
      model.id,
      meta?.name ?? "Unknown",
      model.serialize(),
    );
    if (meta != null) {
      this.pool.remove(meta.name, model.id);
    } // optimistic removal
    await this.enqueue(tx);
  }

  async enqueueArchive(model: BaseModel) {
    const meta = ModelRegistry.getMetaForInstance(model);
    const tx = new ArchiveTransaction(
      model.id,
      meta?.name ?? "Unknown",
      model.serialize(),
    );
    if (meta != null) {
      this.pool.remove(meta.name, model.id);
    }
    await this.enqueue(tx);
  }

  private async enqueue(tx: BaseTransaction) {
    tx.state = TransactionState.Pending;

    // Tag with batch if one is active
    if (this.activeBatchId != null) {
      tx.batchId = this.activeBatchId;
      this.activeBatchTxs.push(tx);
    } else if (!this.suppressUndoStack) {
      this.undoStack.push({ kind: "single", tx });
      if (this.undoStack.length > this.undoLimit) {
        this.undoStack.shift();
      }
      this.redoStack = [];
    }

    // Add to pending and schedule flush synchronously so callers can immediately
    // inspect pendingCount without waiting for the IDB cache write to complete.
    this.pending.push(tx);
    this.scheduleFlush();

    // Cache in IDB for offline resilience (async — idbKey needed only for resendCached)
    tx.idbKey = await this.database.cacheTransaction(tx.serialize());
  }

  // ── Flush — send batch to server ──────────────────────────────────────────

  private scheduleFlush() {
    if (this.flushTimer != null) {
      return;
    }
    this.flushTimer = setTimeout(() => this.flush(), this.flushDelay);
  }

  private async flush() {
    this.flushTimer = null;
    if (this.pending.length === 0 || this.sender == null) {
      return;
    }

    const batch = [...this.pending];
    this.pending = [];
    batch.forEach((tx) => (tx.state = TransactionState.Executing));
    this.executing.push(...batch);

    try {
      const response = await this.sender(batch.map((tx) => tx.serialize()));
      this.executing = this.executing.filter((tx) => !batch.includes(tx));

      const batchKeys = batch
        .map((tx) => tx.idbKey)
        .filter((k): k is number => k != null);
      if (response.success) {
        await this.database.deleteCachedTransactions(batchKeys);
        for (const tx of batch) {
          tx.markCompleted(response.lastSyncId);
          this.awaitingSync.push(tx);
        }
      } else {
        // Server rejected — revert first, then remove from IDB so failed
        // transactions don't replay on next app start via resendCached()
        for (let i = batch.length - 1; i >= 0; i--) {
          batch[i].state = TransactionState.Failed;
          this.revertOne(batch[i]);
        }
        await this.database.deleteCachedTransactions(batchKeys);
      }
    } catch {
      // Network error — put back in pending for retry
      this.executing = this.executing.filter((tx) => !batch.includes(tx));
      batch.forEach((tx) => (tx.state = TransactionState.Pending));
      this.pending = [...batch, ...this.pending];
      setTimeout(() => this.scheduleFlush(), 2000);
    }
  }

  // ── Sync completion (called by SyncConnection on delta packet) ────────────

  resolveBySync(receivedSyncId: number): BaseTransaction[] {
    const resolved: BaseTransaction[] = [];
    const remaining: BaseTransaction[] = [];

    for (const tx of this.awaitingSync) {
      if (tx.isSyncedBy(receivedSyncId)) {
        tx.state = TransactionState.Completed;
        resolved.push(tx);
      } else {
        remaining.push(tx);
      }
    }

    this.awaitingSync = remaining;
    return resolved;
  }

  // ── Rebasing (called by SyncConnection for I/U/V/C actions) ───────────────

  rebaseAll(
    modelId: string,
    modelName: string,
    serverData: Record<string, unknown>,
  ) {
    const model = this.pool.getById(modelName, modelId);
    if (model == null) {
      return;
    }

    // Check all active queues for conflicting UpdateTransactions
    const allActive = [
      ...this.pending,
      ...this.executing,
      ...this.awaitingSync,
    ];
    for (const tx of allActive) {
      if (
        tx instanceof UpdateTransaction &&
        tx.modelId === modelId &&
        tx.modelName === modelName &&
        tx.conflictsWith(serverData)
      ) {
        tx.rebase(model, serverData);
      }
    }
  }

  // ── Revert a single transaction ───────────────────────────────────────────

  private revertOne(tx: BaseTransaction) {
    if (tx instanceof UpdateTransaction) {
      const model = this.pool.getById(tx.modelName, tx.modelId);
      if (model != null) {
        tx.revert(model);
        this.pool.put(tx.modelName, model);
      }
    } else if (tx instanceof CreateTransaction) {
      this.pool.remove(tx.modelName, tx.modelId);
    } else if (
      tx instanceof DeleteTransaction ||
      tx instanceof ArchiveTransaction
    ) {
      const meta = ModelRegistry.getModelMeta(tx.modelName);
      if (meta != null) {
        const inst = new meta.ctor() as BaseModel;
        tx.revert(inst);
        this.pool.put(tx.modelName, inst);
      }
    }
  }

  // ── Undo/Redo — batch-aware ───────────────────────────────────────────────

  async undo(): Promise<BaseTransaction[] | null> {
    const entry = this.undoStack.pop();
    if (entry == null) {
      return null;
    }
    this.redoStack.push(entry);

    const txs = entry.kind === "single" ? [entry.tx] : entry.txs;

    // Revert in reverse order, then enqueue inverse operations.
    // suppressUndoStack prevents the inverse transactions from re-entering the undo stack.
    this.suppressUndoStack = true;
    const batchId = this.beginBatch();
    for (let i = txs.length - 1; i >= 0; i--) {
      const tx = txs[i];
      if (tx instanceof UpdateTransaction) {
        const model = this.pool.getById(tx.modelName, tx.modelId);
        if (model != null) {
          tx.revert(model);
          this.pool.put(tx.modelName, model);
          const inverse: Record<string, PropertyChange> = {};
          for (const [p, c] of tx.changes) {
            inverse[p] = { oldValue: c.newValue, newValue: c.oldValue };
          }
          await this.enqueueUpdate(tx.modelId, tx.modelName, inverse);
        }
      } else if (tx instanceof CreateTransaction) {
        const model = this.pool.getById(tx.modelName, tx.modelId);
        if (model != null) {
          await this.enqueueDelete(model);
        }
      } else if (tx instanceof DeleteTransaction) {
        const meta = ModelRegistry.getModelMeta(tx.modelName);
        if (meta != null) {
          this.pool.hydrateAndPut(tx.modelName, meta, tx.snapshot);
          await this.enqueueCreate(tx.modelId, tx.modelName, tx.snapshot);
        }
      }
    }
    this.endBatch(batchId);
    this.suppressUndoStack = false;
    return txs;
  }

  async redo(): Promise<BaseTransaction[] | null> {
    const entry = this.redoStack.pop();
    if (entry == null) {
      return null;
    }
    this.undoStack.push(entry);

    const txs = entry.kind === "single" ? [entry.tx] : entry.txs;
    this.suppressUndoStack = true;
    const batchId = this.beginBatch();
    for (const tx of txs) {
      if (tx instanceof UpdateTransaction) {
        const model = this.pool.getById(tx.modelName, tx.modelId);
        if (model != null) {
          const changes: Record<string, PropertyChange> = {};
          for (const [p, c] of tx.changes) {
            // Dynamic property assignment on BaseModel — no better type for runtime field access
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (model as any)[p] = c.newValue;
            changes[p] = { oldValue: c.oldValue, newValue: c.newValue };
          }
          this.pool.put(tx.modelName, model);
          await this.enqueueUpdate(tx.modelId, tx.modelName, changes);
        }
      } else if (tx instanceof DeleteTransaction) {
        const model = this.pool.getById(tx.modelName, tx.modelId);
        if (model != null) {
          await this.enqueueDelete(model);
        }
      } else if (tx instanceof CreateTransaction) {
        const meta = ModelRegistry.getModelMeta(tx.modelName);
        if (meta != null) {
          this.pool.hydrateAndPut(tx.modelName, meta, tx.data);
          await this.enqueueCreate(tx.modelId, tx.modelName, tx.data);
        }
      }
    }
    this.endBatch(batchId);
    this.suppressUndoStack = false;
    return txs;
  }

  // ── Reconnection ──────────────────────────────────────────────────────────

  async resendCached(): Promise<number> {
    const cached = await this.database.getCachedTransactions();
    if (cached.length === 0) {
      return 0;
    }

    // Clear before re-enqueueing. Reconstructed transactions don't carry their
    // original idbKey, so flush() would see null keys and never delete them —
    // causing the same transactions to replay on every subsequent restart.
    // Clearing upfront means flush() has nothing to clean up, which is correct.
    await this.database.clearCachedTransactions();

    // Build a signature set for transactions already in-flight, pending, or awaiting sync.
    // If a transaction is currently being sent (executing) or already queued (pending),
    // re-enqueueing from IDB would send a duplicate to the server.
    // For INSERT this causes a conflict error → success:false → revertOne() removes
    // the model from the pool (the "create after sleep doesn't show up" bug).
    // UPDATE and DELETE are idempotent on the server, but skipping is still correct.
    const inFlight = new Set<string>();
    for (const tx of [
      ...this.pending,
      ...this.executing,
      ...this.awaitingSync,
    ]) {
      inFlight.add(`${tx.action}:${tx.modelName}:${tx.modelId}`);
    }

    let count = 0;
    for (const d of cached as CachedTransactionRecord[]) {
      if (inFlight.has(`${d.action}:${d.modelName}:${d.modelId}`)) {
        continue; // already being sent — skip to avoid duplicate
      }

      let tx: BaseTransaction;
      switch (d.action) {
        case "U":
          tx = new UpdateTransaction(d.modelId, d.modelName, d.changes!);
          break;
        case "I":
          tx = new CreateTransaction(d.modelId, d.modelName, d.data!);
          break;
        case "D":
          tx = new DeleteTransaction(d.modelId, d.modelName, d.snapshot!);
          break;
        case "A":
          tx = new ArchiveTransaction(d.modelId, d.modelName, d.snapshot!);
          break;
        default:
          continue;
      }
      tx.batchId = d.batchId ?? null;
      this.pending.push(tx);
      count++;
    }
    if (count > 0) {
      this.scheduleFlush();
    }
    return count;
  }

  destroy() {
    if (this.flushTimer != null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  // ── Introspection ─────────────────────────────────────────────────────────

  get pendingCount() {
    return this.pending.length;
  }
  get executingCount() {
    return this.executing.length;
  }
  get awaitingSyncCount() {
    return this.awaitingSync.length;
  }
  get undoDepth() {
    return this.undoStack.length;
  }
  get redoDepth() {
    return this.redoStack.length;
  }
}
