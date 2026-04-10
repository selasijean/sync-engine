# Transactions and Undo/Redo

Every user edit goes through the `TransactionQueue` (`core/TransactionQueue.ts`). It's responsible for batching changes, sending them to the server, caching them for offline resilience, and powering undo/redo.

## Transaction Types

Defined in `core/Transaction.ts`. There are four, matching the four write operations:

| Type | Server action | Description |
|---|---|---|
| `CreateTransaction` | `"I"` (Insert) | New model instance created |
| `UpdateTransaction` | `"U"` (Update) | Existing model properties changed |
| `DeleteTransaction` | `"D"` (Delete) | Model permanently deleted |
| `ArchiveTransaction` | `"A"` (Archive) | Model soft-deleted (hidden but retrievable) |

Every transaction records:
- `modelId` and `modelName` — which instance
- `batchId` — groups related transactions for atomic undo
- `state` — current lifecycle stage
- `idbKey` — handle to the cached record in IDB (for crash recovery)
- `syncIdNeededForCompletion` — the server sync ID this transaction is waiting for

`UpdateTransaction` additionally stores a `changes` map:
```typescript
changes: Map<string, { oldValue: unknown; newValue: unknown }>
// "title" → { oldValue: "Old Title", newValue: "New Title" }
// "priority" → { oldValue: 0, newValue: 2 }
```

This is what makes undo possible — each field change has its inverse.

`DeleteTransaction` stores a full `snapshot` of the model at deletion time. Undo restores from this snapshot.

## Transaction Lifecycle

```
User calls issue.save()
        │
        ▼
TransactionQueue.enqueueUpdate()
        │
        ▼
state: Pending
  │ (cached in IDB for crash recovery)
  │ (added to undoStack)
  │ (debounce 50ms)
        │
        ▼
state: Executing  ← HTTP POST batch to server
        │
  ┌─────┴──────────────────┐
  │ server ACK             │ network error / server reject
  ▼                        ▼
state: CompletedButUnsynced    state: Failed (or back to Pending for retry)
  │ (moves to awaitingSync)
  │ (waits for SSE delta with matching syncId)
        │
        ▼
state: Completed  ← SSE delta received, syncId matched
  │ (removed from IDB __transactions)
```

**CompletedButUnsynced** is a deliberate intermediate state. The server has acknowledged the write, but the SSE delta confirming it hasn't arrived yet. The transaction stays in the `awaitingSync` set until the delta comes in, at which point it's fully done.

This two-step completion ensures the client never gets ahead of its own confirmation — if the SSE delta for your edit also triggers collection invalidations or cascade operations, those all run before your transaction is truly complete.

## Batching

`TransactionQueue` debounces flushes by 50ms. This means if you do:

```typescript
issue.title = "A";
issue.priority = 2;
issue.save();
```

...and `save()` creates two `UpdateTransaction`s (one per changed field), they both sit in the `pending` array for 50ms before being sent together as one HTTP request. This reduces network round-trips significantly for operations that change multiple fields rapidly.

## The Batch API for Undo

Individual transactions undo individually. For multi-model operations that should undo atomically, use `batch`:

```typescript
storeManager.batch(() => {
  issue.title = "New Title";
  issue.priority = 2;
  issue.save();

  team.name = "New Team Name";
  team.save();
});

// One undo() call reverts all three changes atomically
```

Internally:

```typescript
beginBatch(): string  // assigns a batchId, starts collecting
endBatch(batchId)    // closes collection, pushes group onto undoStack
```

Every transaction enqueued while a batch is open gets the same `batchId`. They're pushed onto the undo stack as a single `{ kind: "batch", txs: [...] }` entry.

`StoreManager.batch(fn)` wraps any synchronous function in begin/endBatch automatically.

## Undo/Redo

The undo stack is an array of entries, each either `{ kind: "single", tx }` or `{ kind: "batch", txs }`.

### Undo

```typescript
const entry = undoStack.pop();
redoStack.push(entry);

// For each transaction in the entry (reversed order):
//   UpdateTransaction: revert model to oldValue, enqueue inverse update
//   DeleteTransaction: re-create model from snapshot, enqueue create
//   CreateTransaction: delete model, enqueue delete
```

Crucially, `undo()` doesn't just revert the in-memory model — it **enqueues inverse transactions to the server**. The undo is persistent and synced. If you undo a title change, every other client sees the revert via SSE.

The inverse transactions are enqueued with `suppressUndoStack = true` so they don't push onto the undo stack themselves (otherwise undoing would create undoable undos, which breaks the stack invariant).

### Redo

```typescript
const entry = redoStack.pop();
undoStack.push(entry);

// For each transaction in the entry:
//   Re-apply the original change (revert the revert)
//   Enqueue the original transaction values to the server
```

Any new user edit after an undo clears the redo stack — standard undo/redo behavior.

### The `useUndoRedo` Hook

```typescript
const { undo, redo, canUndo, canRedo } = useUndoRedo();
```

`canUndo` and `canRedo` are reactive — components re-render when the stacks change. This is how the Undo/Redo buttons in the demo app enable/disable themselves.

## Offline Resilience

Every `enqueue()` call writes the serialized transaction to IDB's `__transactions` store:

```typescript
tx.idbKey = await db.cacheTransaction(tx.serialize());
```

If the app closes before flushing (tab crash, network drop), the transaction is durable. On next startup, `TransactionQueue` re-reads `__transactions` from IDB and re-queues any non-Completed transactions. They flush to the server once connectivity is restored.

When a transaction completes, it's removed from `__transactions`:

```typescript
await db.removeTransaction(tx.idbKey);
```

## Conflict Handling (Rebase)

If a delta packet arrives from the server for a model you have a pending `UpdateTransaction` for, there's a conflict: the server has a newer baseline than you assumed.

The engine does **last-writer-wins** rebase:

```
Your pending update: title = "My Title" (based on old title "Original")
Server delta arrives: title = "Server Title", priority = 2

Before rebase:
  tx.changes.title = { oldValue: "Original", newValue: "My Title" }

After rebase:
  tx.changes.title = { oldValue: "Server Title", newValue: "My Title" }
  (old value updated to match server's current state)
  
Apply server delta: title → "Server Title", priority → 2
Re-apply your pending: title → "My Title"

Final state: title = "My Title", priority = 2
```

Your title wins. The server's priority change is kept. The undo for your title change now correctly reverts to "Server Title" (not "Original" — that no longer exists).

This rebase happens in `UpdateTransaction.rebase()` and is called by `TransactionQueue.rebaseAll()` whenever a delta packet touches a model with pending changes.
