# Sync Engine

A local-first sync engine with a Go backend. Real-time delta streaming via SSE, optimistic mutations, offline support, batch undo/redo.

## Built for the agent world

Most agent frameworks treat state as a solved problem: load context from a database, do work, write results back. Each agent operates on a static snapshot. Two agents working in the same workspace have no shared live model — they coordinate through the server, with all the latency and consistency problems that implies.

This engine takes a different position. **The same sync primitive that powers the browser UI is the agent's working memory.** An agent doesn't query a database — it holds a reference to the same live in-memory model that a human is looking at in a browser tab. When the human edits something, the agent sees it instantly. When the agent acts, the human sees it immediately. The SSE stream is the coordination layer for both.

This matters more as agents become real collaborators rather than background scripts:

- **Real-time awareness**: agents react to changes as they happen — a human reassigns a ticket, an agent's subscription fires before the human's cursor has moved.
- **Optimistic mutations**: agents don't wait for server round-trips to act. Writes are local-first, queued to the server in the background, broadcast to all consumers. An agent operates at the same speed as a human typing.
- **Reversibility**: the undo stack works for agent writes too. A human can undo what an agent did. An agent can undo its own previous action. This is foundational for human-in-the-loop workflows where trust is still being established.
- **Multi-agent coordination without a message bus**: agents sharing a `StoreManager` see each other's writes instantly with no protocol overhead. Agents with separate `StoreManager` instances converge via the SSE stream. Either way, there is no separate coordination layer to design.

### Running an agent

The engine core has zero React and zero browser dependencies. React hooks are a thin optional layer on top. The same `StoreManager` that powers a browser UI runs anywhere TypeScript runs.

```ts
import { StoreManager } from "./webapp/lib/sync-engine/core/StoreManager";
import EventSource from "eventsource"; // npm i eventsource

const sm = new StoreManager({
  workspaceId: "agent-session-1",
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
  sseClientFactory: (url) => new EventSource(url), // swap in Node.js-compatible SSE
});

await sm.bootstrap();

// The full world state, live
const issues = sm.objectPool.getAll("Issue");

// Write — optimistic locally, queued to server, broadcast to every connected client and agent
issues[0].title = "Fixed by agent";
issues[0].save();
```

### Execution environments

The two pluggable seams — `sseClientFactory` and `storageAdapter` — let the engine run in any environment:

| Environment | `sseClientFactory` | `storageAdapter` |
|---|---|---|
| Browser | default (`EventSource`) | default (IndexedDB) |
| Node.js (long-running) | `eventsource` npm package | `MemoryAdapter` or custom |
| Serverless / edge | fetch-based SSE reader | `MemoryAdapter` |
| CLI tool | `eventsource` npm package | `MemoryAdapter` |

**`MemoryAdapter`** is a full in-memory implementation of the storage interface — no IndexedDB, no filesystem, no globals. It is the right default for any agent that doesn't need state to survive a process restart:

```ts
import { MemoryAdapter } from "./core/MemoryAdapter";

const sm = new StoreManager({
  workspaceId: "agent-1",
  bootstrapFetcher: ...,
  storageAdapter: new MemoryAdapter(),
  sseClientFactory: (url) => new EventSource(url),
});
```

For agents that do need durability — resuming a long task after a restart, replaying pending transactions after a crash — implement `StorageAdapter` with SQLite, Redis, or any key-value store. The interface is small (12 methods) and the contract is straightforward.

### Isolated vs shared agent state

**Isolated** — each agent creates its own `StoreManager`. Independent working memory. All instances converge via the SSE stream: a write by one agent arrives at every other in real time. Use this for parallel agents working independently on different parts of a problem.

**Shared** — multiple agents share one `StoreManager` instance. Single pool, one SSE connection. Writes from any agent are immediately visible to all others without a server round-trip. Use this for tightly-collaborating agents, or for an agent running alongside a UI that needs to see and react to human edits instantly.

### Reactivity in headless mode

