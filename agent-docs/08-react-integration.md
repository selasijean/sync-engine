# React Integration

The sync engine exposes a React API in `react/index.tsx`. The design goal is: components should be able to read models and collections declaratively, re-render automatically when data changes, and never have to think about when or how to refetch.

## SyncProvider

Wrap your app in `SyncProvider`. It creates the `StoreManager`, runs bootstrap, and provides the engine instance to all children via context.

```typescript
<SyncProvider
  config={{
    workspaceId: "workspace-123",
    baseUrl: "/api/sync",
  }}
  fallback={<LoadingScreen />}
>
  <App />
</SyncProvider>
```

- `fallback` renders while bootstrap is in progress (before `Ready` phase)
- Once `Ready`, children render and have full access to the engine
- On unmount, `sm.teardown()` closes the SSE connection and cleans up

## useSyncEngine

```typescript
const { sm, status } = useSyncEngine();
```

Gives you the raw `StoreManager` and current `status`. You won't need `sm` often — the higher-level hooks cover most cases. `status.phase` is useful if you want to show different UI during different bootstrap phases.

## useModels

```typescript
const issues = useModels<Issue>("Issue");
```

Returns all instances of a model type from the pool. Re-renders whenever any instance of that type is created, updated, or deleted.

Internally uses `useSyncExternalStore`:

```typescript
const subscribe = (onStoreChange) => pool.subscribe("Issue", onStoreChange);
const getSnapshot = () => pool.getAll("Issue");
useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
```

This is the correct React 18 pattern for subscribing to an external store. React can detect tearing (inconsistent reads across concurrent renders) with this API.

**Use it when:** you need all instances of a type — e.g., a list of all issues in the sidebar.

**Watch out:** every insert, update, or delete of any Issue causes this hook to compare snapshots. For very large collections with many components using this hook, be mindful — though in practice React's diffing handles it well.

## useModel

```typescript
const issue = useModel<Issue>("Issue", issueId);
```

Returns a single model instance by ID. Returns `null` if not found or not yet loaded.

Uses the same `useSyncExternalStore` mechanism, but the snapshot is just `pool.getById("Issue", issueId)`. Re-renders only when that specific instance changes — but because the pool notifies at the model-type level, this hook re-checks on any Issue change and only re-renders if the returned instance actually differs.

**Use it when:** you're rendering a specific item — an issue detail view, a selected team, etc.

## useCollection

```typescript
const team = useModel<Team>("Team", teamId);
const { items, isLoading, isLoaded, error, reload } = useCollection<Issue>(team?.issues);
```

Wraps a `RefCollection` (from `@ReferenceCollection` / `@LazyReferenceCollection`) or `OwnedRefs` (from `@OwnedCollection` / `@LazyOwnedCollection`). Triggers `.load()` on mount if not already loaded, subscribes to collection invalidation, and re-loads when the collection is invalidated by a delta.

The collection is passed in as an argument (from the model instance), not by name. This means TypeScript knows the element type — `team.issues` is typed as `RefCollection<Issue>`, so `items` is `Issue[]`.

**Use it when:** you want to display a collection that lives on a model instance — team's issues, user's assigned tasks, etc.

## useBackRef

```typescript
const { value: favorite, isLoading } = useBackRef<Favorite>(issue?.favorite);
```

Same pattern as `useCollection`, but for `BackRef` (from `@BackReference`). Returns a single item or null instead of an array.

## useLazyCollection

```typescript
const { items, isLoading, error, reload } = useLazyCollection<Issue>(
  "Issue",
  "teamId",
  teamId,
);
```

The more manual version of `useCollection` — you specify the model name, index key, and value directly instead of going through a model's collection property. Useful when you don't have (or don't want) the parent model instance.

Under the hood it calls `sm.loadCollection("Issue", "teamId", teamId)`, which queries IDB by index and hydrates the results.

**Use it when:** you need a collection but don't have or don't want the parent model — e.g., a route-level component loading issues for a team ID from the URL params.

## useUndoRedo

```typescript
const { undo, redo, canUndo, canRedo } = useUndoRedo();
```

Exposes the undo/redo stack. `canUndo` and `canRedo` are reactive — they update when the stack changes. Useful for toolbar buttons.

```typescript
<button onClick={undo} disabled={!canUndo}>Undo</button>
<button onClick={redo} disabled={!canRedo}>Redo</button>
```

## Reactivity Model

The reactivity chain for a component using `useModels("Issue")`:

```
Delta packet arrives
        │
SyncConnection.processDeltaPacket()
        │
pool.put("Issue", updatedIssue)
        │
pool.notify("Issue")
        │
All pool.subscribe("Issue", ...) callbacks fire
        │
useSyncExternalStore detects callback fired, calls getSnapshot()
        │
React compares new snapshot to previous
  → snapshot changed → re-render
  → snapshot same   → no re-render
```

The `getSnapshot()` for `useModels` returns `pool.getAll("Issue")` — the same array reference if nothing changed, or a new array if anything was added/removed/updated. React uses referential equality on the snapshot to decide whether to re-render.

## Writing Data

Writing doesn't go through a hook — you just mutate model instances and call `save()`:

```typescript
const { sm } = useSyncEngine();

const handleRename = (issue: Issue, newTitle: string) => {
  (issue as any).title = newTitle;
  issue.save();
};

const handleDelete = (issue: Issue) => {
  sm.deleteModel(issue);
};
```

`issue.save()` creates and enqueues an `UpdateTransaction`. The pool is updated optimistically — the component re-renders immediately with the new value before the server round-trip completes. If the server rejects, the transaction reverts and the UI rolls back.

For multi-model atomic operations:

```typescript
sm.batch(() => {
  issue.title = "X";
  issue.save();
  team.name = "Y";
  team.save();
});
// Both changes undo together as one undo step
```

## Phase-Gated Returns

All hooks return empty/null before `status.phase === Ready`. This prevents rendering stale or empty states during bootstrap.

```typescript
return status.phase === Ready ? (models as T[]) : [];
```

The `SyncProvider`'s `fallback` prop handles showing a loading state during bootstrap. Once `Ready`, the fallback is replaced with the app tree, and all hooks return live data.
