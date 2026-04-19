/**
 * Tests for activateSyncGroup() and deactivateSyncGroup() on StoreManager.
 *
 * These methods let the app programmatically add/remove sync group subscriptions
 * at runtime — the primary use case being layer switching, where only a bounded
 * number of layers are held in memory at once.
 *
 * Test models used:
 *   TestLayeredDriver  — LoadStrategy.Instant, syncGroupField: "layerId"
 *   TestScopelessItem  — LoadStrategy.Instant, no syncGroupField
 *
 * Most tests use MemoryAdapter to avoid real IDB overhead. The auto-indexing
 * test uses a real Database to verify the IDB index is created.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockedFunction,
} from "vitest";
import { StoreManager } from "@sync-engine/StoreManager";
import { MemoryAdapter } from "@sync-engine/MemoryAdapter";
import { Database } from "@sync-engine/Database";
import { BaseModel } from "@sync-engine/BaseModel";
import type { SSEClientFactory } from "@sync-engine/SyncConnection";
import { TestLayeredDriver, TestScopelessItem, addToPool } from "./fixtures";

// ── helpers ───────────────────────────────────────────────────────────────────

type SyncGroupFetcher = (
  groups: string[],
) => Promise<Record<string, Record<string, unknown>[]>>;

/** Build a StoreManager backed by MemoryAdapter with a syncGroupFetcher. */
async function makeManager(
  opts: {
    syncGroupFetcher?: MockedFunction<SyncGroupFetcher>;
    initialGroups?: string[];
    syncUrl?: string;
    sseClientFactory?: SSEClientFactory;
  } = {},
) {
  const adapter = new MemoryAdapter();
  const manager = new StoreManager({
    workspaceId: crypto.randomUUID(),
    bootstrapFetcher: vi.fn().mockResolvedValue({
      lastSyncId: 0,
      subscribedSyncGroups: opts.initialGroups ?? [],
      models: {},
    }),
    syncGroupFetcher: opts.syncGroupFetcher,
    storageAdapter: adapter,
    syncUrl: opts.syncUrl,
    sseClientFactory: opts.sseClientFactory,
  });
  await manager.database.connect();
  await manager.database.saveMeta({
    lastSyncId: 0,
    firstSyncId: 0,
    subscribedSyncGroups: opts.initialGroups ?? [],
    schemaHash: "test",
    dbVersion: 1,
    backendDatabaseVersion: 0,
  });
  return manager;
}

/** Seed pool + IDB with TestLayeredDriver records for a given layer. */
async function seedLayer(
  manager: StoreManager,
  layerId: string,
  ids: string[],
) {
  for (const id of ids) {
    const driver = new TestLayeredDriver();
    driver.hydrate({ id, layerId, name: `Driver ${id}` });
    addToPool(manager, "TestLayeredDriver", driver);
    await manager.database.writeModels("TestLayeredDriver", [
      { id, layerId, name: `Driver ${id}` },
    ]);
  }
}

/** Factory that records every URL it's called with and returns a no-op client. */
function recordingSSEFactory(): { factory: SSEClientFactory; urls: string[] } {
  const urls: string[] = [];
  const factory: SSEClientFactory = (url) => {
    urls.push(url);
    return { onmessage: null, onerror: null, close: vi.fn() };
  };
  return { factory, urls };
}

// ── setup / teardown ──────────────────────────────────────────────────────────

let manager: StoreManager;

beforeEach(() => {
  BaseModel.storeManager = null;
});

afterEach(async () => {
  await manager?.teardown();
  BaseModel.storeManager = null;
});

// ── activateSyncGroup() ───────────────────────────────────────────────────────

