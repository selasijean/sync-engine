# sync-engine

A TypeScript local-first sync engine. Reads are synchronous from an in-memory pool, writes are optimistic, state stays current across tabs and clients via SSE, and everything persists locally so the app survives reload and works offline. The same engine runs in Node so agents and background workers can hold a live model just like a browser tab.

You bring the backend. The client speaks a small three-endpoint protocol — implement it in any language. A reference Go backend is included in this repo so you can see a working end-to-end system, but it isn't the product.

## What you get

- **Local-first** — every read is sync against an in-memory `ObjectPool`; writes apply optimistically and reconcile with server deltas.
- **Realtime** — multi-tab and multi-client sync via SSE. Other clients' edits show up without polling.
- **Offline** — IndexedDB-backed; transactions queue while disconnected and replay on reconnect.
- **Decorator-driven schema** — declare models once in TypeScript, get persistence, change tracking, relationships, and cascade deletes for free.
- **Batched undo/redo** — group writes into a single undoable action.
- **Headless** — no React or DOM dependency in the core. Run it in Node for agents, CLIs, or service-side workers.
- **Bring your own backend** — three endpoints, no specific language or storage required.

## Two packages

| Import | What's in it |
|---|---|
| `sync-engine` | `StoreManager`, `BaseModel`, decorators, `ObjectPool`, types. Vanilla TS — no React, no DOM. |
| `sync-engine/react` | `<SyncProvider>` and hooks: `useModel`, `useModels`, `useCollection`, `useBackRef`, `useLazyRef`, `useUndoRedo`, `useBatch`, `useBootstrapStatus`. |

## Define your models

Models extend `BaseModel` and use decorators to declare fields and relationships.

```ts
import {
  BaseModel,
  ClientModel,
  Property,
  Reference,
  ReferenceCollection,
  LoadStrategy,
} from "sync-engine";
import type { LazyReferenceCollection } from "sync-engine";

@ClientModel({ loadStrategy: LoadStrategy.Instant })
export class Team extends BaseModel {
  @Property() public name = "";

  @ReferenceCollection("Issue", { inverseOf: "teamId" })
  public issues: LazyReferenceCollection<Issue>;
}

@ClientModel({ loadStrategy: LoadStrategy.Instant })
export class Issue extends BaseModel {
  @Property() public title = "";
  @Property() public priority = 0;

  @Property({ indexed: true })
  public teamId: string | null = null;

  @Reference("Team", { onDelete: "cascade" })
  public team: Team;
}
```

- `@Property` — persisted, observable field. `indexed: true` builds a secondary IndexedDB index on it.
- `@Reference` — a foreign-key to another model. `issue.team` becomes a virtual getter that resolves the Team from the pool.
- `@ReferenceCollection` — one-to-many where the foreign key lives on the child. Pass `lazy: false` to eagerly load alongside the parent (otherwise loads on demand).
- `@OwnedCollection` — one-to-many where the parent stores the child IDs as an array.
- `@BackReference` — single inverse relationship; deleting the owner cascades.
- `loadStrategy` — `Instant` loads at bootstrap; `Lazy` / `Partial` / `ExplicitlyRequested` load on demand; `Ephemeral` stays in the pool only (never persisted).

See [`agent-docs/01-models-and-decorators.md`](agent-docs/01-models-and-decorators.md) for the full decorator reference.

## React quick start

Wrap your app in `<SyncProvider>` once. Import your model file as a side-effect so the decorators run before bootstrap.

```tsx
import "reflect-metadata";
import { SyncProvider } from "sync-engine/react";
import "./models"; // side-effect import — registers model classes

export default function Providers({ children }) {
  return (
    <SyncProvider
      config={{
        workspaceId: "workspace-123",
        bootstrapFetcher: async (type, sinceSyncId) => {
          const res = await fetch(`/api/bootstrap?type=${type}&since=${sinceSyncId ?? 0}`);
          return res.json();
        },
        transactionSender: async (batch) => {
          const res = await fetch("/api/transactions", {
            method: "POST",
            body: JSON.stringify(batch),
          });
          return res.json();
        },
        syncUrl: "/api/events",
      }}
      fallback={<div>Loading…</div>}
    >
      {children}
    </SyncProvider>
  );
}
```

