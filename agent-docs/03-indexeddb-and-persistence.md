# IndexedDB and Local Persistence

IndexedDB is the on-disk layer. It gives the app two things: the ability to survive page refreshes without re-fetching everything from the server, and the ability to work offline. It's managed by the `Database` class (`core/Database.ts`).

## Database Structure

Each workspace gets its own IndexedDB database named `sync_{workspaceId}`. Inside it:

```
sync_workspace-123/
  ├── __meta          → DatabaseMeta record (lastSyncId, schemaHash, subscribedSyncGroups)
  ├── __transactions  → Queued user edits (offline resilience)
  ├── Issue           → All cached Issue records (keyed by id)
  ├── Team            → All cached Team records
  ├── User            → All cached User records
  └── DocumentContent → All cached DocumentContent records
```

One object store per model type. Records are stored as plain JSON with `id` as the key path.

### Secondary Indexes

For any `@Property({ indexed: true })` field, the engine creates an IndexedDB secondary index with the same name. So `Issue.teamId` having `indexed: true` means there's a `teamId` index on the `Issue` store.

This enables:

```typescript
db.readModelsByIndex("Issue", "teamId", "team-eng")
// Fast IDB index scan — no full table scan needed
```

Without the index, loading all Issues for a team would require reading every Issue record and filtering in JavaScript — fine for small datasets, unacceptable for large ones.

## The schemaHash and Migrations

The `ModelRegistry` computes a **schemaHash** — a fingerprint of all registered models: their names, schema versions, and property names. This hash is stored in `__meta` at the end of every bootstrap.

On the next startup, before doing anything else, the engine compares the stored hash with the current one. If they differ, a schema migration runs.

### Migration Logic

```
Current IDB version N → target N+1
        │
onupgradeneeded fires
        │
  ├── For each model in registry not in IDB → createObjectStore
  ├── For each store in IDB not in registry → deleteObjectStore
  ├── For each model store:
  │     ├── For each indexed property not yet an index → createIndex
  │     └── For each index not in current properties → deleteIndex
  └── Update __meta.schemaHash
```

This is additive and incremental — adding a new model or adding an `indexed: true` to a property doesn't wipe the database; it just adds the new structure on top.

Destructive migrations (removing a model entirely) do delete the store and lose its cached data. On next bootstrap, the engine will fetch it fresh from the server.

## Bootstrap Types

On startup, `db.determineBootstrapType()` reads `__meta` and returns one of three values:

### Full Bootstrap

**When:** No `__meta` record exists (first time, or IDB was cleared).

**What happens:**
1. Hit the server's bootstrap endpoint — fetch all model data
2. Write everything to IDB
3. Hydrate everything into the ObjectPool
4. Open SSE connection

This is the most expensive path — it's a full round-trip for all data. But it only happens once per device per workspace.

**Two-phase loading for perceived performance:**

Instead of waiting for everything, the engine loads critical models in Phase 1 (Issue, Team, User) and immediately marks the app as Ready. Phase 2 runs in the background loading deferred models (DocumentContent, etc.). The UI is interactive as soon as Phase 1 finishes.

### Partial Bootstrap

**When:** `__meta` exists with a `lastSyncId > 0` — there's a usable local cache.

**What happens:**
1. Load Instant models from IDB (fast, no network)
2. Hydrate them into the pool → UI can render immediately
3. Fetch delta from server: "give me everything since `lastSyncId`"
4. Merge delta into pool and IDB
5. Update `lastSyncId`

This is the most common path after the first visit. It's fast because step 1 is local, and step 3 is usually a small delta.

**One edge case: backend schema change.** If the server's `backendDatabaseVersion` has advanced (a server-side migration ran), the cached data may be stale in a way that deltas can't fix. In this case, partial bootstrap falls back to full.

### Local Bootstrap

**When:** The device is offline (`lastSyncId > 0` but no network connectivity).

**What happens:**
1. Load all Instant models from IDB
2. Hydrate into pool
3. Skip SSE connection
4. App runs from cache — reads work, writes queue locally

Queued writes are stored in `__transactions`. When connectivity is restored, they flush to the server.

## The `lastSyncId`

The sync ID is a monotonically increasing integer on the server. Every SSE delta packet has a `syncId`. The engine tracks the highest one it has processed in `__meta.lastSyncId`.

On SSE reconnect (e.g., tab comes back from background), the EventSource URL includes `?lastSyncId=42`. The server catches the client up with everything it missed since 42 before streaming live deltas. This means reconnection is always safe — you can't miss updates.

## Offline Transaction Caching

When `TransactionQueue.enqueue()` accepts a transaction, it immediately writes it to the `__transactions` store:

```typescript
tx.idbKey = await db.cacheTransaction(tx.serialize());
```

If the app crashes, closes, or loses connectivity before the transaction reaches the server, it survives in IDB. On next startup, the queue rehydrates from `__transactions` and resumes flushing.

Once a transaction reaches `Completed` state (server acknowledged and delta received), it's removed from `__transactions`.

## Summary: What Lives Where

| Data | ObjectPool (RAM) | IndexedDB (disk) |
|---|---|---|
| Instant model instances | All of them | All of them |
| Partial model instances | Only loaded ones | All of them |
| Pending transactions | Yes (queue) | Yes (for crash recovery) |
| `lastSyncId` | No | Yes (in `__meta`) |
| `subscribedSyncGroups` | No | Yes (in `__meta`) |
| Ephemeral properties | Yes | No |
