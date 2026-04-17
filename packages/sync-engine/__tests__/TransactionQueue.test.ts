import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Database } from "@sync-engine/Database";
import { ObjectPool } from "@sync-engine/ObjectPool";
import { TransactionQueue } from "@sync-engine/TransactionQueue";
import { TransactionState } from "@sync-engine/types";
import { BaseModel } from "@sync-engine/BaseModel";
import { TestTask } from "./fixtures";

// flush() is private and normally fires after a 50ms debounce timer. Tests need
// to trigger it immediately and await its completion. We cast through unknown to
// access it without an `any` cast (a direct intersection fails because TypeScript
// treats private-in-one-constituent intersections as `never`).
const flush = (queue: TransactionQueue) =>
  (queue as unknown as { flush(): Promise<void> }).flush();

let db: Database;
let pool: ObjectPool;
let queue: TransactionQueue;

beforeEach(async () => {
  BaseModel.storeManager = null;
  db = new Database(crypto.randomUUID());
  await db.connect();
  pool = new ObjectPool();
  queue = new TransactionQueue(db, pool);
});

afterEach(async () => {
  BaseModel.storeManager = null;
  await db.destroy();
});

describe("TransactionQueue", () => {
  // ── enqueue / pending ──────────────────────────────────────────────────────

  describe("enqueue", () => {
    it("enqueueUpdate increments pendingCount synchronously", async () => {
      await queue.enqueueUpdate("t1", "TestTask", {
        title: { oldValue: "A", newValue: "B" },
      });
      expect(queue.pendingCount).toBe(1);
    });

    it("enqueueCreate increments pendingCount synchronously", async () => {
      await queue.enqueueCreate("t2", "TestTask", { id: "t2", title: "New" });
      expect(queue.pendingCount).toBe(1);
    });

    it("caches the transaction in IDB for offline resilience", async () => {
      await queue.enqueueUpdate("t1", "TestTask", {
        title: { oldValue: "A", newValue: "B" },
      });
      const cached = await db.getCachedTransactions();
      expect(cached).toHaveLength(1);
      expect((cached[0] as { action: string }).action).toBe("U");
    });

    it("standalone enqueue pushes a single entry onto the undo stack", async () => {
      await queue.enqueueUpdate("t1", "TestTask", {
        title: { oldValue: "A", newValue: "B" },
      });
      expect(queue.undoDepth).toBe(1);
    });

    it("clears the redo stack when a new operation is enqueued", async () => {
      const task = new TestTask();
      task.hydrate({ id: "t1", title: "Original" });
      task.makeModelObservable();
      pool.put("TestTask", task);

      await queue.enqueueUpdate("t1", "TestTask", {
        title: { oldValue: "Original", newValue: "Updated" },
      });
      task.title = "Updated";
      await queue.undo(); // moves entry to redoStack
      expect(queue.redoDepth).toBe(1);

      // A new enqueue should clear redo
      await queue.enqueueUpdate("t1", "TestTask", {
        title: { oldValue: "Updated", newValue: "Final" },
      });
      expect(queue.redoDepth).toBe(0);
    });

    it("notifies subscribers when undo/redo availability changes", async () => {
      const listener = vi.fn();
      queue.subscribe(listener);

      await queue.enqueueUpdate("t1", "TestTask", {
        title: { oldValue: "A", newValue: "B" },
      });

      expect(listener).toHaveBeenCalledOnce();
    });

    it("stops notifying after unsubscribe", async () => {
      const listener = vi.fn();
      const unsubscribe = queue.subscribe(listener);
      unsubscribe();

      await queue.enqueueUpdate("t1", "TestTask", {
        title: { oldValue: "A", newValue: "B" },
      });

      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ── flush / sender ─────────────────────────────────────────────────────────

  describe("flush", () => {
    it("sends pending transactions via sender", async () => {
      const sender = vi
        .fn()
        .mockResolvedValue({ success: true, lastSyncId: 1 });
      queue.setSender(sender);

      await queue.enqueueUpdate("t1", "TestTask", {
        title: { oldValue: "A", newValue: "B" },
      });
      await flush(queue);

      expect(sender).toHaveBeenCalledOnce();
      expect(queue.pendingCount).toBe(0);
    });

    it("moves transactions to awaitingSync on success", async () => {
      const sender = vi
        .fn()
        .mockResolvedValue({ success: true, lastSyncId: 5 });
      queue.setSender(sender);

      await queue.enqueueUpdate("t1", "TestTask", {
        title: { oldValue: "A", newValue: "B" },
      });
      await flush(queue);

      expect(queue.awaitingSyncCount).toBe(1);
      expect(queue.executingCount).toBe(0);
    });

    it("clears IDB cache on successful flush", async () => {
      const sender = vi
        .fn()
        .mockResolvedValue({ success: true, lastSyncId: 1 });
      queue.setSender(sender);

      await queue.enqueueUpdate("t1", "TestTask", {
        title: { oldValue: "A", newValue: "B" },
      });
      await flush(queue);

      const cached = await db.getCachedTransactions();
      expect(cached).toHaveLength(0);
    });

    it("reverts the model and marks Failed when server rejects", async () => {
      const task = new TestTask();
      task.hydrate({ id: "t1", title: "New" });
      task.makeModelObservable();
      pool.put("TestTask", task);

      const sender = vi
        .fn()
        .mockResolvedValue({ success: false, lastSyncId: 0 });
      queue.setSender(sender);

      await queue.enqueueUpdate("t1", "TestTask", {
        title: { oldValue: "Old", newValue: "New" },
      });
      await flush(queue);

      // revertOne sets title back to oldValue
      expect(task.title).toBe("Old");
      expect(queue.pendingCount).toBe(0);
    });

    it("puts transactions back in pending on network error", async () => {
      const sender = vi.fn().mockRejectedValue(new Error("Network failure"));
      queue.setSender(sender);

      await queue.enqueueUpdate("t1", "TestTask", {
        title: { oldValue: "A", newValue: "B" },
      });
      await flush(queue);

      expect(queue.pendingCount).toBe(1);
      expect(queue.executingCount).toBe(0);
    });

    it("does not wipe IDB entries for transactions enqueued during an in-flight flush (success)", async () => {
      // Simulate a transaction arriving while a flush is already in-flight.
      // The flush should only clear IDB entries for the batch it sent,
      // not transactions that arrived after the batch was snapshotted.
      let resolveSender!: (v: unknown) => void;
      const sender = vi.fn().mockReturnValue(
        new Promise((res) => {
          resolveSender = res;
        }),
      );
      queue.setSender(sender);

      await queue.enqueueUpdate("t1", "TestTask", {
        title: { oldValue: "A", newValue: "B" },
      });
      const flushPromise = flush(queue); // starts but does not await — sender is paused

      // Tx C arrives while the flush is in-flight
      await queue.enqueueUpdate("t2", "TestTask", {
        title: { oldValue: "C", newValue: "D" },
      });

      resolveSender({ success: true, lastSyncId: 1 });
      await flushPromise;

      // t1's IDB entry should be gone; t2's should still be there
      const cached = await db.getCachedTransactions();
      expect(cached).toHaveLength(1);
      expect((cached[0] as { modelId: string }).modelId).toBe("t2");
    });

    it("does not wipe IDB entries for transactions enqueued during an in-flight flush (failure)", async () => {
      let resolveSender!: (v: unknown) => void;
      const sender = vi.fn().mockReturnValue(
        new Promise((res) => {
          resolveSender = res;
        }),
      );
      queue.setSender(sender);

      const task = new TestTask();
      task.hydrate({ id: "t1", title: "New" });
      task.makeModelObservable();
      pool.put("TestTask", task);

      await queue.enqueueUpdate("t1", "TestTask", {
        title: { oldValue: "Old", newValue: "New" },
      });
      const flushPromise = flush(queue);

      // Tx C arrives while the flush is in-flight
      await queue.enqueueUpdate("t2", "TestTask", {
        title: { oldValue: "C", newValue: "D" },
      });

      resolveSender({ success: false, lastSyncId: 0 });
      await flushPromise;

      // t1's IDB entry should be gone; t2's should still be there
      const cached = await db.getCachedTransactions();
      expect(cached).toHaveLength(1);
      expect((cached[0] as { modelId: string }).modelId).toBe("t2");
    });

    it("does not call sender when there are no pending transactions", async () => {
      const sender = vi
        .fn()
        .mockResolvedValue({ success: true, lastSyncId: 1 });
      queue.setSender(sender);

      await flush(queue);
      expect(sender).not.toHaveBeenCalled();
    });

    it("batches multiple pending transactions into one sender call", async () => {
      const sender = vi
        .fn()
        .mockResolvedValue({ success: true, lastSyncId: 1 });
      queue.setSender(sender);

      await queue.enqueueUpdate("t1", "TestTask", {
        title: { oldValue: "A", newValue: "B" },
      });
      await queue.enqueueUpdate("t2", "TestTask", {
        title: { oldValue: "C", newValue: "D" },
      });
      await flush(queue);

      expect(sender).toHaveBeenCalledOnce();
      const payload = sender.mock.calls[0][0];
      expect(payload).toHaveLength(2);
    });
  });

  // ── resolveBySync ──────────────────────────────────────────────────────────

  describe("resolveBySync()", () => {
    it("resolves transactions whose syncId requirement is met", async () => {
      const sender = vi
        .fn()
        .mockResolvedValue({ success: true, lastSyncId: 10 });
      queue.setSender(sender);

      await queue.enqueueUpdate("t1", "TestTask", {
        title: { oldValue: "A", newValue: "B" },
      });
      await flush(queue);
      expect(queue.awaitingSyncCount).toBe(1);

      const resolved = queue.resolveBySync(10);
      expect(resolved).toHaveLength(1);
      expect(resolved[0].state).toBe(TransactionState.Completed);
      expect(queue.awaitingSyncCount).toBe(0);
    });

    it("does NOT resolve transactions when syncId is too low", async () => {
      const sender = vi
        .fn()
        .mockResolvedValue({ success: true, lastSyncId: 10 });
      queue.setSender(sender);

      await queue.enqueueUpdate("t1", "TestTask", {
        title: { oldValue: "A", newValue: "B" },
      });
      await flush(queue);

      const resolved = queue.resolveBySync(5); // 5 < 10
      expect(resolved).toHaveLength(0);
      expect(queue.awaitingSyncCount).toBe(1);
    });

    it("resolves multiple transactions with a single syncId", async () => {
      const sender = vi
        .fn()
        .mockResolvedValue({ success: true, lastSyncId: 7 });
      queue.setSender(sender);

      await queue.enqueueUpdate("t1", "TestTask", {
        title: { oldValue: "A", newValue: "B" },
      });
      await queue.enqueueUpdate("t2", "TestTask", {
        title: { oldValue: "C", newValue: "D" },
      });
      await flush(queue);

      const resolved = queue.resolveBySync(7);
      expect(resolved).toHaveLength(2);
    });
  });

  // ── batch grouping ─────────────────────────────────────────────────────────

  describe("batch grouping", () => {
    it("multiple enqueues inside a batch share one undo entry", async () => {
      const batchId = queue.beginBatch();
      await queue.enqueueUpdate("t1", "TestTask", {
        title: { oldValue: "A", newValue: "B" },
      });
      await queue.enqueueUpdate("t2", "TestTask", {
        title: { oldValue: "C", newValue: "D" },
      });
      queue.endBatch(batchId);

      // One batch entry, not two
      expect(queue.undoDepth).toBe(1);
    });

    it("both transactions are pending after batch ends", async () => {
      const batchId = queue.beginBatch();
      await queue.enqueueUpdate("t1", "TestTask", {
        title: { oldValue: "A", newValue: "B" },
      });
      await queue.enqueueUpdate("t2", "TestTask", {
        title: { oldValue: "C", newValue: "D" },
      });
      queue.endBatch(batchId);
      expect(queue.pendingCount).toBe(2);
    });

    it("endBatch with wrong id is ignored", () => {
      queue.beginBatch();
      expect(() => queue.endBatch("wrong-id")).not.toThrow();
    });

    it("empty batch pushes nothing onto the undo stack", () => {
      const batchId = queue.beginBatch();
      queue.endBatch(batchId);
      expect(queue.undoDepth).toBe(0);
    });
  });

  // ── undo / redo ────────────────────────────────────────────────────────────

  describe("undo() / redo()", () => {
    it("undo reverts an UpdateTransaction in the pool", async () => {
      const task = new TestTask();
      task.hydrate({ id: "t1", title: "Original" });
      task.makeModelObservable();
      pool.put("TestTask", task);

      task.title = "Updated";
      await queue.enqueueUpdate("t1", "TestTask", {
        title: { oldValue: "Original", newValue: "Updated" },
      });

      await queue.undo();

      expect(task.title).toBe("Original");
    });

    it("undo returns null when the undo stack is empty", async () => {
      const result = await queue.undo();
      expect(result).toBeNull();
    });

    it("redo returns null when the redo stack is empty", async () => {
      const result = await queue.redo();
      expect(result).toBeNull();
    });

    it("undo moves entry to redoStack", async () => {
      const task = new TestTask();
      task.hydrate({ id: "t1", title: "A" });
      task.makeModelObservable();
      pool.put("TestTask", task);

      task.title = "B";
      await queue.enqueueUpdate("t1", "TestTask", {
        title: { oldValue: "A", newValue: "B" },
      });
      expect(queue.redoDepth).toBe(0);

      await queue.undo();
      expect(queue.redoDepth).toBe(1);
    });

    it("redo re-applies the change to the model", async () => {
      const task = new TestTask();
      task.hydrate({ id: "t1", title: "Original" });
      task.makeModelObservable();
      pool.put("TestTask", task);

      task.title = "Updated";
      await queue.enqueueUpdate("t1", "TestTask", {
        title: { oldValue: "Original", newValue: "Updated" },
      });

      await queue.undo();
      expect(task.title).toBe("Original");

      await queue.redo();
      expect(task.title).toBe("Updated");
    });

    it("redo re-deletes a model after undo of delete", async () => {
      const task = new TestTask();
      task.hydrate({ id: "t1", title: "Important" });
      task.makeModelObservable();
      pool.put("TestTask", task);

      await queue.enqueueDelete(task);
      await queue.undo(); // model is restored
      expect(pool.getById("TestTask", "t1")).toBeDefined();

      await queue.redo(); // model should be deleted again
      expect(pool.getById("TestTask", "t1")).toBeUndefined();
    });

    it("redo re-creates a model after undo of create", async () => {
      await queue.enqueueCreate("t1", "TestTask", { id: "t1", title: "New" });
      // pool has no model — this is a raw create with no pool involvement yet
      // undo should remove it (if it were in pool), redo should add it back
      // For this test we put the model in the pool manually first
      const task = new TestTask();
      task.hydrate({ id: "t1", title: "New" });
      task.makeModelObservable();
      pool.put("TestTask", task);

      await queue.undo(); // removes from pool (undo of create = delete)
      expect(pool.getById("TestTask", "t1")).toBeUndefined();

      await queue.redo(); // re-creates it
      expect(pool.getById("TestTask", "t1")).toBeDefined();
    });

    it("undo restores a deleted model to the pool", async () => {
      const task = new TestTask();
      task.hydrate({ id: "t1", title: "Important" });
      task.makeModelObservable();
      pool.put("TestTask", task);

      await queue.enqueueDelete(task);
      // Optimistic removal — task is gone
      expect(pool.getById("TestTask", "t1")).toBeUndefined();

      await queue.undo();
      // The model should be re-created in the pool
      expect(pool.getById("TestTask", "t1")).toBeDefined();
    });
  });

  // ── rebaseAll ──────────────────────────────────────────────────────────────

  describe("rebaseAll()", () => {
    it("re-applies the local value when the server sends a conflicting update", async () => {
      const task = new TestTask();
      task.hydrate({ id: "t1", title: "Base" });
      task.makeModelObservable();
      pool.put("TestTask", task);

      task.title = "Local";
      await queue.enqueueUpdate("t1", "TestTask", {
        title: { oldValue: "Base", newValue: "Local" },
      });

      // Simulate the server overwriting the field
      task.title = "Server";

      // Rebase: re-apply our local value on top of the server's
      queue.rebaseAll("t1", "TestTask", { title: "Server" });

      expect(task.title).toBe("Local");
    });

    it("does nothing for a non-conflicting server update", async () => {
      const task = new TestTask();
      task.hydrate({ id: "t1", title: "Local", done: false });
      task.makeModelObservable();
      pool.put("TestTask", task);

      task.title = "Local";
      await queue.enqueueUpdate("t1", "TestTask", {
        title: { oldValue: "Base", newValue: "Local" },
      });

      // Server updates a different field — no rebase needed
      queue.rebaseAll("t1", "TestTask", { done: true });

      expect(task.title).toBe("Local"); // unchanged
    });

    it("does nothing when the model is not in the pool", async () => {
      await queue.enqueueUpdate("ghost", "TestTask", {
        title: { oldValue: "A", newValue: "B" },
      });
      expect(() =>
        queue.rebaseAll("ghost", "TestTask", { title: "X" }),
      ).not.toThrow();
    });
  });
});