React's observer model doesn't exist in Node.js. The engine exposes two callback APIs that fill that role.

**`objectPool.subscribe`** — fires whenever any model of a given type is added, updated, or removed. This is the primary way an agent reacts to SSE deltas arriving from the server:

```ts
const unsubscribe = sm.objectPool.subscribe("Issue", () => {
  const issues = sm.objectPool.getAll("Issue");
  // re-evaluate state, make decisions, write back
});

// Release when the agent shuts down
unsubscribe();
```

This is the agent's core event loop. The SSE stream delivers a delta → the pool updates → the subscription fires → the agent acts → the write is queued → the server broadcasts → all other agents and browser clients update. No polling, no manual diffing.

**`collection.subscribe`** — fires when a specific lazy relationship loads or receives new members:

```ts
const team = sm.objectPool.getById("Team", teamId) as Team;
const unsubscribe = team.issues.subscribe(() => {
  // team.issues.items is now current
});
```

Both return an unsubscribe function. Call it on shutdown. Both are plain callbacks — no MobX, no browser globals.

**`model.watch()` — per-property reactivity**

For field-level granularity — fire only when a specific property changes — use `watch` directly on the model:

```ts
const issue = sm.objectPool.getById("Issue", id) as Issue;

const unwatch = issue.watch(
  (m) => m.priority,
  (newValue, oldValue) => console.log("priority changed:", oldValue, "→", newValue),
);

// Release when done
unwatch();
```

The selector can read any combination of fields — only the return value is compared, so derived conditions work too:

```ts
issue.watch(
  (m) => m.status === "done",
  (isDone) => console.log("completion changed:", isDone),
);
```

One boundary to know: `watch` tracks field changes on a model you already hold. It does not know when the pool gains a new model. For reacting to new arrivals from SSE deltas, use `objectPool.subscribe`. For reacting to field changes on a model you already hold, use `watch`.

## Structure

```
.
├── webapp/                          Next.js demo
│   ├── app/                         Pages + providers
│   └── lib/sync-engine/             Client sync engine (TypeScript)
│       ├── core/                    Engine internals (14 files)
│       ├── models/                  Domain models
│       └── react/                   SyncProvider + 10 hooks
├── go/                              Backend (Go + Gin + Bun ORM)
│   ├── cmd/server/main.go           Entry point (mode-driven)
│   ├── internal/
│   │   ├── config/                  SERVICE_MODE: all | stateless | stateful
│   │   ├── database/                Bun models, changelog queries, registry
│   │   ├── sync/                    Broadcaster (fan-out) + Listener (LISTEN/NOTIFY)
│   │   ├── handler/                 Bootstrap, transactions, SSE events
│   │   └── types/                   API wire types
│   └── migrations/                  SQL schema + trigger
├── docker-compose.yml               Postgres + API + SSE
└── Makefile
```

## Quick start

**Prerequisites:** Docker, Go 1.22+, Node 18+, Make.

```bash
# 1. Generate go.sum (once after cloning — required before Docker build)
make go-tidy

# 2. Start Postgres + both Go services (API on :8080, SSE on :8081)
make start-backend

# 3. Install webapp dependencies (once)
make install-webapp

# 4. Start the Next.js dev server
make run-webapp
```