describe("activateSyncGroup()", () => {
  it("throws when syncGroupFetcher is not configured", async () => {
    manager = await makeManager(); // no syncGroupFetcher

    await expect(manager.activateSyncGroup("layer-A")).rejects.toThrow(
      "syncGroupFetcher",
    );
  });

  it("calls syncGroupFetcher with the given groupId", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({});
    manager = await makeManager({ syncGroupFetcher });

    await manager.activateSyncGroup("layer-A");

    expect(syncGroupFetcher).toHaveBeenCalledWith(
      ["layer-A"],
      expect.objectContaining({ currentMeta: expect.anything() }),
    );
  });

  it("writes fetched records to IDB", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({
      TestLayeredDriver: [
        { id: "d1", layerId: "layer-A", name: "Alpha" },
        { id: "d2", layerId: "layer-A", name: "Beta" },
      ],
    });
    manager = await makeManager({ syncGroupFetcher });

    await manager.activateSyncGroup("layer-A");

    expect(
      await manager.database.readModel("TestLayeredDriver", "d1"),
    ).toMatchObject({ id: "d1", name: "Alpha" });
    expect(
      await manager.database.readModel("TestLayeredDriver", "d2"),
    ).toMatchObject({ id: "d2", name: "Beta" });
  });

  it("hydrates Instant models into the pool", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({
      TestLayeredDriver: [{ id: "d1", layerId: "layer-A", name: "Alpha" }],
    });
    manager = await makeManager({ syncGroupFetcher });

    await manager.activateSyncGroup("layer-A");

    expect(manager.objectPool.getById("TestLayeredDriver", "d1")).toBeDefined();
  });

  it("updates an existing pool model rather than creating a duplicate", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({
      TestLayeredDriver: [{ id: "d1", layerId: "layer-A", name: "Updated" }],
    });
    manager = await makeManager({ syncGroupFetcher });

    // Pre-populate pool with stale data
    const existing = new TestLayeredDriver();
    existing.hydrate({ id: "d1", layerId: "layer-A", name: "Stale" });
    addToPool(manager, "TestLayeredDriver", existing);

    await manager.activateSyncGroup("layer-A");

    const poolModel = manager.objectPool.getById(
      "TestLayeredDriver",
      "d1",
    ) as TestLayeredDriver;
    expect(poolModel).toBeDefined();
    expect(poolModel.name).toBe("Updated");
    // Same instance — no duplicate
    expect(poolModel).toBe(existing);
  });

  it("adds the groupId to meta.subscribedSyncGroups", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({});
    manager = await makeManager({
      syncGroupFetcher,
      initialGroups: ["layer-B"],
    });

    await manager.activateSyncGroup("layer-A");

    expect(manager.database.currentMeta?.subscribedSyncGroups).toContain(
      "layer-A",
    );
    expect(manager.database.currentMeta?.subscribedSyncGroups).toContain(
      "layer-B",
    );
  });

  it("is a no-op if the group is already subscribed", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({});
    manager = await makeManager({
      syncGroupFetcher,
      initialGroups: ["layer-A"],
    });

    await manager.activateSyncGroup("layer-A");
    await manager.activateSyncGroup("layer-A");

    expect(syncGroupFetcher).not.toHaveBeenCalled();
  });

  it("does not duplicate the groupId in meta when activated once", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({});
    manager = await makeManager({ syncGroupFetcher });

    await manager.activateSyncGroup("layer-A");

    const groups = manager.database.currentMeta?.subscribedSyncGroups ?? [];
    expect(groups.filter((g) => g === "layer-A")).toHaveLength(1);
  });

  it("reconnects SSE with the activated group in the URL", async () => {
    const { factory, urls } = recordingSSEFactory();
    const syncGroupFetcher = vi.fn().mockResolvedValue({});

    manager = new StoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 0,
        subscribedSyncGroups: [],
        models: {},
      }),
      syncGroupFetcher,
      syncUrl: "http://test/events",
      sseClientFactory: factory,
    });
    await manager.bootstrap();

    const urlsBefore = urls.length;
    await manager.activateSyncGroup("layer-A");

    // A new SSE connection should have been opened after activation
    expect(urls.length).toBeGreaterThan(urlsBefore);
    expect(urls[urls.length - 1]).toContain("layer-A");
  });
});

