/**
 * Tests for activateSyncGroup() and deactivateSyncGroup() on StoreManager.
 *
 * These methods let the app programmatically add/remove sync group subscriptions
 * at runtime. deactivateSyncGroup is unsubscribe-only: it removes the group from
 * meta and reconnects SSE, but does not evict already-loaded data. Callers that
 * need eviction do it explicitly via objectPool.remove + database.deleteModelsByIndex.
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
import { BaseModel } from "@sync-engine/BaseModel";
import type { SSEClientFactory } from "@sync-engine/SyncConnection";
import { TestLayeredDriver, addToPool } from "./fixtures";

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

  it("deactivate clears the ephemeral group from meta", async () => {
    const syncGroupFetcher = vi.fn().mockResolvedValue({});
    manager = await makeManager({ syncGroupFetcher });

    await manager.activateSyncGroup("layer-A", { ephemeral: true });
    expect(manager.database.currentMeta?.subscribedSyncGroups).toContain(
      "layer-A",
    );

    await manager.deactivateSyncGroup("layer-A");
    expect(manager.database.currentMeta?.subscribedSyncGroups).not.toContain(
      "layer-A",
    );
  });
});

// ── deactivateSyncGroup() ─────────────────────────────────────────────────────

describe("deactivateSyncGroup()", () => {
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

  it("does not evict already-loaded data — eviction is the caller's responsibility", async () => {
    manager = await makeManager({ initialGroups: ["layer-A"] });
    await seedLayer(manager, "layer-A", ["d1"]);

    await manager.deactivateSyncGroup("layer-A");

    expect(manager.objectPool.getById("TestLayeredDriver", "d1")).toBeDefined();
    expect(
      await manager.database.readModel("TestLayeredDriver", "d1"),
    ).not.toBeNull();
  });

  it("is a no-op if the group is not currently subscribed", async () => {
    manager = await makeManager({ initialGroups: [] });
    await seedLayer(manager, "layer-A", ["d1"]);

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

    await manager.deactivateSyncGroup(["layer-A", "layer-B"]);

    expect(manager.database.currentMeta?.subscribedSyncGroups).toHaveLength(0);
  });

  it("only deactivates the specified groups", async () => {
    manager = await makeManager({
      initialGroups: ["layer-A", "layer-B", "layer-C"],
    });

    await manager.deactivateSyncGroup(["layer-A", "layer-B"]);

    expect(manager.database.currentMeta?.subscribedSyncGroups).toEqual([
      "layer-C",
    ]);
  });

  it("skips IDs that are not currently subscribed", async () => {
    manager = await makeManager({ initialGroups: ["layer-A"] });

    await expect(
      manager.deactivateSyncGroup(["layer-A", "layer-X"]),
    ).resolves.not.toThrow();

    expect(manager.database.currentMeta?.subscribedSyncGroups).toEqual([]);
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
    await manager.activateSyncGroup("layer-A");

    // Fetcher called on first activate and again after reactivation
    expect(syncGroupFetcher).toHaveBeenCalledTimes(2);
  });
});
