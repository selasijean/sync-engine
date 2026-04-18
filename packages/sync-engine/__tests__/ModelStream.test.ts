import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ModelStream } from "@sync-engine/ModelStream";
import { ObjectPool } from "@sync-engine/ObjectPool";
import { MemoryAdapter } from "@sync-engine/MemoryAdapter";
import { BaseModel } from "@sync-engine/BaseModel";
import type { SSEClient, SSEClientFactory } from "@sync-engine/SyncConnection";
import { TestTask, TestMetric } from "./fixtures";

// ── helpers ──────────────────────────────────────────────────────────────────

/** An SSEClient whose onmessage/onerror can be triggered manually. */
function controllableSSEClient(): SSEClient & { triggerError: () => void } {
  const client: SSEClient & { triggerError: () => void } = {
    onmessage: null,
    onerror: null,
    close: vi.fn(),
    triggerError() {
      this.onerror?.(new Event("error"));
    },
  };
  return client;
}

function makeFactory(client: SSEClient): SSEClientFactory {
  return () => client;
}

function sendMessage(client: SSEClient, payload: unknown) {
  client.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
}

// ── setup ────────────────────────────────────────────────────────────────────

let adapter: MemoryAdapter;
let pool: ObjectPool;

beforeEach(async () => {
  BaseModel.storeManager = null;
  adapter = new MemoryAdapter();
  await adapter.connect();
  pool = new ObjectPool();
});

afterEach(() => {
  BaseModel.storeManager = null;
});

// ── tests ────────────────────────────────────────────────────────────────────