// ── activateSyncGroup() — array input ────────────────────────────────────────

describe("activateSyncGroup() with array input", () => {
  it("activates multiple groups in one call", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({});
    manager = await makeManager({ syncGroupFetcher });

    await manager.activateSyncGroup(["layer-A", "layer-B"]);

    expect(manager.database.currentMeta?.subscribedSyncGroups).toContain(
      "layer-A",
    );
    expect(manager.database.currentMeta?.subscribedSyncGroups).toContain(
      "layer-B",
    );
  });

  it("calls syncGroupFetcher once with all new group IDs", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({});
    manager = await makeManager({ syncGroupFetcher });

    await manager.activateSyncGroup(["layer-A", "layer-B"]);

    expect(syncGroupFetcher).toHaveBeenCalledOnce();
    expect(syncGroupFetcher).toHaveBeenCalledWith(
      ["layer-A", "layer-B"],
      expect.anything(),
    );
  });

  it("skips already-subscribed IDs and only fetches new ones", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({});
    manager = await makeManager({
      syncGroupFetcher,
      initialGroups: ["layer-A"],
    });

    await manager.activateSyncGroup(["layer-A", "layer-B"]);

    expect(syncGroupFetcher).toHaveBeenCalledWith(
      ["layer-B"],
      expect.anything(),
    );
  });

  it("is a no-op if all IDs are already subscribed", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({});
    manager = await makeManager({
      syncGroupFetcher,
      initialGroups: ["layer-A", "layer-B"],
    });

    await manager.activateSyncGroup(["layer-A", "layer-B"]);

    expect(syncGroupFetcher).not.toHaveBeenCalled();
  });
});

// ── activateSyncGroup() — fetch: false ────────────────────────────────────────

describe("activateSyncGroup() with fetch: false", () => {
  it("subscribes without calling syncGroupFetcher", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({});
    manager = await makeManager({ syncGroupFetcher });

    await manager.activateSyncGroup("layer-A", { fetch: false });

    expect(syncGroupFetcher).not.toHaveBeenCalled();
    expect(manager.database.currentMeta?.subscribedSyncGroups).toContain(
      "layer-A",
    );
  });

  it("does not require syncGroupFetcher to be configured", async () => {
    manager = await makeManager(); // no syncGroupFetcher

    await expect(
      manager.activateSyncGroup("layer-A", { fetch: false }),
    ).resolves.not.toThrow();
  });

  it("still reconnects SSE after subscribing", async () => {
    const { factory, urls } = recordingSSEFactory();
    manager = new StoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 0,
        subscribedSyncGroups: [],
        models: {},
      }),
      syncUrl: "http://test/events",
      sseClientFactory: factory,
    });
    await manager.bootstrap();

    const urlsBefore = urls.length;
    await manager.activateSyncGroup("layer-A", { fetch: false });

    expect(urls.length).toBeGreaterThan(urlsBefore);
    expect(urls[urls.length - 1]).toContain("layer-A");
  });
});

// ── activateSyncGroup() — ephemeral: true ─────────────────────────────────────

