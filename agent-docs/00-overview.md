# Sync Engine — Architecture Overview

This is a real-time collaborative data sync engine. Think of it as a client-side database that stays automatically in sync with a server and with all other connected clients, while also persisting locally so the app survives page refreshes and works offline.

## The Four Pillars

```
┌─────────────────────────────────────────────────────────┐
│                     React Components                     │
│         useModels / useModel / useCollection            │
└─────────────────────┬───────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────┐
│                   ObjectPool (in-memory)                 │
│  Map<modelName, Map<id, instance>>                       │
│  All hydrated model instances live here                  │
│  Fires pub/sub events → triggers React re-renders        │
└──────┬──────────────────────────────────────┬───────────┘
       │                                      │
┌──────▼──────────────┐          ┌────────────▼──────────┐
│  TransactionQueue   │          │   SyncConnection      │
│  User edits →       │          │   SSE stream from     │
│  HTTP POST to server│          │   server → applies    │
│  Undo/redo stack    │          │   delta packets       │
└──────┬──────────────┘          └────────────┬──────────┘
       │                                      │
┌──────▼──────────────────────────────────────▼──────────┐
│                    IndexedDB (on disk)                   │
│  Persistent local cache.                                 │
│  Also queued transactions for offline resilience.        │
└─────────────────────────────────────────────────────────┘
```

## The Major Components

| Component | File | One-line role |
|---|---|---|
| `ModelRegistry` | `core/ModelRegistry.ts` | Stores metadata for every model class (properties, types, relationships) |
| `ObjectPool` | `core/ObjectPool.ts` | In-memory cache of all live instances; drives React reactivity |
| `BaseModel` | `core/BaseModel.ts` | Base class all models extend; handles hydration, change tracking, lazy collections |
| Decorators | `core/decorators.ts` | The language you use to define models (`@Property`, `@Reference`, etc.) |
| `Database` | `core/Database.ts` | IndexedDB wrapper; handles schema migration and persistence |
| `Store` (Full/Partial) | `core/Store.ts` | Per-model bootstrap loader — instant vs on-demand loading |
| `LazyCollection` types | `core/LazyCollection.ts` | Deferred one-to-many relationships; only load data when accessed |
| `TransactionQueue` | `core/TransactionQueue.ts` | Batches user edits, sends to server, manages undo/redo |
| `SyncConnection` | `core/SyncConnection.ts` | Listens to SSE stream; processes and applies delta packets |
| `StoreManager` | `core/StoreManager.ts` | Top-level orchestrator; wires everything together |
| React hooks | `react/index.tsx` | `useModels`, `useModel`, `useCollection`, `useUndoRedo` |

## The Data Flow

### Writing (user makes a change)

1. Component sets a property: `issue.title = "New Title"`
2. The setter records the old value for undo
3. `issue.save()` creates an `UpdateTransaction` and enqueues it
4. `TransactionQueue` debounces 50ms, then HTTP POSTs to the server
5. Server processes it and returns an ACK with a `syncId`
6. Transaction moves to `CompletedButUnsynced`
7. Server broadcasts the change to all clients via SSE
8. When the SSE delta arrives with matching `syncId`, transaction is fully `Completed`

### Reading (delta arrives from server)

1. `SyncConnection` receives SSE message, parses delta packet
2. Writes the new data to IndexedDB (durable first)
3. Updates the model instance in the ObjectPool
4. ObjectPool fires subscribers for that model type
5. `useSyncExternalStore` sees the snapshot changed → component re-renders

## Lifecycle of the StoreManager

```
bootstrap()
  │
  ├─ 1. Create FullStore/PartialStore per model type
  ├─ 2. Connect to IndexedDB (run schema migration if needed)
  ├─ 3. Determine bootstrap type: Full / Partial / Local
  │       Full    → no local cache, fetch everything from server
  │       Partial → has local cache, fetch only delta since lastSyncId
  │       Local   → offline, use IDB cache only
  ├─ 4. Load data (two-phase: critical models first, deferred in background)
  ├─ 5. Open SSE connection
  └─ 6. Signal Ready → UI renders
```

## Reading Order for These Docs

1. **[01-models-and-decorators.md](./01-models-and-decorators.md)** — How models are defined and what the decorators do
2. **[02-object-pool.md](./02-object-pool.md)** — The in-memory store: benefits, drawbacks, memory trade-offs
3. **[03-indexeddb-and-persistence.md](./03-indexeddb-and-persistence.md)** — Local persistence, schema migration, bootstrap types
4. **[04-lazy-loading.md](./04-lazy-loading.md)** — How lazy collections work and why they matter for heap size
5. **[05-sync-groups.md](./05-sync-groups.md)** — What sync groups are and how they partition data subscriptions
6. **[06-transactions-and-undo.md](./06-transactions-and-undo.md)** — Transaction lifecycle, batching, undo/redo, offline resilience
7. **[07-realtime-sync.md](./07-realtime-sync.md)** — SSE connection, delta packets, conflict rebase, cascade delete
8. **[08-react-integration.md](./08-react-integration.md)** — How the engine plugs into React
