import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockedFunction,
} from "vitest";
import { StoreManager, RestrictDeleteError } from "@sync-engine/StoreManager";
import {
  TestTask,
  TestProject,
  TestUser,
  TestComment,
  TestActivity,
  addToPool,
} from "./fixtures";

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
      expect(
        manager.objectPool.getById("TestProject", "proj-1"),
      ).toBeUndefined();
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
        manager.commitUpdate("t1", "TestTask", {
          title: { oldValue: "A", newValue: "B" },
        });
        manager.commitUpdate("t2", "TestTask", {
          title: { oldValue: "C", newValue: "D" },
        });
      });
      expect(manager.transactionQueue.undoDepth).toBe(1);
      expect(manager.transactionQueue.pendingCount).toBe(2);
    });
  });

  // ── loadCollection — onDemandFetcher ──────────────────────────────────────

  describe("loadCollection() with onDemandFetcher", () => {
    type OnDemandFetcher = (
      modelName: string,
      indexKey: string,
      value: string,
    ) => Promise<Record<string, unknown>[]>;
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

      const results = await managerWithFetcher.loadCollection(
        "TestActivity",
        "taskId",
        "t1",
      );

      expect(onDemandFetcher).toHaveBeenCalledWith(
        "TestActivity",
        "taskId",
        "t1",
      );
      expect(results).toHaveLength(2);
      expect(
        managerWithFetcher.objectPool.getById("TestActivity", "a1"),
      ).toBeDefined();
      expect(
        managerWithFetcher.objectPool.getById("TestActivity", "a2"),
      ).toBeDefined();
    });

    it("does not call onDemandFetcher again on repeat access to the same collection", async () => {
      onDemandFetcher.mockResolvedValue([
        { id: "a1", taskId: "t1", text: "x" },
      ]);

      await managerWithFetcher.loadCollection("TestActivity", "taskId", "t1");
      await managerWithFetcher.loadCollection("TestActivity", "taskId", "t1");

      expect(onDemandFetcher).toHaveBeenCalledTimes(1);
    });

    it("calls onDemandFetcher separately for different parent IDs", async () => {
      await managerWithFetcher.loadCollection("TestActivity", "taskId", "t1");
      await managerWithFetcher.loadCollection("TestActivity", "taskId", "t2");

      expect(onDemandFetcher).toHaveBeenCalledTimes(2);
      expect(onDemandFetcher).toHaveBeenCalledWith(
        "TestActivity",
        "taskId",
        "t1",
      );
      expect(onDemandFetcher).toHaveBeenCalledWith(
        "TestActivity",
        "taskId",
        "t2",
      );
    });

    it("skips onDemandFetcher for Instant models", async () => {
      await managerWithFetcher.loadCollection(
        "TestTask",
        "projectId",
        "proj-1",
      );

      expect(onDemandFetcher).not.toHaveBeenCalled();
    });

    it("persists server records to IDB so they survive pool eviction", async () => {
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "persisted" },
      ]);

      await managerWithFetcher.loadCollection("TestActivity", "taskId", "t1");

      const idbRecord = await managerWithFetcher.database.readModel(
        "TestActivity",
        "a1",
      );
      expect(idbRecord).not.toBeNull();
      expect(idbRecord!.text).toBe("persisted");
    });

    it("includes records already in the pool (e.g. from prior SSE inserts)", async () => {
      // Simulate a record that arrived via SSE before the collection was loaded
      const existing = new TestActivity();
      existing.hydrate({ id: "a-sse", taskId: "t1", text: "from sse" });
      addToPool(managerWithFetcher, "TestActivity", existing);

      onDemandFetcher.mockResolvedValueOnce([
        { id: "a-server", taskId: "t1", text: "from server" },
      ]);

      const results = await managerWithFetcher.loadCollection(
        "TestActivity",
        "taskId",
        "t1",
      );

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

      const results = await managerWithFetcher.loadCollection(
        "TestActivity",
        "taskId",
        "t1",
      );

      expect(results.map((r) => r.id)).toContain("a-idb");
      expect(
        managerWithFetcher.objectPool.getById("TestActivity", "a-idb"),
      ).toBeDefined();
    });

    it("merges IDB partial records with additional server records", async () => {
      // IDB already has one record (e.g. from a prior SSE insert)
      await managerWithFetcher.database.writeModels("TestActivity", [
        { id: "a-idb", taskId: "t1", text: "partial" },
      ]);

      // Server knows about two more that IDB doesn't have yet
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a-server-1", taskId: "t1", text: "server 1" },
        { id: "a-server-2", taskId: "t1", text: "server 2" },
      ]);

      const results = await managerWithFetcher.loadCollection(
        "TestActivity",
        "taskId",
        "t1",
      );

      const ids = results.map((r) => r.id).sort();
      expect(ids).toEqual(["a-idb", "a-server-1", "a-server-2"]);
    });
  });

  // ── loadOne — onDemandFetcher ─────────────────────────────────────────────

  describe("loadOne() with onDemandFetcher", () => {
    type OnDemandFetcher = (
      modelName: string,
      indexKey: string,
      value: string,
    ) => Promise<Record<string, unknown>[]>;
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

    it("returns model from pool without calling fetcher", async () => {
      const activity = new TestActivity();
      activity.hydrate({ id: "a1", taskId: "t1", text: "in pool" });
      addToPool(managerWithFetcher, "TestActivity", activity);

      const result = await managerWithFetcher.loadOne("TestActivity", "a1");

      expect(result).toBe(activity);
      expect(onDemandFetcher).not.toHaveBeenCalled();
    });

    it("calls onDemandFetcher with ('id', id) when not in pool or IDB", async () => {
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "from server" },
      ]);

      await managerWithFetcher.loadOne("TestActivity", "a1");

      expect(onDemandFetcher).toHaveBeenCalledWith("TestActivity", "id", "a1");
    });

    it("hydrates the fetched record into the pool", async () => {
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "fetched" },
      ]);

      const result = await managerWithFetcher.loadOne("TestActivity", "a1");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("a1");
      expect(
        managerWithFetcher.objectPool.getById("TestActivity", "a1"),
      ).toBeDefined();
    });

    it("persists server record to IDB", async () => {
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "persisted" },
      ]);

      await managerWithFetcher.loadOne("TestActivity", "a1");

      const idbRecord = await managerWithFetcher.database.readModel(
        "TestActivity",
        "a1",
      );
      expect(idbRecord).not.toBeNull();
      expect(idbRecord!.text).toBe("persisted");
    });

    it("does not call fetcher again on repeat access to the same ID", async () => {
      onDemandFetcher.mockResolvedValue([
        { id: "a1", taskId: "t1", text: "x" },
      ]);

      await managerWithFetcher.loadOne("TestActivity", "a1");
      await managerWithFetcher.loadOne("TestActivity", "a1");

      expect(onDemandFetcher).toHaveBeenCalledTimes(1);
    });

    it("calls fetcher separately for different IDs", async () => {
      await managerWithFetcher.loadOne("TestActivity", "a1");
      await managerWithFetcher.loadOne("TestActivity", "a2");

      expect(onDemandFetcher).toHaveBeenCalledTimes(2);
      expect(onDemandFetcher).toHaveBeenCalledWith("TestActivity", "id", "a1");
      expect(onDemandFetcher).toHaveBeenCalledWith("TestActivity", "id", "a2");
    });

    it("returns null when fetcher returns empty and record is not in IDB", async () => {
      onDemandFetcher.mockResolvedValueOnce([]);

      const result = await managerWithFetcher.loadOne(
        "TestActivity",
        "missing",
      );

      expect(result).toBeNull();
    });

    it("returns record from IDB without calling fetcher if already fetched once", async () => {
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "initial" },
      ]);
      await managerWithFetcher.loadOne("TestActivity", "a1");

      // Evict from pool to simulate memory pressure
      managerWithFetcher.objectPool.remove("TestActivity", "a1");

      const result = await managerWithFetcher.loadOne("TestActivity", "a1");

      expect(result).not.toBeNull();
      expect(onDemandFetcher).toHaveBeenCalledTimes(1); // not called again
    });

    it("skips fetcher when record already exists in IDB from bootstrap or SSE", async () => {
      // Simulate a record written to IDB before loadOne is ever called (e.g. bootstrap or SSE)
      await managerWithFetcher.database.writeModels("TestActivity", [
        { id: "a1", taskId: "t1", text: "pre-seeded" },
      ]);

      const result = await managerWithFetcher.loadOne("TestActivity", "a1");

      expect(result).not.toBeNull();
      expect(onDemandFetcher).not.toHaveBeenCalled();
    });
  });

  // ── loadByIds — onDemandBatchFetcher ─────────────────────────────────────

  describe("loadByIds() with onDemandBatchFetcher", () => {
    type OnDemandBatchFetcher = (
      modelName: string,
      ids: string[],
    ) => Promise<Record<string, unknown>[]>;
    let onDemandBatchFetcher: MockedFunction<OnDemandBatchFetcher>;
    let managerWithFetcher: StoreManager;

    beforeEach(async () => {
      onDemandBatchFetcher = vi.fn().mockResolvedValue([]);
      managerWithFetcher = new StoreManager({
        workspaceId: crypto.randomUUID(),
        bootstrapFetcher: vi.fn(),
        onDemandBatchFetcher,
      });
      await managerWithFetcher.database.connect();
    });

    afterEach(async () => {
      await managerWithFetcher.teardown();
    });

    it("returns empty array for empty input", async () => {
      const results = await managerWithFetcher.loadByIds("TestActivity", []);
      expect(results).toHaveLength(0);
      expect(onDemandBatchFetcher).not.toHaveBeenCalled();
    });

    it("returns models from pool without calling fetcher", async () => {
      const a1 = new TestActivity();
      a1.hydrate({ id: "a1", taskId: "t1", text: "pooled" });
      addToPool(managerWithFetcher, "TestActivity", a1);

      const results = await managerWithFetcher.loadByIds("TestActivity", [
        "a1",
      ]);

      expect(results).toHaveLength(1);
      expect(results[0]).toBe(a1);
      expect(onDemandBatchFetcher).not.toHaveBeenCalled();
    });

    it("returns models from IDB without calling fetcher", async () => {
      await managerWithFetcher.database.writeModels("TestActivity", [
        { id: "a1", taskId: "t1", text: "idb-only" },
      ]);

      const results = await managerWithFetcher.loadByIds("TestActivity", [
        "a1",
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("a1");
      expect(onDemandBatchFetcher).not.toHaveBeenCalled();
    });

    it("makes a single batch server call for all missing IDs", async () => {
      onDemandBatchFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "one" },
        { id: "a2", taskId: "t1", text: "two" },
      ]);

      const results = await managerWithFetcher.loadByIds("TestActivity", [
        "a1",
        "a2",
      ]);

      expect(onDemandBatchFetcher).toHaveBeenCalledTimes(1);
      expect(onDemandBatchFetcher).toHaveBeenCalledWith("TestActivity", [
        "a1",
        "a2",
      ]);
      expect(results).toHaveLength(2);
    });

    it("only fetches IDs not already in pool or IDB", async () => {
      const a1 = new TestActivity();
      a1.hydrate({ id: "a1", taskId: "t1", text: "pooled" });
      addToPool(managerWithFetcher, "TestActivity", a1);

      await managerWithFetcher.database.writeModels("TestActivity", [
        { id: "a2", taskId: "t1", text: "idb" },
      ]);

      onDemandBatchFetcher.mockResolvedValueOnce([
        { id: "a3", taskId: "t1", text: "server" },
      ]);

      const results = await managerWithFetcher.loadByIds("TestActivity", [
        "a1",
        "a2",
        "a3",
      ]);

      expect(onDemandBatchFetcher).toHaveBeenCalledWith("TestActivity", ["a3"]);
      expect(results).toHaveLength(3);
    });

    it("hydrates server records into the pool", async () => {
      onDemandBatchFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "fetched" },
      ]);

      await managerWithFetcher.loadByIds("TestActivity", ["a1"]);

      expect(
        managerWithFetcher.objectPool.getById("TestActivity", "a1"),
      ).toBeDefined();
    });

    it("persists server records to IDB", async () => {
      onDemandBatchFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "persisted" },
      ]);

      await managerWithFetcher.loadByIds("TestActivity", ["a1"]);

      const idbRecord = await managerWithFetcher.database.readModel(
        "TestActivity",
        "a1",
      );
      expect(idbRecord).not.toBeNull();
      expect(idbRecord!.text).toBe("persisted");
    });

    it("does not call fetcher again for the same IDs on repeat calls", async () => {
      onDemandBatchFetcher.mockResolvedValue([
        { id: "a1", taskId: "t1", text: "x" },
      ]);

      await managerWithFetcher.loadByIds("TestActivity", ["a1"]);
      await managerWithFetcher.loadByIds("TestActivity", ["a1"]);

      expect(onDemandBatchFetcher).toHaveBeenCalledTimes(1);
    });

    it("omits IDs the server does not return", async () => {
      onDemandBatchFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "found" },
      ]);

      const results = await managerWithFetcher.loadByIds("TestActivity", [
        "a1",
        "a2",
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("a1");
    });
  });

  // ── loadByIds — fallback to onDemandFetcher ───────────────────────────────

  describe("loadByIds() fallback to onDemandFetcher", () => {
    type OnDemandFetcher = (
      modelName: string,
      indexKey: string,
      value: string,
    ) => Promise<Record<string, unknown>[]>;
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

    it("falls back to individual loadOne calls when no batch fetcher is configured", async () => {
      onDemandFetcher
        .mockResolvedValueOnce([{ id: "a1", taskId: "t1", text: "one" }])
        .mockResolvedValueOnce([{ id: "a2", taskId: "t1", text: "two" }]);

      const results = await managerWithFetcher.loadByIds("TestActivity", [
        "a1",
        "a2",
      ]);

      expect(onDemandFetcher).toHaveBeenCalledTimes(2);
      expect(onDemandFetcher).toHaveBeenCalledWith("TestActivity", "id", "a1");
      expect(onDemandFetcher).toHaveBeenCalledWith("TestActivity", "id", "a2");
      expect(results).toHaveLength(2);
    });
  });

  // ── loadByIds — no fetcher ────────────────────────────────────────────────

  describe("loadByIds() without fetcher", () => {
    it("returns models present in pool", async () => {
      const a1 = new TestActivity();
      a1.hydrate({ id: "a1", taskId: "t1", text: "pooled" });
      addToPool(manager, "TestActivity", a1);

      const results = await manager.loadByIds("TestActivity", ["a1"]);

      expect(results).toHaveLength(1);
      expect(results[0]).toBe(a1);
    });

    it("returns models present in IDB", async () => {
      await manager.database.writeModels("TestActivity", [
        { id: "a1", taskId: "t1", text: "idb" },
      ]);

      const results = await manager.loadByIds("TestActivity", ["a1"]);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("a1");
    });

    it("omits IDs not found anywhere", async () => {
      const results = await manager.loadByIds("TestActivity", ["ghost"]);
      expect(results).toHaveLength(0);
    });

    it("preserves request order regardless of storage order", async () => {
      for (const id of ["a1", "a2", "a3"]) {
        await manager.database.writeModels("TestActivity", [
          { id, taskId: "t1", text: id },
        ]);
      }

      // Request in non-sequential order to prove results match request, not storage
      const results = await manager.loadByIds("TestActivity", [
        "a3",
        "a1",
        "a2",
      ]);

      expect(results.map((r) => r.id)).toEqual(["a3", "a1", "a2"]);
    });

    it("returns empty array for an unregistered model name", async () => {
      const results = await manager.loadByIds("UnknownModel", ["x1"]);
      expect(results).toHaveLength(0);
    });

    it("handles duplicate IDs by returning the model once per occurrence", async () => {
      await manager.database.writeModels("TestActivity", [
        { id: "a1", taskId: "t1", text: "dedup" },
      ]);

      const results = await manager.loadByIds("TestActivity", ["a1", "a1"]);

      expect(results).toHaveLength(2);
      expect(results[0]).toBe(results[1]);
    });
  });

  // ── loadOne — no fetcher ───────────────────────────────────────────────────

  describe("loadOne() without onDemandFetcher", () => {
    it("returns model from pool", async () => {
      const activity = new TestActivity();
      activity.hydrate({ id: "a1", taskId: "t1", text: "pooled" });
      addToPool(manager, "TestActivity", activity);

      const result = await manager.loadOne("TestActivity", "a1");

      expect(result).toBe(activity);
    });

    it("returns model from IDB if not in pool", async () => {
      await manager.database.writeModels("TestActivity", [
        { id: "a1", taskId: "t1", text: "idb" },
      ]);

      const result = await manager.loadOne("TestActivity", "a1");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("a1");
    });

    it("returns null when not in pool or IDB", async () => {
      const result = await manager.loadOne("TestActivity", "ghost");

      expect(result).toBeNull();
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