describe("activateSyncGroup() with ephemeral: true", () => {
  it("hydrates models into the pool and writes to IDB as usual", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({
      TestLayeredDriver: [
        { id: "d1", layerId: "layer-A", name: "Alpha" },
      ],
    });
    manager = await makeManager({ syncGroupFetcher });

    await manager.activateSyncGroup("layer-A", { ephemeral: true });

    expect(manager.objectPool.getById("TestLayeredDriver", "d1")).toBeDefined();
    expect(
      await manager.database.readModel("TestLayeredDriver", "d1"),
    ).toMatchObject({ id: "d1", name: "Alpha" });
  });

  it("adds the group to in-memory meta but does not call saveMeta", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({});
    manager = await makeManager({ syncGroupFetcher });

    const saveMetaSpy = vi.spyOn(manager.database, "saveMeta");

    await manager.activateSyncGroup("layer-A", { ephemeral: true });

    // In-memory meta has the group
    expect(manager.database.currentMeta?.subscribedSyncGroups).toContain(
      "layer-A",
    );
    // saveMeta was not called
    expect(saveMetaSpy).not.toHaveBeenCalled();
  });

  it("still reconnects SSE with the group in the URL", async () => {
    const { factory, urls } = recordingSSEFactory();
    const syncGroupFetcher = vi.fn().mockResolvedValue({});

    manager = new StoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 0,
        subscribedSyncGroups: [],
        models: {},
      }),
      syncGroupFetcher,
      syncUrl: "http://test/events",
      sseClientFactory: factory,
    });
    await manager.bootstrap();

    const urlsBefore = urls.length;
    await manager.activateSyncGroup("layer-A", { ephemeral: true });

    expect(urls.length).toBeGreaterThan(urlsBefore);
    expect(urls[urls.length - 1]).toContain("layer-A");
  });

  it("deactivate removes ephemeral group from pool and meta", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({
      TestLayeredDriver: [
        { id: "d1", layerId: "layer-A", name: "Alpha" },
      ],
    });
    manager = await makeManager({ syncGroupFetcher });

    await manager.activateSyncGroup("layer-A", { ephemeral: true });
    expect(manager.objectPool.getById("TestLayeredDriver", "d1")).toBeDefined();

    await manager.deactivateSyncGroup("layer-A");
    expect(
      manager.objectPool.getById("TestLayeredDriver", "d1"),
    ).toBeUndefined();
    expect(manager.database.currentMeta?.subscribedSyncGroups).not.toContain(
      "layer-A",
    );
  });

  it("mixed persisted and ephemeral groups deactivate correctly", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({
      TestLayeredDriver: [],
    });
    manager = await makeManager({ syncGroupFetcher });

    await manager.activateSyncGroup("layer-A", { ephemeral: false });
    await manager.activateSyncGroup("layer-B", { ephemeral: true });
    await seedLayer(manager, "layer-A", ["d-a"]);
    await seedLayer(manager, "layer-B", ["d-b"]);

    await manager.deactivateSyncGroup(["layer-A", "layer-B"]);

    expect(
      manager.objectPool.getById("TestLayeredDriver", "d-a"),
    ).toBeUndefined();
    expect(
      manager.objectPool.getById("TestLayeredDriver", "d-b"),
    ).toBeUndefined();
    // layer-A was persisted, so its IDB records should be cleaned up
    expect(
      await manager.database.readModel("TestLayeredDriver", "d-a"),
    ).toBeNull();
  });
});

// ── deactivateSyncGroup() ─────────────────────────────────────────────────────

