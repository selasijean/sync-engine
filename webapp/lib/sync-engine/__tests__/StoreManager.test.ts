import { describe, it, expect, beforeEach, afterEach, vi, type MockedFunction } from "vitest";
import { StoreManager, RestrictDeleteError } from "@sync-engine/StoreManager";
import { BaseModel } from "@sync-engine/BaseModel";
import { TestTask, TestProject, TestUser, TestComment, TestActivity } from "./fixtures";

// Helpers — put a fully-observable model into the manager's pool.
function addToPool(manager: StoreManager, modelName: string, model: BaseModel) {
  model.makeModelObservable();
  manager.objectPool.put(modelName, model);
}

let manager: StoreManager;

beforeEach(async () => {
  manager = new StoreManager({
    workspaceId: crypto.randomUUID(),
    bootstrapFetcher: vi.fn(),
  });
  // Connect the database so the TransactionQueue can cache transactions.
  await manager.database.connect();
});

afterEach(async () => {
  await manager.teardown();
});

describe("StoreManager", () => {
  // ── commitUpdate ───────────────────────────────────────────────────────────

  describe("commitUpdate()", () => {
    it("enqueues an update and increments pendingCount", () => {
      manager.commitUpdate("t1", "TestTask", {
        title: { oldValue: "Old", newValue: "New" },
      });
      expect(manager.transactionQueue.pendingCount).toBe(1);
    });
  });

  // ── deleteModel — restrict ─────────────────────────────────────────────────

  describe("deleteModel() — onDelete: restrict", () => {
    it("throws RestrictDeleteError when a Comment references the Task", () => {
      const task = new TestTask();
      task.hydrate({ id: "task-1", title: "Do it" });
      addToPool(manager, "TestTask", task);

      const comment = new TestComment();
      comment.hydrate({ id: "c-1", taskId: "task-1", text: "hello" });
      addToPool(manager, "TestComment", comment);

      expect(() => manager.deleteModel(task)).toThrow(RestrictDeleteError);
    });

    it("RestrictDeleteError carries model and property names", () => {
      const task = new TestTask();
      task.hydrate({ id: "task-1" });
      addToPool(manager, "TestTask", task);

      const comment = new TestComment();
      comment.hydrate({ id: "c-1", taskId: "task-1" });
      addToPool(manager, "TestComment", comment);

      try {
        manager.deleteModel(task);
        throw new Error("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(RestrictDeleteError);
        const e = err as RestrictDeleteError;
        expect(e.deletedModelName).toBe("TestTask");
        expect(e.deletedModelId).toBe("task-1");
        expect(e.restrictedByModel).toBe("TestComment");
        expect(e.restrictedByProperty).toBe("taskId");
      }
    });

    it("does NOT throw when there are no restricting references", () => {
      const task = new TestTask();
      task.hydrate({ id: "task-1" });
      addToPool(manager, "TestTask", task);
      // No comments in pool → allowed
      expect(() => manager.deleteModel(task)).not.toThrow();
    });
  });

  // ── deleteModel — cascade ──────────────────────────────────────────────────

  describe("deleteModel() — onDelete: cascade", () => {
    it("removes dependent tasks from the pool when a project is deleted", () => {
      const project = new TestProject();
      project.hydrate({ id: "proj-1", title: "My Project" });
      addToPool(manager, "TestProject", project);

      const task1 = new TestTask();
      task1.hydrate({ id: "t1", projectId: "proj-1" });
      addToPool(manager, "TestTask", task1);

      const task2 = new TestTask();
      task2.hydrate({ id: "t2", projectId: "proj-1" });
      addToPool(manager, "TestTask", task2);

      manager.deleteModel(project);

      expect(manager.objectPool.getById("TestTask", "t1")).toBeUndefined();
      expect(manager.objectPool.getById("TestTask", "t2")).toBeUndefined();
      expect(manager.objectPool.getById("TestProject", "proj-1")).toBeUndefined();
    });

    it("does not remove unrelated tasks", () => {
      const project = new TestProject();
      project.hydrate({ id: "proj-1" });
      addToPool(manager, "TestProject", project);

      const taskInProject = new TestTask();
      taskInProject.hydrate({ id: "t-in", projectId: "proj-1" });
      addToPool(manager, "TestTask", taskInProject);

      const taskOther = new TestTask();
      taskOther.hydrate({ id: "t-out", projectId: "proj-other" });
      addToPool(manager, "TestTask", taskOther);

      manager.deleteModel(project);

      expect(manager.objectPool.getById("TestTask", "t-in")).toBeUndefined();
      expect(manager.objectPool.getById("TestTask", "t-out")).toBeDefined();
    });

    it("enqueues delete transactions for cascaded dependents", () => {
      const project = new TestProject();
      project.hydrate({ id: "proj-1" });
      addToPool(manager, "TestProject", project);

      const task = new TestTask();
      task.hydrate({ id: "t1", projectId: "proj-1" });
      addToPool(manager, "TestTask", task);

      manager.deleteModel(project);

      // project delete + task delete = 2 transactions, grouped in one batch
      expect(manager.transactionQueue.pendingCount).toBe(2);
    });

    it("groups all cascade operations in a single undo batch", () => {
      const project = new TestProject();
      project.hydrate({ id: "proj-1" });
      addToPool(manager, "TestProject", project);

      for (let i = 0; i < 3; i++) {
        const t = new TestTask();
        t.hydrate({ id: `t${i}`, projectId: "proj-1" });
        addToPool(manager, "TestTask", t);
      }

      manager.deleteModel(project);

      // All cascade + root delete grouped as 1 batch entry
      expect(manager.transactionQueue.undoDepth).toBe(1);
    });
  });

  // ── deleteModel — nullify ──────────────────────────────────────────────────

  describe("deleteModel() — onDelete: nullify", () => {
    it("sets the FK to null on tasks that reference the deleted user", () => {
      const user = new TestUser();
      user.hydrate({ id: "user-1", name: "Alice" });
      addToPool(manager, "TestUser", user);

      const task = new TestTask();
      task.hydrate({ id: "t1", assigneeId: "user-1" });
      addToPool(manager, "TestTask", task);

      manager.deleteModel(user);

      expect(task.assigneeId).toBeNull();
    });

    it("removes the deleted user from the pool", () => {
      const user = new TestUser();
      user.hydrate({ id: "user-1" });
      addToPool(manager, "TestUser", user);

      manager.deleteModel(user);

      expect(manager.objectPool.getById("TestUser", "user-1")).toBeUndefined();
    });

    it("only nullifies tasks that reference the specific user", () => {
      const userA = new TestUser();
      userA.hydrate({ id: "user-A" });
      addToPool(manager, "TestUser", userA);

      const userB = new TestUser();
      userB.hydrate({ id: "user-B" });
      addToPool(manager, "TestUser", userB);

      const taskA = new TestTask();
      taskA.hydrate({ id: "t-A", assigneeId: "user-A" });
      addToPool(manager, "TestTask", taskA);

      const taskB = new TestTask();
      taskB.hydrate({ id: "t-B", assigneeId: "user-B" });
      addToPool(manager, "TestTask", taskB);

      manager.deleteModel(userA);

      expect(taskA.assigneeId).toBeNull();
      expect(taskB.assigneeId).toBe("user-B"); // untouched
    });
  });

  // ── batch API ──────────────────────────────────────────────────────────────

  describe("batch()", () => {
    it("groups multiple commitUpdates into one undo entry", () => {
      manager.batch(() => {
        manager.commitUpdate("t1", "TestTask", { title: { oldValue: "A", newValue: "B" } });
        manager.commitUpdate("t2", "TestTask", { title: { oldValue: "C", newValue: "D" } });
      });
      expect(manager.transactionQueue.undoDepth).toBe(1);
      expect(manager.transactionQueue.pendingCount).toBe(2);
    });
  });

  // ── loadCollection — onDemandFetcher ──────────────────────────────────────

  describe("loadCollection() with onDemandFetcher", () => {
    type OnDemandFetcher = (modelName: string, indexKey: string, value: string) => Promise<Record<string, unknown>[]>;
    let onDemandFetcher: MockedFunction<OnDemandFetcher>;
    let managerWithFetcher: StoreManager;

    beforeEach(async () => {
      onDemandFetcher = vi.fn().mockResolvedValue([]);
      managerWithFetcher = new StoreManager({
        workspaceId: crypto.randomUUID(),
        bootstrapFetcher: vi.fn(),
        onDemandFetcher,
      });
      await managerWithFetcher.database.connect();
    });

    afterEach(async () => {
      await managerWithFetcher.teardown();
    });

    it("calls onDemandFetcher on first access and hydrates results into pool", async () => {
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "first" },
        { id: "a2", taskId: "t1", text: "second" },
      ]);

      const results = await managerWithFetcher.loadCollection("TestActivity", "taskId", "t1");

      expect(onDemandFetcher).toHaveBeenCalledWith("TestActivity", "taskId", "t1");
      expect(results).toHaveLength(2);
      expect(managerWithFetcher.objectPool.getById("TestActivity", "a1")).toBeDefined();
      expect(managerWithFetcher.objectPool.getById("TestActivity", "a2")).toBeDefined();
    });

    it("does not call onDemandFetcher again on repeat access to the same collection", async () => {
      onDemandFetcher.mockResolvedValue([{ id: "a1", taskId: "t1", text: "x" }]);

      await managerWithFetcher.loadCollection("TestActivity", "taskId", "t1");
      await managerWithFetcher.loadCollection("TestActivity", "taskId", "t1");

      expect(onDemandFetcher).toHaveBeenCalledTimes(1);
    });

    it("calls onDemandFetcher separately for different parent IDs", async () => {
      await managerWithFetcher.loadCollection("TestActivity", "taskId", "t1");
      await managerWithFetcher.loadCollection("TestActivity", "taskId", "t2");

      expect(onDemandFetcher).toHaveBeenCalledTimes(2);
      expect(onDemandFetcher).toHaveBeenCalledWith("TestActivity", "taskId", "t1");
      expect(onDemandFetcher).toHaveBeenCalledWith("TestActivity", "taskId", "t2");
    });

    it("skips onDemandFetcher for Instant models", async () => {
      await managerWithFetcher.loadCollection("TestTask", "projectId", "proj-1");

      expect(onDemandFetcher).not.toHaveBeenCalled();
    });

    it("persists server records to IDB so they survive pool eviction", async () => {
      onDemandFetcher.mockResolvedValueOnce([{ id: "a1", taskId: "t1", text: "persisted" }]);

      await managerWithFetcher.loadCollection("TestActivity", "taskId", "t1");

      const idbRecord = await managerWithFetcher.database.readModel("TestActivity", "a1");
      expect(idbRecord).not.toBeNull();
      expect(idbRecord!.text).toBe("persisted");
    });

    it("includes records already in the pool (e.g. from prior SSE inserts)", async () => {
      // Simulate a record that arrived via SSE before the collection was loaded
      const existing = new TestActivity();
      existing.hydrate({ id: "a-sse", taskId: "t1", text: "from sse" });
      addToPool(managerWithFetcher, "TestActivity", existing);

      onDemandFetcher.mockResolvedValueOnce([{ id: "a-server", taskId: "t1", text: "from server" }]);

      const results = await managerWithFetcher.loadCollection("TestActivity", "taskId", "t1");

      const ids = results.map((r) => r.id).sort();
      expect(ids).toEqual(["a-server", "a-sse"]);
    });

    it("picks up records written to IDB by SSE before the first load", async () => {
      // SSE wrote a record to IDB but didn't hydrate it (collection wasn't loaded yet)
      await managerWithFetcher.database.writeModels("TestActivity", [
        { id: "a-idb", taskId: "t1", text: "idb only" },
      ]);

      // onDemandFetcher returns nothing new — server has nothing beyond what SSE wrote
      onDemandFetcher.mockResolvedValueOnce([]);

      const results = await managerWithFetcher.loadCollection("TestActivity", "taskId", "t1");

      expect(results.map((r) => r.id)).toContain("a-idb");
      expect(managerWithFetcher.objectPool.getById("TestActivity", "a-idb")).toBeDefined();
    });
  });

  // ── undo / redo delegation ─────────────────────────────────────────────────

  describe("undo() / redo() delegation", () => {
    it("undo reverts a pooled model update", async () => {
      const task = new TestTask();
      task.hydrate({ id: "t1", title: "Original" });
      addToPool(manager, "TestTask", task);

      task.title = "Updated";
      manager.commitUpdate("t1", "TestTask", {
        title: { oldValue: "Original", newValue: "Updated" },
      });

      await manager.undo();

      expect(task.title).toBe("Original");
    });

    it("undo returns null on an empty stack", async () => {
      expect(await manager.undo()).toBeNull();
    });

    it("redo returns null when nothing to redo", async () => {
      expect(await manager.redo()).toBeNull();
    });
  });
});
