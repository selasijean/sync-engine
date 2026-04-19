# Sync Engine

A local-first sync engine with a Go backend. Real-time delta streaming via SSE, optimistic mutations, offline support, batch undo/redo.

## Quick start

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

## React hooks

Wrap your app in `<SyncProvider>` once, then use the hooks anywhere inside it.

### Defining models

Models extend `BaseModel` and use decorators to declare their fields and relationships.

```ts
import { BaseModel, ClientModel, Property, Reference, ReferenceCollection, LoadStrategy } from "sync-engine";
import type { LazyReferenceCollection } from "sync-engine";

@ClientModel({ loadStrategy: LoadStrategy.Instant })
export class Team extends BaseModel {
  @Property() public name = "";

  @ReferenceCollection("Issue", { lazy: true })
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

- `@Property` — a persisted field, synced with the server
- `@Reference` — a foreign key + resolved model instance (e.g. `issue.team`)
- `@ReferenceCollection` — a one-to-many relationship, loaded lazily on demand
- `loadStrategy: LoadStrategy.Instant` — loaded at bootstrap; use `Lazy` or `Partial` for large or infrequently-needed models, or `Ephemeral` for pool-only models that are never persisted to IDB

### Setup

Import your models before `bootstrap()` is called — model classes register themselves via decorators on import.

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

        // Optional: secondary SSE connections for external services
        modelStreams: [
          {
            url: "/calc/events",
            onStatusChange: (connected) => {
              if (!connected) {
                // Stream disconnected — refresh stale data
              }
            },
          },
        ],
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
const issues = useModels<Issue>("Issue");          // all instances, re-renders on add/remove
const issue = useModel<Issue>("Issue", issueId);   // single by ID
const { phase } = useBootstrapStatus();            // loading state
```

### Writing data

```tsx
// Optimistic update
issue.title = "New title";
issue.save();

// Bulk-assign fields from an object using update() — works for both new and existing models
const issue = new Issue();
issue.update({ title: "Hello", priority: 1, teamId: "abc" }); // creates + sends to server

issue.update({ title: "New title", priority: 2 }); // updates + sends to server

// For related models, save each separately and pass the ID — not the object
const team = new Team();
team.update({ name: "Engineering" });

const issue = new Issue();
issue.update({ title: "Hello", teamId: team.id });

// Batch — grouped into one undoable action
const batch = useBatch();
batch(() => {
  issue.title = "New title"; issue.save();
  issue.priority = 1; issue.save();
});

// Async batch
batch(async () => {
  const comments = await issue.comments.load();
  comments.forEach(c => { c.text = "resolved"; c.save(); });
});

const { undo, redo, canUndo, canRedo } = useUndoRedo();
```

### Lazy collections

```tsx
const { items: issues, isLoading } = useCollection(team?.issues);   // @ReferenceCollection
const { items: members } = useCollection(team?.members);             // @OwnedCollection
const { value: favorite } = useBackRef(issue?.favorite);             // @BackReference
```

### Lazy single models

```tsx
const { value: content, isLoading } = useLazyRef<DocumentContent>("DocumentContent", issue?.id);
```

## Structure

```
.
├── packages/
│   └── sync-engine/                 Publishable library (npm: sync-engine)
│       ├── src/
│       │   ├── core/                Engine internals
│       │   └── react/               SyncProvider + hooks
│       └── __tests__/
├── webapp/                          Next.js demo app
│   ├── app/
│   └── lib/models/                  Domain models
├── go/                              Backend (Go + Gin + Bun ORM)
│   ├── cmd/server/main.go
│   ├── internal/
│   │   ├── config/                  SERVICE_MODE: all | stateless | stateful
│   │   ├── database/                Bun models, changelog queries
│   │   ├── sync/                    Broadcaster + Listener (LISTEN/NOTIFY)
│   │   ├── handler/                 Bootstrap, transactions, SSE
│   │   └── types/
│   └── migrations/
├── docker-compose.yml
└── Makefile
```

## How it works

One Go binary, two service modes controlled by `SERVICE_MODE`:

**api** (stateless, `:8080`) — `GET /api/bootstrap` and `POST /api/transactions`. Scales horizontally.

**sse** (stateful, `:8081`) — `GET /api/events`. Holds SSE connections and runs a Postgres `LISTEN/NOTIFY` goroutine.

### Write flow

1. `issue.title = "x"; issue.save()`
2. `TransactionQueue` batches and POSTs to the API
3. Go: `BEGIN` → model write → changelog append → `COMMIT`
4. Postgres trigger fires `pg_notify`
5. SSE listener queries the row, broadcaster fans out to connected clients
6. `EventSource` receives the event, delta pipeline runs, `ObjectPool` updates → re-render

### Data format

Bun ORM maps transparently: `team_id` (Postgres) → `TeamID` (Go struct) → `teamId` (JSON). No manual transformation.

## Protocol

The client speaks a simple protocol. You can replace the Go backend with any server that implements these three endpoints.

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

The client calls bootstrap once per model type on startup, then subscribes to the SSE stream from `lastSyncId` forward.

### `POST /api/transactions`

```json
{
  "transactions": [
    {
      "id": "uuid",
      "action": "I",
      "modelName": "Issue",
      "modelId": "uuid",
      "data": { "id": "...", "title": "...", "teamId": "..." }
    },
    {
      "id": "uuid",
      "action": "U",
      "modelName": "Issue",
      "modelId": "uuid",
      "changes": {
        "title": { "oldValue": "Old", "newValue": "New" }
      }
    },
    {
      "id": "uuid",
      "action": "D",
      "modelName": "Issue",
      "modelId": "uuid"
    }
  ]
}
```