describe("ModelStream", () => {
  describe("connect / disconnect", () => {
    it("connects and sets isConnected", () => {
      const client = controllableSSEClient();
      const stream = new ModelStream(
        "http://calc/events",
        adapter,
        pool,
        undefined,
        makeFactory(client),
      );

      expect(stream.isConnected).toBe(false);
      stream.connect();
      expect(stream.isConnected).toBe(true);

      stream.disconnect();
      expect(stream.isConnected).toBe(false);
      expect(client.close).toHaveBeenCalled();
    });

    it("reconnect closes and reopens", () => {
      const clients: SSEClient[] = [];
      const factory: SSEClientFactory = () => {
        const c = controllableSSEClient();
        clients.push(c);
        return c;
      };
      const stream = new ModelStream("http://calc/events", adapter, pool, undefined, factory);

      stream.connect();
      expect(clients).toHaveLength(1);

      stream.reconnect();
      expect(clients[0].close).toHaveBeenCalled();
      expect(clients).toHaveLength(2);
      expect(stream.isConnected).toBe(true);

      stream.disconnect();
    });
  });

  describe("applyUpdate — upsert", () => {
    it("inserts a new model into pool and writes to storage", async () => {
      const client = controllableSSEClient();
      const stream = new ModelStream(
        "http://calc/events",
        adapter,
        pool,
        undefined,
        makeFactory(client),
      );
      stream.connect();

      sendMessage(client, {
        modelName: "TestTask",
        modelId: "t1",
        data: { title: "Calculated", done: false },
      });

      await vi.waitFor(async () => {
        const task = pool.getById("TestTask", "t1") as TestTask | undefined;
        expect(task).toBeDefined();
        expect(task!.title).toBe("Calculated");
      });

      const stored = await adapter.readModel("TestTask", "t1");
      expect(stored).not.toBeNull();
      expect(stored!.title).toBe("Calculated");

      stream.disconnect();
    });

    it("updates an existing model in the pool", async () => {
      const task = new TestTask();
      task.hydrate({ id: "t1", title: "Original", done: false });
      task.makeModelObservable();
      pool.put("TestTask", task);

      const client = controllableSSEClient();
      const stream = new ModelStream(
        "http://calc/events",
        adapter,
        pool,
        undefined,
        makeFactory(client),
      );
      stream.connect();

      sendMessage(client, {
        modelName: "TestTask",
        modelId: "t1",
        data: { title: "Updated" },
      });

      await vi.waitFor(() => {
        expect((pool.getById("TestTask", "t1") as TestTask).title).toBe(
          "Updated",
        );
      });

      stream.disconnect();
    });
  });

  describe("error handling", () => {
    it("ignores unknown model names", async () => {
      const client = controllableSSEClient();
      const stream = new ModelStream(
        "http://calc/events",
        adapter,
        pool,
        undefined,
        makeFactory(client),
      );
      stream.connect();

      sendMessage(client, {
        modelName: "NonExistentModel",
        modelId: "x1",
        data: { foo: "bar" },
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(pool.getById("NonExistentModel", "x1")).toBeUndefined();

      stream.disconnect();
    });

    it("ignores messages with null data", async () => {
      const client = controllableSSEClient();
      const stream = new ModelStream(
        "http://calc/events",
        adapter,
        pool,
        undefined,
        makeFactory(client),
      );
      stream.connect();

      sendMessage(client, {
        modelName: "TestTask",
        modelId: "t1",
        data: null,
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(pool.getById("TestTask", "t1")).toBeUndefined();

      stream.disconnect();
    });

    it("ignores malformed JSON", () => {
      const client = controllableSSEClient();
      const stream = new ModelStream(
        "http://calc/events",
        adapter,
        pool,
        undefined,
        makeFactory(client),
      );
      stream.connect();

      client.onmessage?.({ data: "not json" } as MessageEvent);

      stream.disconnect();
    });
  });

  describe("ephemeral models", () => {
    it("hydrates into pool but skips IDB write", async () => {
      const client = controllableSSEClient();
      const stream = new ModelStream(
        "http://calc/events",
        adapter,
        pool,
        undefined,
        makeFactory(client),
      );
      stream.connect();

      sendMessage(client, {
        modelName: "TestMetric",
        modelId: "m1",
        data: { value: 42, label: "cpu" },
      });

      await vi.waitFor(() => {
        const metric = pool.getById("TestMetric", "m1") as TestMetric | undefined;
        expect(metric).toBeDefined();
        expect(metric!.value).toBe(42);
        expect(metric!.label).toBe("cpu");
      });

      const stored = await adapter.readModel("TestMetric", "m1");
      expect(stored).toBeNull();

      stream.disconnect();
    });

    it("updates existing ephemeral model without IDB write", async () => {
      const metric = new TestMetric();
      metric.hydrate({ id: "m1", value: 10, label: "mem" });
      metric.makeModelObservable();
      pool.put("TestMetric", metric);

      const client = controllableSSEClient();
      const stream = new ModelStream(
        "http://calc/events",
        adapter,
        pool,
        undefined,
        makeFactory(client),
      );
      stream.connect();

      sendMessage(client, {
        modelName: "TestMetric",
        modelId: "m1",
        data: { value: 99 },
      });

      await vi.waitFor(() => {
        expect((pool.getById("TestMetric", "m1") as TestMetric).value).toBe(99);
      });

      const stored = await adapter.readModel("TestMetric", "m1");
      expect(stored).toBeNull();

      stream.disconnect();
    });
  });

  describe("onStatusChange", () => {
    it("fires true on connect, false on disconnect", () => {
      const client = controllableSSEClient();
      const statusChanges: boolean[] = [];
      const stream = new ModelStream(
        "http://calc/events",
        adapter,
        pool,
        (connected) => statusChanges.push(connected),
        makeFactory(client),
      );

      stream.connect();
      expect(statusChanges).toEqual([true]);

      stream.disconnect();
      expect(statusChanges).toEqual([true, false]);
    });

    it("fires false on error, true on reconnect", () => {
      vi.useFakeTimers();

      const clients: SSEClient[] = [];
      const statusChanges: boolean[] = [];
      const factory: SSEClientFactory = () => {
        const c = controllableSSEClient();
        clients.push(c);
        return c;
      };
      const stream = new ModelStream(
        "http://calc/events",
        adapter,
        pool,
        (connected) => statusChanges.push(connected),
        factory,
      );

      stream.connect();
      expect(statusChanges).toEqual([true]);

      (clients[0] as ReturnType<typeof controllableSSEClient>).triggerError();
      expect(statusChanges).toEqual([true, false]);

      vi.advanceTimersByTime(3000);
      expect(statusChanges).toEqual([true, false, true]);

      stream.disconnect();
      vi.useRealTimers();
    });
  });

  describe("reconnect on error", () => {
    it("schedules reconnect when SSE errors", () => {
      vi.useFakeTimers();

      const clients: SSEClient[] = [];
      const factory: SSEClientFactory = () => {
        const c = controllableSSEClient();
        clients.push(c);
        return c;
      };
      const stream = new ModelStream("http://calc/events", adapter, pool, undefined, factory);

      stream.connect();
      expect(clients).toHaveLength(1);
      expect(stream.isConnected).toBe(true);

      (clients[0] as ReturnType<typeof controllableSSEClient>).triggerError();
      expect(stream.isConnected).toBe(false);

      // Advance past reconnect delay (3s)
      vi.advanceTimersByTime(3000);
      expect(clients).toHaveLength(2);
      expect(stream.isConnected).toBe(true);

      stream.disconnect();
      vi.useRealTimers();
    });

    it("disconnect cancels pending reconnect", () => {
      vi.useFakeTimers();

      const clients: SSEClient[] = [];
      const factory: SSEClientFactory = () => {
        const c = controllableSSEClient();
        clients.push(c);
        return c;
      };
      const stream = new ModelStream("http://calc/events", adapter, pool, undefined, factory);

      stream.connect();
      (clients[0] as ReturnType<typeof controllableSSEClient>).triggerError();

      // Disconnect before timer fires
      stream.disconnect();
      vi.advanceTimersByTime(5000);

      // Should NOT have reconnected
      expect(clients).toHaveLength(1);

      vi.useRealTimers();
    });
  });
});