describe("deactivateSyncGroup()", () => {
  it("removes models for the target group from the pool", async () => {
    manager = await makeManager({ initialGroups: ["layer-A"] });
    await seedLayer(manager, "layer-A", ["d1", "d2"]);

    await manager.deactivateSyncGroup("layer-A");

    expect(
      manager.objectPool.getById("TestLayeredDriver", "d1"),
    ).toBeUndefined();
    expect(
      manager.objectPool.getById("TestLayeredDriver", "d2"),
    ).toBeUndefined();
  });

  it("does not remove models that belong to other groups", async () => {
    manager = await makeManager({ initialGroups: ["layer-A", "layer-B"] });
    await seedLayer(manager, "layer-A", ["d-a"]);
    await seedLayer(manager, "layer-B", ["d-b"]);

    await manager.deactivateSyncGroup("layer-A");

    expect(
      manager.objectPool.getById("TestLayeredDriver", "d-a"),
    ).toBeUndefined();
    expect(
      manager.objectPool.getById("TestLayeredDriver", "d-b"),
    ).toBeDefined();
  });

  it("leaves models without syncGroupField untouched", async () => {
    manager = await makeManager({ initialGroups: ["layer-A"] });
    await seedLayer(manager, "layer-A", ["d1"]);

    // Seed a TestScopelessItem — it has a layerId field but no syncGroupField
    const item = new TestScopelessItem();
    item.hydrate({ id: "item-1", label: "Untouched", layerId: "layer-A" });
    addToPool(manager, "TestScopelessItem", item);

    await manager.deactivateSyncGroup("layer-A");

    expect(
      manager.objectPool.getById("TestLayeredDriver", "d1"),
    ).toBeUndefined();
    expect(
      manager.objectPool.getById("TestScopelessItem", "item-1"),
    ).toBeDefined();
  });

  it("removes models for the target group from IDB", async () => {
    manager = await makeManager({ initialGroups: ["layer-A"] });
    await seedLayer(manager, "layer-A", ["d1", "d2"]);

    await manager.deactivateSyncGroup("layer-A");

    expect(
      await manager.database.readModel("TestLayeredDriver", "d1"),
    ).toBeNull();
    expect(
      await manager.database.readModel("TestLayeredDriver", "d2"),
    ).toBeNull();
  });

  it("does not remove IDB records for other groups", async () => {
    manager = await makeManager({ initialGroups: ["layer-A", "layer-B"] });
    await seedLayer(manager, "layer-A", ["d-a"]);
    await seedLayer(manager, "layer-B", ["d-b"]);

    await manager.deactivateSyncGroup("layer-A");

    expect(
      await manager.database.readModel("TestLayeredDriver", "d-a"),
    ).toBeNull();
    expect(
      await manager.database.readModel("TestLayeredDriver", "d-b"),
    ).not.toBeNull();
  });

  it("removes the groupId from meta.subscribedSyncGroups", async () => {
    manager = await makeManager({ initialGroups: ["layer-A", "layer-B"] });

    await manager.deactivateSyncGroup("layer-A");

    expect(manager.database.currentMeta?.subscribedSyncGroups).not.toContain(
      "layer-A",
    );
    expect(manager.database.currentMeta?.subscribedSyncGroups).toContain(
      "layer-B",
    );
  });

  it("is a no-op if the group is not currently subscribed", async () => {
    manager = await makeManager({ initialGroups: [] });
    await seedLayer(manager, "layer-A", ["d1"]); // seed data even though not subscribed

    // Should not throw and should not touch data
    await expect(manager.deactivateSyncGroup("layer-A")).resolves.not.toThrow();
    expect(manager.objectPool.getById("TestLayeredDriver", "d1")).toBeDefined();
  });

  it("reconnects SSE without the deactivated group in the URL", async () => {
    const { factory, urls } = recordingSSEFactory();

    manager = new StoreManager({
      workspaceId: crypto.randomUUID(),
      bootstrapFetcher: vi.fn().mockResolvedValue({
        lastSyncId: 0,
        subscribedSyncGroups: ["layer-A"],
        models: {},
      }),
      syncUrl: "http://test/events",
      sseClientFactory: factory,
    });
    await manager.bootstrap();

    const urlsBefore = urls.length;
    await manager.deactivateSyncGroup("layer-A");

    expect(urls.length).toBeGreaterThan(urlsBefore);
    expect(urls[urls.length - 1]).not.toContain("layer-A");
  });
});

// ── deactivateSyncGroup() — array input ──────────────────────────────────────