Actions: `I` (insert), `U` (update), `D` (delete), `A` (archive). Updates include old+new per field so the client can rebase optimistic changes. Response:

```json
{ "success": true, "lastSyncId": 5206 }
```

The returned `lastSyncId` is the syncId assigned to these writes. The client uses it to mark the transactions as fully synced once the matching delta arrives over SSE.

### `GET /api/events` (SSE)

Each message is a JSON-encoded delta packet:

```json
{
  "syncActions": [
    {
      "id": 5206,
      "modelName": "Issue",
      "modelId": "uuid",
      "action": "U",
      "data": { "title": "New title", "priority": 1 }
    }
  ],
  "addedSyncGroups": [],
  "removedSyncGroups": []
}
```

`id` is a monotonic syncId. The client passes `?since=<lastSyncId>` on connect to catch up on missed events. `addedSyncGroups`/`removedSyncGroups` tell the client to bootstrap newly-scoped models.

### Sync groups

Sync groups control which clients receive which events. Every write is tagged with one or more group labels (sent by the client as `X-Sync-Groups: workspace-abc`). The server only delivers that event to SSE connections subscribed to at least one of the same labels.

In practice, a workspace ID is the most common use — users only receive events for their own workspace. But the labels are arbitrary strings, so you can scope as broadly or narrowly as you need.

The client declares its groups at connect time via the `syncGroups` query param on both `/api/bootstrap` and `/api/events`. If a user is added to a new group mid-session, the server sends a delta packet with `addedSyncGroups`, the client bootstraps the new data, and starts receiving events for it — no reconnect needed. Supply a `syncGroupFetcher` to handle this:

```ts
const sm = new StoreManager({
  // ...
  syncGroupFetcher: async (addedGroups) => {
    const res = await fetch(`/api/bootstrap?syncGroups=${addedGroups.join(",")}`);
    return res.json();
  },
});
```

If your app has a single fixed scope per session, you can omit `syncGroupFetcher`.

## Endpoints

| Endpoint | Service | Purpose |
|---|---|---|
| `GET /api/bootstrap` | api | Full or partial bootstrap |
| `POST /api/transactions` | api | Client mutations |
| `GET /api/events` | sse | SSE stream |
| `GET /api/health` | both | Status check |
| `GET /api/stats` | sse | Connected client count |

## Local dev (single process)

```bash
cd go
go mod tidy
SERVICE_MODE=all DATABASE_URL=postgres://postgres:password@localhost:5432/syncdb?sslmode=disable go run cmd/server/main.go
```

Set both `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_SSE_URL` to `http://localhost:8080`.

## Headless / agent usage

Most agent patterns follow a request/response loop: fetch context, do work, write back. The agent operates on a snapshot and has no awareness of changes happening between steps.

Running an agent on top of this engine gives it a live model instead — the same in-memory state a browser tab holds, kept current via SSE. Changes from humans or other agents arrive in real time without polling, and writes propagate back to every connected client immediately.

The engine core has no React or browser dependencies. The same `StoreManager` that powers the UI runs in Node.js.

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

### Reactivity

**`objectPool.subscribe`** — fires when models of a given type are added or removed from the pool:

```ts
const unsubscribe = sm.objectPool.subscribe("Issue", () => {
  const issues = sm.objectPool.getAll("Issue");
  // react to structural changes (new/removed instances)
});
```

**`collection.subscribe`** — fires when a lazy relationship loads or changes:

```ts
const unsubscribe = team.issues.subscribe(() => {
  // team.issues.items is current
});
```

**`model.watch()`** — fires when a specific field (or derived value) changes:

```ts
const unwatch = issue.watch(
  (m) => m.priority,
  (newValue, oldValue) => console.log(oldValue, "→", newValue),
);

// derived selector works too
issue.watch((m) => m.status === "done", (isDone) => { ... });
```

Use `objectPool.subscribe` to react to new models arriving from the SSE stream. Use `watch` for field-level changes on a model you already hold.

### Refreshing stale data

When a secondary stream disconnects and reconnects, data may be stale. Three refresh APIs re-fetch from the server while preserving object identity (components holding references see updated values, not new objects):

```ts
// Re-fetch a specific collection
await sm.refreshCollection("Activity", "taskId", "t1");

// Re-fetch specific models by ID
await sm.refreshModels("Activity", ["a1", "a2"]);

// Re-fetch everything previously loaded for a model type
await sm.refreshAllOfModel("Activity");
```

### Execution environments

| Environment | `sseClientFactory` | `storageAdapter` |
|---|---|---|
| Browser | default (`EventSource`) | default (IndexedDB) |
| Node.js | `eventsource` package | `MemoryAdapter` or custom |
| Serverless / edge | fetch-based SSE reader | `MemoryAdapter` |

For agents that need durability across restarts, implement `StorageAdapter` with SQLite, Redis, or any key-value store (12 methods).

### Isolated vs shared agent state

**Isolated** — each agent has its own `StoreManager`. All instances converge via SSE. The undo stack is local: agent writes arrive in the browser as SSE deltas and never touch the browser's undo stack. If you need human-reversible agent writes, build it at the application layer (e.g. the agent writes an `AgentAction` record and the UI has a revert button).

**Shared** — multiple agents share one `StoreManager` instance (only possible in the same process — web worker, VS Code extension, etc.). Writes are immediately visible across all agents without a server round-trip, and agent writes go onto the same undo stack as human writes.

## Tech stack

- **Client**: TypeScript, MobX, IndexedDB, EventSource (SSE)
- **Server**: Go, Gin, Bun ORM, Postgres (LISTEN/NOTIFY), pgx
- **Protocol**: Append-only changelog, monotonic syncId, sync group filtering