Open [http://localhost:3000](http://localhost:3000) in two browser tabs. Create an issue in one — it appears in the other instantly.

No environment setup needed. The webapp defaults to `http://localhost:8080` (API) and `http://localhost:8081` (SSE).

### Verify the backend is up

```bash
make ps           # show running containers
make logs         # tail API + SSE logs
curl http://localhost:8080/api/health
curl http://localhost:8081/api/health
```

### Tear down

```bash
make stop-backend   # stop containers, keep Postgres data
make clean          # stop containers + wipe Postgres volume
```

## How it works

One Go binary, two service modes controlled by `SERVICE_MODE`:

**api** (stateless, `:8080`) — `GET /api/bootstrap` and `POST /api/transactions`. No persistent state. Scale horizontally behind a load balancer.

**sse** (stateful, `:8081`) — `GET /api/events`. Runs a Postgres `LISTEN/NOTIFY` goroutine and holds SSE connections open. Each instance independently receives every notification from Postgres.

### Write flow

1. Client: `issue.title = "x"; issue.save()`
2. `TransactionQueue` batches and POSTs to the API service
3. Go handler (Bun ORM): `BEGIN` → model table write → changelog append → `COMMIT`
4. Postgres trigger: `pg_notify('changelog_changes', '5205')`
5. SSE service's listener receives the notification, queries the row via Bun
6. Broadcaster fans out to connected clients (sync group filtered)
7. Browser `EventSource` receives the event
8. `SyncConnection` feeds it into the 7-step delta pipeline
9. `ObjectPool` updates → React re-renders

### Data format

Bun ORM handles the snake_case ↔ camelCase mapping transparently:
- Postgres columns: `team_id`, `created_at`, `sort_order`
- Go structs: `TeamID`, `CreatedAt`, `SortOrder` (bun tags map to snake_case)
- JSON output: `teamId`, `createdAt`, `sortOrder` (json tags map to camelCase)

No manual transformation anywhere in the pipeline.

## Endpoints

| Endpoint | Service | Purpose |
|---|---|---|
| `GET /api/bootstrap` | api | Full or partial bootstrap |
| `POST /api/transactions` | api | Client mutations |
| `GET /api/events` | sse | SSE stream (catch-up + live) |
| `GET /api/health` | both | Status check |
| `GET /api/stats` | sse | Connected client count |

## Local dev (single process)

Run everything in one Go process without Docker:

```bash
cd go
go mod tidy
SERVICE_MODE=all DATABASE_URL=postgres://postgres:password@localhost:5432/syncdb?sslmode=disable go run cmd/server/main.go
```

Set both `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_SSE_URL` to `http://localhost:8080` in the webapp.

## React hooks

Wrap your app in `<SyncProvider>` once, then use the hooks anywhere inside it.

### Setup

```tsx
import { SyncProvider } from "@/sync-engine/react";

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
// All instances of a model — re-renders when any are added/removed
const issues = useModels<Issue>("Issue");

// Single model by ID — re-renders when pool changes for this type
const issue = useModel<Issue>("Issue", issueId);

// Bootstrap phase (for loading states)
const { phase } = useBootstrapStatus();
```

### Writing data

```tsx
// Optimistic update — saves locally and queues for server
issue.title = "New title";
issue.save();

// Group changes into one undoable action
const batch = useBatch();
batch(() => {
  issue.title = "New title";
  issue.save();
  issue.priority = 1;
  issue.save();
});

// Async batch — works with lazy loads inside
batch(async () => {
  const comments = await issue.comments.load();
  comments.forEach(c => { c.text = "resolved"; c.save(); });
});

// Undo / redo
const { undo, redo, canUndo, canRedo } = useUndoRedo();
```

### Lazy collections

```tsx
// @ReferenceCollection — child holds the FK (e.g. issue.teamId)
const team = useModel<Team>("Team", teamId);
const { items: issues, isLoading } = useCollection(team?.issues);

// @OwnedCollection — parent holds the IDs array (e.g. team.memberIds)
const { items: members } = useCollection(team?.members);

// @BackReference — single inverse model
const { value: favorite } = useBackRef(issue?.favorite);
```

### Lazy single models

```tsx
// For Partial/Lazy models not loaded at bootstrap (e.g. DocumentContent)
const { value: content, isLoading } = useLazyRef<DocumentContent>(
  "DocumentContent",
  issue?.id,
);
```

## Tech stack

- **Client**: TypeScript, MobX, IndexedDB, EventSource (SSE)
- **Server**: Go, Gin, Bun ORM, Postgres (LISTEN/NOTIFY), pgx (for listener)
- **Protocol**: Append-only changelog, monotonic syncId, sync group filtering