### Reading data

```tsx
const issues = useModels<Issue>("Issue");          // all instances; re-renders on add/remove
const issue = useModel<Issue>("Issue", issueId);   // single by ID
const { phase } = useBootstrapStatus();            // engine lifecycle state
```

### Writing data

```tsx
// Optimistic update — the UI updates immediately; the engine sends to the server in the background.
issue.title = "New title";
issue.save();

// Bulk-assign + send. Works for both new and existing models.
const issue = new Issue();
issue.update({ title: "Hello", priority: 1, teamId: "abc" });

// Pass IDs for related models, not the object itself.
const team = new Team();
team.update({ name: "Engineering" });
const issue2 = new Issue();
issue2.update({ title: "Hello", teamId: team.id });

// Preview / discard — edit locally without committing.
issue.assign({ title: "Draft", priority: 3 });
issue.hasUnsavedChanges;       // true
issue.discardUnsavedChanges(); // reverts to last-saved values
// or: issue.save() to commit

// Batched, single-undo writes.
const batch = useBatch();
batch(() => {
  issue.title = "x"; issue.save();
  issue.priority = 1; issue.save();
});

const { undo, redo, canUndo, canRedo } = useUndoRedo();
```

### Lazy collections

```tsx
const { items: issues, isLoading } = useCollection(team?.issues);   // @ReferenceCollection
const { items: members } = useCollection(team?.members);             // @OwnedCollection
const { value: favorite } = useBackRef(issue?.favorite);             // @BackReference
const { value: doc } = useLazyRef<DocumentContent>("DocumentContent", issue?.id);
```

By default a relationship loads when first accessed. To eagerly load alongside the parent — including recursively for nested non-lazy collections — pass `lazy: false`. See [`agent-docs/04-lazy-loading.md`](agent-docs/04-lazy-loading.md).

## Headless quick start (Node, agents, workers)

The same `StoreManager` runs without React or a browser. Useful for agents that need a live model rather than a snapshot.

```ts
import "reflect-metadata";
import { StoreManager, MemoryAdapter } from "sync-engine";
import EventSource from "eventsource";
import "./models";

const sm = new StoreManager({
  workspaceId: "agent-1",
  bootstrapFetcher: async (type, since) => {
    const res = await fetch(`http://localhost:8080/api/bootstrap?type=${type}&since=${since ?? 0}`);
    return res.json();
  },
  transactionSender: async (batch) => {
    const res = await fetch("http://localhost:8080/api/transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
    });
    return res.json();
  },
  syncUrl: "http://localhost:8081/api/events",
  sseClientFactory: (url) => new EventSource(url),
  storageAdapter: new MemoryAdapter(),
});

await sm.bootstrap();
```

| Environment | `sseClientFactory` | `storageAdapter` |
|---|---|---|
| Browser | default (`EventSource`) | default (IndexedDB) |
| Node.js | `eventsource` package | `MemoryAdapter` or custom |
| Serverless / edge | fetch-based SSE reader | `MemoryAdapter` |

For durable agents, implement `StorageAdapter` (12 methods) against SQLite, Redis, or any KV store.

### Reactivity outside React

```ts
// Pool-level: fires when models of a type are added or removed.
const off = sm.objectPool.subscribe("Issue", () => {
  const issues = sm.objectPool.getAll("Issue");
});

// Collection-level: fires when a lazy relationship loads or invalidates.
team.issues.subscribe(() => { /* team.issues.items is current */ });

