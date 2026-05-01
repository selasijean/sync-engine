import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockedFunction,
} from "vitest";
import {
  StoreManager,
  RestrictDeleteError,
  type BootstrapResponse,
} from "@sync-engine/StoreManager";
import { BootstrapPhase } from "@sync-engine/types";
import {
  TestTask,
  TestProject,
  TestUser,
  TestComment,
  TestActivity,
  TestMetric,
  addToPool,
} from "./fixtures";
import { controllableSSEClient, makeFactory } from "./helpers/sseClient";

const emptyBootstrapResponse: BootstrapResponse = {
  lastSyncId: 0,
  subscribedSyncGroups: [],
  models: {},
};

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

  // ── Refresh APIs ───────────────────────────────────────────────────────────

  describe("refreshCollection()", () => {
    type OnDemandFetcher = (
      modelName: string,
      indexKey: string,
      value: string,
    ) => Promise<Record<string, unknown>[]>;
    let onDemandFetcher: MockedFunction<OnDemandFetcher>;
    let sm: StoreManager;

    beforeEach(async () => {
      onDemandFetcher = vi.fn().mockResolvedValue([]);
      sm = new StoreManager({
        workspaceId: crypto.randomUUID(),
        bootstrapFetcher: vi.fn(),
        onDemandFetcher,
      });
      await sm.database.connect();
    });

    afterEach(async () => {
      await sm.teardown();
    });

    it("updates existing models in-place and preserves object identity", async () => {
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "original" },
      ]);
      await sm.loadCollection("TestActivity", "taskId", "t1");
      expect(onDemandFetcher).toHaveBeenCalledTimes(1);

      const originalRef = sm.objectPool.getById("TestActivity", "a1");

      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "refreshed" },
        { id: "a2", taskId: "t1", text: "new" },
      ]);
      const results = await sm.refreshCollection(
        "TestActivity",
        "taskId",
        "t1",
      );

      expect(onDemandFetcher).toHaveBeenCalledTimes(2);
      expect(results).toHaveLength(2);
      expect(
        (sm.objectPool.getById("TestActivity", "a1") as TestActivity).text,
      ).toBe("refreshed");
      // Same object reference — not a new instance
      expect(sm.objectPool.getById("TestActivity", "a1")).toBe(originalRef);
      expect(sm.objectPool.getById("TestActivity", "a2")).toBeDefined();
    });

    it("removes models the server no longer returns", async () => {
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "x" },
        { id: "a2", taskId: "t1", text: "y" },
      ]);
      await sm.loadCollection("TestActivity", "taskId", "t1");
      expect(sm.objectPool.getAll("TestActivity")).toHaveLength(2);

      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "x" },
      ]);
      const results = await sm.refreshCollection(
        "TestActivity",
        "taskId",
        "t1",
      );

      expect(results).toHaveLength(1);
      expect(sm.objectPool.getById("TestActivity", "a2")).toBeUndefined();
    });

    it("works with ephemeral models (skips IDB)", async () => {
      onDemandFetcher.mockResolvedValueOnce([
        { id: "m1", value: 10, label: "cpu" },
      ]);
      await sm.loadCollection("TestMetric", "label", "cpu");
      expect(
        (sm.objectPool.getById("TestMetric", "m1") as TestMetric).value,
      ).toBe(10);

      onDemandFetcher.mockResolvedValueOnce([
        { id: "m1", value: 99, label: "cpu" },
      ]);
      const results = await sm.refreshCollection("TestMetric", "label", "cpu");

      expect(results).toHaveLength(1);
      expect(
        (sm.objectPool.getById("TestMetric", "m1") as TestMetric).value,
      ).toBe(99);
    });
  });

  describe("refreshModels()", () => {
    type OnDemandBatchFetcher = (
      modelName: string,
      ids: string[],
    ) => Promise<Record<string, unknown>[]>;
    let onDemandFetcher: MockedFunction<
      (m: string, k: string, v: string) => Promise<Record<string, unknown>[]>
    >;
    let onDemandBatchFetcher: MockedFunction<OnDemandBatchFetcher>;
    let sm: StoreManager;

    beforeEach(async () => {
      onDemandFetcher = vi.fn().mockResolvedValue([]);
      onDemandBatchFetcher = vi.fn().mockResolvedValue([]);
      sm = new StoreManager({
        workspaceId: crypto.randomUUID(),
        bootstrapFetcher: vi.fn(),
        onDemandFetcher,
        onDemandBatchFetcher,
      });
      await sm.database.connect();
    });

    afterEach(async () => {
      await sm.teardown();
    });

    it("updates existing models in-place and preserves object identity", async () => {
      onDemandBatchFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "original" },
      ]);
      await sm.loadByIds("TestActivity", ["a1"]);
      const originalRef = sm.objectPool.getById("TestActivity", "a1");
      expect((originalRef as TestActivity).text).toBe("original");

      onDemandBatchFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "refreshed" },
      ]);
      const results = await sm.refreshModels("TestActivity", ["a1"]);

      expect(results).toHaveLength(1);
      expect(
        (sm.objectPool.getById("TestActivity", "a1") as TestActivity).text,
      ).toBe("refreshed");
      // Same object reference
      expect(sm.objectPool.getById("TestActivity", "a1")).toBe(originalRef);
    });

    it("returns empty array for empty ids", async () => {
      const results = await sm.refreshModels("TestActivity", []);
      expect(results).toEqual([]);
    });

    it("works with ephemeral models (skips IDB)", async () => {
      onDemandBatchFetcher.mockResolvedValueOnce([
        { id: "m1", value: 10, label: "cpu" },
      ]);
      await sm.loadByIds("TestMetric", ["m1"]);
      expect(
        (sm.objectPool.getById("TestMetric", "m1") as TestMetric).value,
      ).toBe(10);

      onDemandBatchFetcher.mockResolvedValueOnce([
        { id: "m1", value: 99, label: "cpu" },
      ]);
      const results = await sm.refreshModels("TestMetric", ["m1"]);

      expect(results).toHaveLength(1);
      expect(
        (sm.objectPool.getById("TestMetric", "m1") as TestMetric).value,
      ).toBe(99);
    });
  });

  describe("refreshAllOfModel()", () => {
    type OnDemandFetcher = (
      modelName: string,
      indexKey: string,
      value: string,
    ) => Promise<Record<string, unknown>[]>;
    let onDemandFetcher: MockedFunction<OnDemandFetcher>;
    let sm: StoreManager;

    beforeEach(async () => {
      onDemandFetcher = vi.fn().mockResolvedValue([]);
      sm = new StoreManager({
        workspaceId: crypto.randomUUID(),
        bootstrapFetcher: vi.fn(),
        onDemandFetcher,
      });
      await sm.database.connect();
    });

    afterEach(async () => {
      await sm.teardown();
    });

    it("re-fetches all previously loaded collections for a model", async () => {
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "first" },
      ]);
      await sm.loadCollection("TestActivity", "taskId", "t1");

      onDemandFetcher.mockResolvedValueOnce([
        { id: "a2", taskId: "t2", text: "second" },
      ]);
      await sm.loadCollection("TestActivity", "taskId", "t2");

      expect(onDemandFetcher).toHaveBeenCalledTimes(2);

      // Refresh — should re-fetch both collections
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "refreshed-1" },
      ]);
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a2", taskId: "t2", text: "refreshed-2" },
      ]);
      await sm.refreshAllOfModel("TestActivity");

      expect(onDemandFetcher).toHaveBeenCalledTimes(4);
      expect(
        (sm.objectPool.getById("TestActivity", "a1") as TestActivity).text,
      ).toBe("refreshed-1");
      expect(
        (sm.objectPool.getById("TestActivity", "a2") as TestActivity).text,
      ).toBe("refreshed-2");
    });

    it("re-fetches individually loaded IDs not covered by collections", async () => {
      const onDemandBatchFetcher = vi.fn().mockResolvedValue([]);

      // Create a StoreManager with both fetchers
      const smWithBatch = new StoreManager({
        workspaceId: crypto.randomUUID(),
        bootstrapFetcher: vi.fn(),
        onDemandFetcher,
        onDemandBatchFetcher,
      });
      await smWithBatch.database.connect();

      // Load a collection
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "coll" },
      ]);
      await smWithBatch.loadCollection("TestActivity", "taskId", "t1");

      // Load an individual model by ID (not part of any collection)
      onDemandBatchFetcher.mockResolvedValueOnce([
        { id: "a9", taskId: "t9", text: "individual" },
      ]);
      await smWithBatch.loadByIds("TestActivity", ["a9"]);
      expect(
        smWithBatch.objectPool.getById("TestActivity", "a9"),
      ).toBeDefined();

      // Refresh all — should re-fetch both the collection and the individual ID
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "coll-refreshed" },
      ]);
      onDemandBatchFetcher.mockResolvedValueOnce([
        { id: "a9", taskId: "t9", text: "individual-refreshed" },
      ]);
      await smWithBatch.refreshAllOfModel("TestActivity");

      expect(
        (smWithBatch.objectPool.getById("TestActivity", "a1") as TestActivity)
          .text,
      ).toBe("coll-refreshed");
      expect(
        (smWithBatch.objectPool.getById("TestActivity", "a9") as TestActivity)
          .text,
      ).toBe("individual-refreshed");

      await smWithBatch.teardown();
    });

    it("removes models the server no longer returns", async () => {
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "x" },
        { id: "a2", taskId: "t1", text: "y" },
      ]);
      await sm.loadCollection("TestActivity", "taskId", "t1");
      expect(sm.objectPool.getAll("TestActivity")).toHaveLength(2);

      // Server now returns only one record (a2 was deleted)
      onDemandFetcher.mockResolvedValueOnce([
        { id: "a1", taskId: "t1", text: "x" },
      ]);
      await sm.refreshAllOfModel("TestActivity");

      expect(sm.objectPool.getAll("TestActivity")).toHaveLength(1);
      expect(sm.objectPool.getById("TestActivity", "a2")).toBeUndefined();
    });
  });

  // ── fullBootstrap — onDemandFetcher narrows the fetch ─────────────────────
  //
  // When onDemandFetcher is configured the user has opted into progressive
  // loading: Partial / Lazy / ExplicitlyRequested models load on access, not
  // at bootstrap. Verify the engine narrows the bootstrap fetch accordingly
  // so the server can omit those payloads.

  describe("fullBootstrap() — onDemandFetcher narrowing", () => {
    it("excludes Partial/Lazy/ExplicitlyRequested from onlyModels when onDemandFetcher is set", async () => {
      const bootstrapFetcher = vi.fn().mockResolvedValue(emptyBootstrapResponse);
      const sm = new StoreManager({
        workspaceId: crypto.randomUUID(),
        bootstrapFetcher,
        onDemandFetcher: vi.fn().mockResolvedValue([]),
      });

      await sm.bootstrap();

      expect(bootstrapFetcher).toHaveBeenCalledTimes(1);
      const [, options] = bootstrapFetcher.mock.calls[0];
      expect(options.onlyModels).toBeDefined();
      // TestActivity is the only Partial fixture; everything else is Instant/Ephemeral.
      expect(options.onlyModels).not.toContain("TestActivity");
      expect(options.onlyModels).toContain("TestTask");

      await sm.teardown();
    });

    it("omits onlyModels entirely when onDemandFetcher is not set (single-phase)", async () => {
      const bootstrapFetcher = vi.fn().mockResolvedValue(emptyBootstrapResponse);
      const sm = new StoreManager({
        workspaceId: crypto.randomUUID(),
        bootstrapFetcher,
      });

      await sm.bootstrap();

      const [, options] = bootstrapFetcher.mock.calls[0];
      expect(options.onlyModels).toBeUndefined();

      await sm.teardown();
    });

    it("excludes both deferred AND on-demand strategies from phase 1 when both are set", async () => {
      const bootstrapFetcher = vi.fn().mockResolvedValue(emptyBootstrapResponse);
      const sm = new StoreManager({
        workspaceId: crypto.randomUUID(),
        bootstrapFetcher,
        onDemandFetcher: vi.fn().mockResolvedValue([]),
        // deferredModels is the user's explicit phase-2 list — its members
        // should still be excluded from phase 1 even if they're Instant.
        deferredModels: ["TestNote"],
      });

      await sm.bootstrap();

      const [, options] = bootstrapFetcher.mock.calls[0];
      expect(options.onlyModels).not.toContain("TestNote"); // deferred
      expect(options.onlyModels).not.toContain("TestActivity"); // Partial
      expect(options.onlyModels).toContain("TestTask"); // Instant, not deferred

      await sm.teardown();
    });
  });

  // ── teardown / bootstrap race ─────────────────────────────────────────────
  //
  // Guards against the StrictMode-style remount where bootstrap() is in flight
  // when teardown() fires. Without the stopped flag, bootstrap could keep
  // walking past the await boundaries and open a SyncConnection no one will
  // ever close.

  describe("teardown / bootstrap race", () => {
    it("teardown before SSE connect doesn't open an EventSource", async () => {
      const client = controllableSSEClient();
      const factory = vi.fn(makeFactory(client));
      let resolveFetcher!: (v: BootstrapResponse) => void;
      let phase: BootstrapPhase = BootstrapPhase.Idle;

      const sm = new StoreManager({
        workspaceId: crypto.randomUUID(),
        bootstrapFetcher: () =>
          new Promise<BootstrapResponse>((r) => {
            resolveFetcher = r;
          }),
        syncUrl: "http://localhost/sync",
        sseClientFactory: factory,
        onPhaseChange: (p) => {
          phase = p;
        },
      });

      const bootP = sm.bootstrap();
      bootP.catch(() => {});

      // Wait until bootstrap is suspended at the fetcher boundary —
      // i.e. past database.connect() and determineBootstrapType() but
      // before SyncConnection construction.
      await vi.waitFor(() => expect(phase).toBe(BootstrapPhase.Fetching));

      await sm.teardown();

      // Fetcher resolves AFTER teardown — bootstrap resumes and the stopped
      // check should short-circuit before reaching ConnectingSync.
      resolveFetcher(emptyBootstrapResponse);
      await new Promise((r) => setTimeout(r, 0));

      expect(factory).not.toHaveBeenCalled();
    });

    it("teardown after SSE connect closes the EventSource exactly once", async () => {
      const client = controllableSSEClient();
      const factory = vi.fn(makeFactory(client));

      const sm = new StoreManager({
        workspaceId: crypto.randomUUID(),
        bootstrapFetcher: vi.fn().mockResolvedValue(emptyBootstrapResponse),
        syncUrl: "http://localhost/sync",
        sseClientFactory: factory,
      });

      await sm.bootstrap();
      expect(factory).toHaveBeenCalledTimes(1);
      expect(client.close).not.toHaveBeenCalled();

      await sm.teardown();
      expect(client.close).toHaveBeenCalledTimes(1);
    });

    it("bootstrap → teardown → new bootstrap opens exactly one EventSource", async () => {
      // Simulates React 18 StrictMode: mount → cleanup → mount.
      const client = controllableSSEClient();
      const factory = vi.fn(makeFactory(client));
      const workspaceId = crypto.randomUUID();

      let resolveFirst!: (v: BootstrapResponse) => void;
      let phase1: BootstrapPhase = BootstrapPhase.Idle;
      const sm1 = new StoreManager({
        workspaceId,
        bootstrapFetcher: () =>
          new Promise<BootstrapResponse>((r) => {
            resolveFirst = r;
          }),
        syncUrl: "http://localhost/sync",
        sseClientFactory: factory,
        onPhaseChange: (p) => {
          phase1 = p;
        },
      });

      const bootP1 = sm1.bootstrap();
      bootP1.catch(() => {});
      await vi.waitFor(() => expect(phase1).toBe(BootstrapPhase.Fetching));
      await sm1.teardown();
      resolveFirst(emptyBootstrapResponse);
      await new Promise((r) => setTimeout(r, 0));

      const sm2 = new StoreManager({
        workspaceId,
        bootstrapFetcher: vi.fn().mockResolvedValue(emptyBootstrapResponse),
        syncUrl: "http://localhost/sync",
        sseClientFactory: factory,
      });
      await sm2.bootstrap();

      expect(factory).toHaveBeenCalledTimes(1);

      await sm2.teardown();
    });
  });
});
