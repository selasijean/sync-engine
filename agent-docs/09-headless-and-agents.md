# Headless Usage and Agents

The engine has zero React and zero browser dependencies. React hooks are a thin optional layer on top. The same `StoreManager` that powers a browser UI runs in Node.js, serverless functions, CLI tools, or any other TypeScript environment.

This doc covers what changes when you run outside a browser.

## The Two Pluggable Seams

Two constructor options make the engine portable:

```typescript
const sm = new StoreManager({
  workspaceId: "agent-1",
  bootstrapFetcher: ...,
  storageAdapter: new MemoryAdapter(),         // replaces IndexedDB
  sseClientFactory: (url) => new EventSource(url), // replaces browser EventSource
});
```

Everything else — ObjectPool, TransactionQueue, SyncConnection, undo stack, lazy collections — works identically in all environments.

### `storageAdapter`

Controls where model data and pending transactions are persisted.

| Adapter | Use when |
|---|---|
| `Database` (default) | Browser — needs IndexedDB |
| `MemoryAdapter` | Node.js agents, serverless, CLI — no persistence needed |
| Custom `StorageAdapter` | Need durability across restarts (SQLite, Redis, etc.) |

`MemoryAdapter` (`core/MemoryAdapter.ts`) is a full in-memory implementation backed by `Map` and an array. It satisfies the complete `StorageAdapter` interface with no platform dependencies. Data lives for the lifetime of the process only.

The `StorageAdapter` interface (`core/Database.ts`) is small — 12 methods. Implementing it for a custom backend (e.g. SQLite for a long-running agent that needs to survive restarts) is straightforward.

### `sseClientFactory`

Controls how the engine opens its SSE connection.

```typescript
// Browser (default — no config needed)
// Uses globalThis.EventSource

// Node.js
import EventSource from "eventsource"; // npm i eventsource
sseClientFactory: (url) => new EventSource(url)

// Serverless / fetch-based
sseClientFactory: (url) => makeFetchSSEClient(url)
```

The factory receives the fully-constructed URL (including `lastSyncId` and sync group params) and must return an object matching the `SSEClient` interface: `{ onmessage, onerror, close }`.

## Models in Headless Mode

Models must be registered with the engine before `bootstrap()` is called. In a browser app, this happens naturally because the model files are imported by components. In a headless agent, you must import them explicitly:

```typescript
import "reflect-metadata";
import { StoreManager, MemoryAdapter } from "sync-engine";
import EventSource from "eventsource";

// Side-effect import — registers all model classes with ModelRegistry
import "./models";

const sm = new StoreManager({ ... });
await sm.bootstrap();
```

The `reflect-metadata` polyfill must be imported once before any decorated class is used. It's a peer dependency of the engine.

## Reactivity Without React

React's observer model (`useSyncExternalStore`, `useEffect`) doesn't exist in Node.js. The engine exposes three callback-based APIs for headless reactivity.

### `objectPool.subscribe` — type-level reactivity

Fires whenever any model of a given type is added, updated, or removed from the pool. This is the primary event loop for an agent reacting to SSE deltas:

```typescript
const unsubscribe = sm.objectPool.subscribe("Issue", () => {
  const issues = sm.objectPool.getAll("Issue");
  // re-evaluate, make decisions, write back
});

unsubscribe(); // call on shutdown
```

The SSE stream delivers a delta → pool updates → subscription fires → agent acts → write queued → server broadcasts → all clients and agents update. No polling.

### `collection.subscribe` — relationship-level reactivity

Fires when a specific lazy collection loads or is invalidated by a delta:

```typescript
const team = sm.objectPool.getById("Team", teamId) as Team;
const unsubscribe = team.issues.subscribe(() => {
  // team.issues.items is now current
});
```

### `model.watch()` — per-property reactivity

Fires only when a specific property (or derived condition) changes on a model you already hold:

```typescript
const issue = sm.objectPool.getById("Issue", id) as Issue;

const unwatch = issue.watch(
  (m) => m.priority,
  (newValue, oldValue) => {
    console.log(`priority: ${oldValue} → ${newValue}`);
  },
);

unwatch(); // call to stop observing
```

The selector can read multiple properties — only the return value is compared:

```typescript
issue.watch(
  (m) => m.status === "done",
  (isDone) => isDone && notifyHuman(),
);
```

Use `model.watch()` on models obtained from the pool (`objectPool.getById` / `objectPool.getAll`). It's powered by MobX observables that are wired at hydration time.

**Boundary**: `watch` tracks changes on a model you already hold. It does not fire when a new model arrives in the pool. For new arrivals, use `objectPool.subscribe`.

## Isolated vs Shared Agent State

### Isolated agents

Each agent creates its own `StoreManager`. Independent working memory. All instances converge via the SSE stream — a write by one agent arrives at every other in real time:

```typescript
const agentA = new StoreManager({ workspaceId, bootstrapFetcher, storageAdapter: new MemoryAdapter(), ... });
const agentB = new StoreManager({ workspaceId, bootstrapFetcher, storageAdapter: new MemoryAdapter(), ... });

await Promise.all([agentA.bootstrap(), agentB.bootstrap()]);
// Both connected, both receiving the same SSE stream
```

Use this for parallel agents working independently on different parts of a problem.

### Shared agents

Multiple agents share one `StoreManager`. Single pool, one SSE connection. Writes from any agent are immediately visible to all others with no server round-trip:

```typescript
const sm = new StoreManager({ ... });
await sm.bootstrap();

// agentA and agentB both operate on the same StoreManager
const agentAView = sm.objectPool.getById("Issue", id);
const agentBView = sm.objectPool.getById("Issue", id);

agentAView === agentBView; // true — same instance
agentAView.title = "Updated by A";
agentBView.title; // "Updated by A" — immediately
```

Use this for tightly-collaborating agents, or for an agent running alongside a UI that needs to see and react to human edits instantly.

## Undo Works for Agent Writes

The undo stack is not React-specific. An agent can undo its own previous action:

```typescript
issue.title = "Changed by agent";
issue.save();

await sm.undo(); // reverts the title — visible to all consumers of the pool
```

A human can also undo what an agent did. This is foundational for human-in-the-loop workflows where trust is being established incrementally.

## Write Flow in Headless Mode

Writes work identically to the browser:

```typescript
// Optimistic — applies locally immediately
issue.title = "Fixed by agent";
issue.save();
// → TransactionQueue batches and POSTs to server
// → Server acknowledges, broadcasts SSE delta
// → All other agents and browser clients update
```

The local update is visible instantly (before the server ACK). If the server rejects the write, the optimistic update is rolled back automatically.

## Teardown

Always call `teardown()` when done to close the SSE connection, flush pending transactions, and release resources:

```typescript
process.on("SIGINT", async () => {
  await sm.teardown();
  process.exit(0);
});
```
