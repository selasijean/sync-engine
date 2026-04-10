# Sync Engine

A local-first sync engine with a Go backend. Real-time delta streaming via SSE, optimistic mutations, offline support, batch undo/redo.

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