describe("deactivateSyncGroup() with array input", () => {
  it("deactivates multiple groups in one call", async () => {
    manager = await makeManager({ initialGroups: ["layer-A", "layer-B"] });
    await seedLayer(manager, "layer-A", ["d-a"]);
    await seedLayer(manager, "layer-B", ["d-b"]);

    await manager.deactivateSyncGroup(["layer-A", "layer-B"]);

    expect(
      manager.objectPool.getById("TestLayeredDriver", "d-a"),
    ).toBeUndefined();
    expect(
      manager.objectPool.getById("TestLayeredDriver", "d-b"),
    ).toBeUndefined();
    expect(manager.database.currentMeta?.subscribedSyncGroups).toHaveLength(0);
  });

  it("only evicts models for the specified groups", async () => {
    manager = await makeManager({
      initialGroups: ["layer-A", "layer-B", "layer-C"],
    });
    await seedLayer(manager, "layer-A", ["d-a"]);
    await seedLayer(manager, "layer-B", ["d-b"]);
    await seedLayer(manager, "layer-C", ["d-c"]);

    await manager.deactivateSyncGroup(["layer-A", "layer-B"]);

    expect(
      manager.objectPool.getById("TestLayeredDriver", "d-a"),
    ).toBeUndefined();
    expect(
      manager.objectPool.getById("TestLayeredDriver", "d-b"),
    ).toBeUndefined();
    expect(
      manager.objectPool.getById("TestLayeredDriver", "d-c"),
    ).toBeDefined();
    expect(manager.database.currentMeta?.subscribedSyncGroups).toEqual([
      "layer-C",
    ]);
  });

  it("skips IDs that are not currently subscribed", async () => {
    manager = await makeManager({ initialGroups: ["layer-A"] });
    await seedLayer(manager, "layer-A", ["d-a"]);

    await expect(
      manager.deactivateSyncGroup(["layer-A", "layer-X"]),
    ).resolves.not.toThrow();

    expect(
      manager.objectPool.getById("TestLayeredDriver", "d-a"),
    ).toBeUndefined();
  });
});

// ── activate → deactivate → reactivate roundtrip ──────────────────────────────

describe("activate → deactivate → reactivate roundtrip", () => {
  it("re-fetches models from the server after reactivation", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({
      TestLayeredDriver: [{ id: "d1", layerId: "layer-A", name: "Driver" }],
    });
    manager = await makeManager({ syncGroupFetcher });

    await manager.activateSyncGroup("layer-A");
    expect(manager.objectPool.getById("TestLayeredDriver", "d1")).toBeDefined();

    await manager.deactivateSyncGroup("layer-A");
    expect(
      manager.objectPool.getById("TestLayeredDriver", "d1"),
    ).toBeUndefined();

    await manager.activateSyncGroup("layer-A");
    expect(manager.objectPool.getById("TestLayeredDriver", "d1")).toBeDefined();

    // Fetcher called on first activate and again after reactivation — not on deactivate
    expect(syncGroupFetcher).toHaveBeenCalledTimes(2);
  });

  it("pool and IDB are clean between deactivation and reactivation", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({
      TestLayeredDriver: [{ id: "d1", layerId: "layer-A", name: "Driver" }],
    });
    manager = await makeManager({ syncGroupFetcher });

    await manager.activateSyncGroup("layer-A");
    await manager.deactivateSyncGroup("layer-A");

    // Verify clean state before reactivation
    expect(
      manager.objectPool.getById("TestLayeredDriver", "d1"),
    ).toBeUndefined();
    expect(
      await manager.database.readModel("TestLayeredDriver", "d1"),
    ).toBeNull();
  });
});

// ── syncGroupField implies auto-indexing ──────────────────────────────────────

describe("syncGroupField auto-indexing in IDB", () => {
  it("creates an IDB index for syncGroupField even when @Property has no indexed: true", async () => {
    const db = new Database(crypto.randomUUID());
    await db.connect();

    // readModelsByIndex uses the IDB index when available.
    // Seed two drivers in different layers, then query by layerId.
    await db.writeModels("TestLayeredDriver", [
      { id: "d1", layerId: "layer-A", name: "Alpha" },
      { id: "d2", layerId: "layer-B", name: "Beta" },
    ]);

    const results = await db.readModelsByIndex(
      "TestLayeredDriver",
      "layerId",
      "layer-A",
    );

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("d1");

    await db.destroy();
  });
});
