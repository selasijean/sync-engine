import { describe, it, expect, vi, beforeEach } from "vitest";
import { ObjectPool } from "@sync-engine/ObjectPool";
import { TestTask, TestProject } from "./fixtures";

// ObjectPool is a plain in-memory structure — no browser APIs needed.

let pool: ObjectPool;

beforeEach(() => {
  pool = new ObjectPool();
});

describe("ObjectPool", () => {
  // ── core CRUD ───────────────────────────────────────────────────────────────

  describe("put / getById / getAll", () => {
    it("put stores an instance and getById retrieves it", () => {
      const task = new TestTask();
      task.id = "t-1";
      pool.put("TestTask", task);
      expect(pool.getById("TestTask", "t-1")).toBe(task);
    });

    it("getAll returns all instances for a model type", () => {
      const t1 = new TestTask();
      t1.id = "a";
      const t2 = new TestTask();
      t2.id = "b";
      pool.put("TestTask", t1);
      pool.put("TestTask", t2);
      expect(pool.getAll("TestTask")).toHaveLength(2);
    });

    it("getAll returns [] for an unknown model type", () => {
      expect(pool.getAll("Unknown")).toEqual([]);
    });

    it("put overwrites an existing instance with the same id", () => {
      const original = new TestTask();
      original.id = "x";
      const replacement = new TestTask();
      replacement.id = "x";
      pool.put("TestTask", original);
      pool.put("TestTask", replacement);
      expect(pool.getById("TestTask", "x")).toBe(replacement);
    });

    it("put sets instance.store to the pool", () => {
      const task = new TestTask();
      task.id = "s1";
      pool.put("TestTask", task);
      expect(task.store).toBe(pool);
    });
  });

  describe("remove", () => {
    it("removes the instance so getById returns undefined", () => {
      const task = new TestTask();
      task.id = "r1";
      pool.put("TestTask", task);
      pool.remove("TestTask", "r1");
      expect(pool.getById("TestTask", "r1")).toBeUndefined();
    });

    it("is safe to call for a non-existent id", () => {
      expect(() => pool.remove("TestTask", "ghost")).not.toThrow();
    });
  });

  describe("size and counts", () => {
    it("size reflects the total across all model types", () => {
      const t = new TestTask();
      t.id = "t";
      const p = new TestProject();
      p.id = "p";
      pool.put("TestTask", t);
      pool.put("TestProject", p);
      expect(pool.size).toBe(2);
    });

    it("counts returns per-type counts", () => {
      const t1 = new TestTask();
      t1.id = "1";
      const t2 = new TestTask();
      t2.id = "2";
      pool.put("TestTask", t1);
      pool.put("TestTask", t2);
      expect(pool.counts()["TestTask"]).toBe(2);
    });
  });

  // ── subscriptions ───────────────────────────────────────────────────────────

  describe("subscriptions", () => {
    it("subscriber is called when an instance is put", () => {
      const listener = vi.fn();
      pool.subscribe("TestTask", listener);
      pool.put("TestTask", new TestTask());
      expect(listener).toHaveBeenCalledOnce();
    });

    it("subscriber is called when an instance is removed", () => {
      const task = new TestTask();
      task.id = "sub-r";
      pool.put("TestTask", task);
      const listener = vi.fn();
      pool.subscribe("TestTask", listener);
      pool.remove("TestTask", "sub-r");
      expect(listener).toHaveBeenCalledOnce();
    });

    it("subscriber for type A is NOT called when type B changes", () => {
      const listener = vi.fn();
      pool.subscribe("TestProject", listener);
      pool.put("TestTask", new TestTask());
      expect(listener).not.toHaveBeenCalled();
    });

    it("unsubscribe stops future notifications", () => {
      const listener = vi.fn();
      const unsub = pool.subscribe("TestTask", listener);
      unsub();
      pool.put("TestTask", new TestTask());
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ── clear ───────────────────────────────────────────────────────────────────

  describe("clear", () => {
    it("removes all models", () => {
      const t = new TestTask();
      t.id = "c1";
      const p = new TestProject();
      p.id = "c2";
      pool.put("TestTask", t);
      pool.put("TestProject", p);
      pool.clear();
      expect(pool.size).toBe(0);
    });

    it("notifies subscribers for each cleared type", () => {
      const taskListener = vi.fn();
      const projectListener = vi.fn();
      pool.subscribe("TestTask", taskListener);
      pool.subscribe("TestProject", projectListener);

      pool.put("TestTask", new TestTask());
      pool.put("TestProject", new TestProject());
      taskListener.mockClear();
      projectListener.mockClear();

      pool.clear();
      expect(taskListener).toHaveBeenCalledOnce();
      expect(projectListener).toHaveBeenCalledOnce();
    });
  });
});