// Field-level: fires when a specific field (or derived value) changes.
issue.watch((m) => m.priority, (next, prev) => { /* ... */ });
issue.watch((m) => m.status === "done", (isDone) => { /* ... */ });
```

### Refreshing stale data

When a long-lived agent reconnects after a stream gap, three APIs re-fetch from the server while preserving object identity (existing references see updated values, not new objects):

```ts
await sm.refreshCollection("Activity", "taskId", "t1");
await sm.refreshModels("Activity", ["a1", "a2"]);
await sm.refreshAllOfModel("Activity");
```

### Isolated vs shared agent state

- **Isolated** — each agent has its own `StoreManager`. Convergence happens via SSE. Undo is local; agent writes arrive in the browser as deltas and never touch the browser's undo stack.
- **Shared** — multiple agents share one `StoreManager` in the same process (web worker, VS Code extension, etc.). No round-trip; all writes hit the same undo stack.

## Backend protocol

The client needs three endpoints. Implement them in any language. The reference Go backend in this repo is one example; replace it with whatever fits your stack.

### `GET /api/bootstrap`

Query params: `type` (model name), `since` (syncId, optional). Returns all records of that type, or only those updated since `since`.

```json
{
  "lastSyncId": 5205,
  "subscribedSyncGroups": ["workspace-abc"],
  "models": {
    "Issue": [ { "id": "...", "title": "...", "teamId": "..." } ],
    "Team":  [ { "id": "...", "name": "..." } ]
  },
  "backendDatabaseVersion": 1
}
```

The client calls bootstrap on startup, then subscribes to the SSE stream from `lastSyncId` forward.

### `POST /api/transactions`

```json
{
  "transactions": [
    { "id": "uuid", "action": "I", "modelName": "Issue", "modelId": "uuid",
      "data": { "id": "...", "title": "...", "teamId": "..." } },
    { "id": "uuid", "action": "U", "modelName": "Issue", "modelId": "uuid",
      "changes": { "title": { "oldValue": "Old", "newValue": "New" } } },
    { "id": "uuid", "action": "D", "modelName": "Issue", "modelId": "uuid" }
  ]
}
```

Actions: `I` (insert), `U` (update), `D` (delete), `A` (archive). Updates include old + new per field so the client can rebase optimistic changes against authoritative deltas.

```json
{ "success": true, "lastSyncId": 5206 }
```

### `GET /api/events` (SSE)

Each message is a delta packet:

```json
{
  "syncActions": [
    { "id": 5206, "modelName": "Issue", "modelId": "uuid",
      "action": "U", "data": { "title": "New title", "priority": 1 } }
  ],
  "addedSyncGroups": [],
  "removedSyncGroups": []
}
```

`id` is a monotonic syncId. The client passes `?since=<lastSyncId>` on connect so the server can replay missed events.

### Sync groups

Sync groups control which clients receive which events. Every write is tagged with one or more group labels; the server only delivers an event to SSE connections subscribed to at least one of the same labels. The labels are arbitrary strings — workspace IDs are typical.

The client declares its groups at connect time via the `syncGroups` query param on both `/api/bootstrap` and `/api/events`. If a user is added to a new group mid-session, the server sends a delta with `addedSyncGroups`; the client bootstraps the new data and starts receiving events for it without reconnecting. Wire this up with `syncGroupFetcher`:

```ts
const sm = new StoreManager({
  // ...
  syncGroupFetcher: async (addedGroups) => {
    const res = await fetch(`/api/bootstrap?syncGroups=${addedGroups.join(",")}`);
    return res.json();
  },
});
```

If your app has a single fixed scope per session, you can omit it.

## Documentation

Deeper material lives in [`agent-docs/`](agent-docs/):

- [00 — Architecture overview](agent-docs/00-overview.md)
- [01 — Models and decorators](agent-docs/01-models-and-decorators.md)
- [02 — ObjectPool](agent-docs/02-object-pool.md)
- [03 — IndexedDB and persistence](agent-docs/03-indexeddb-and-persistence.md)
- [04 — Lazy loading](agent-docs/04-lazy-loading.md)
- [05 — Sync groups](agent-docs/05-sync-groups.md)
- [06 — Transactions and undo](agent-docs/06-transactions-and-undo.md)
- [07 — Realtime sync](agent-docs/07-realtime-sync.md)
- [08 — React integration](agent-docs/08-react-integration.md)
- [09 — Headless and agents](agent-docs/09-headless-and-agents.md)

## Reference backend and demo

This repo includes a Go backend (`go/`) and a Next.js demo app (`webapp/`) so you can run a working end-to-end system locally. Treat it as a reference implementation — your real backend can be anything that speaks the protocol above.

**Prerequisites:** Docker, Go 1.22+, Node 18+, Make.

```bash
make go-tidy        # generate go.sum (once after cloning)
make start-backend  # Postgres + Go services (API :8080, SSE :8081)
make install-webapp # install webapp deps (once)
make run-webapp     # Next.js dev server
```

Open [http://localhost:3000](http://localhost:3000) in two tabs to see sync in action.

```bash
make ps           # show running containers
make logs         # tail API + SSE logs
make stop-backend # stop containers, keep Postgres data
make clean        # stop containers + wipe Postgres volume
```

### How the reference backend is wired

One Go binary, two service modes controlled by `SERVICE_MODE`:

- **api** (stateless, `:8080`) — `GET /api/bootstrap` and `POST /api/transactions`. Scales horizontally.
- **sse** (stateful, `:8081`) — `GET /api/events`. Holds SSE connections and runs a Postgres `LISTEN/NOTIFY` goroutine.

Write flow:

1. Client: `issue.title = "x"; issue.save()`.
2. `TransactionQueue` batches and POSTs to the API.
3. Go: `BEGIN` → model write → changelog append → `COMMIT`.
4. Postgres trigger fires `pg_notify`.
5. SSE listener queries the row; broadcaster fans out to subscribed clients.
6. `EventSource` receives the delta; `ObjectPool` updates; React re-renders.

| Endpoint | Service | Purpose |
|---|---|---|
| `GET /api/bootstrap` | api | Full or partial bootstrap |
| `POST /api/transactions` | api | Client mutations |
| `GET /api/events` | sse | SSE stream |
| `GET /api/health` | both | Status check |
| `GET /api/stats` | sse | Connected client count |

### Single-process dev mode

```bash
cd go
go mod tidy
SERVICE_MODE=all DATABASE_URL=postgres://postgres:password@localhost:5432/syncdb?sslmode=disable go run cmd/server/main.go
```

Set both `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_SSE_URL` to `http://localhost:8080`.

## Project structure

```
.
├── packages/
│   └── sync-engine/                 Publishable library (npm: sync-engine)
│       ├── src/
│       │   ├── core/                Engine internals
│       │   └── react/               SyncProvider + hooks
│       └── __tests__/
├── webapp/                          Next.js demo app (reference UI)
│   ├── app/
│   └── lib/models/                  Domain models
├── go/                              Reference backend (Go + Gin + Bun ORM)
│   ├── cmd/server/main.go
│   ├── internal/
│   │   ├── config/                  SERVICE_MODE: all | stateless | stateful
│   │   ├── database/                Bun models, changelog queries
│   │   ├── sync/                    Broadcaster + Listener (LISTEN/NOTIFY)
│   │   ├── handler/                 Bootstrap, transactions, SSE
│   │   └── types/
│   └── migrations/
├── agent-docs/                      Architecture and design docs
├── docker-compose.yml
└── Makefile
```

## Tech stack

- **Client**: TypeScript, MobX, IndexedDB, EventSource (SSE)
- **Reference server**: Go, Gin, Bun ORM, Postgres (LISTEN/NOTIFY), pgx
- **Protocol**: Append-only changelog, monotonic syncId, sync group filtering
