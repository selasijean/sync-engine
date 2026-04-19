# Models and Decorators

Models are defined as TypeScript classes decorated with metadata. That metadata — about which fields exist, what their types are, how they relate to other models — is the engine's schema. It drives everything: IndexedDB table structure, change tracking, relationship resolution, and cascade deletes.

## The ModelRegistry

Every decorator, at class-definition time, writes into a global singleton called `ModelRegistry` (`core/ModelRegistry.ts`). You never interact with it directly; the decorators do it for you.

```
Class definition time
        │
        ▼
  @ClientModel(...)         ─── registers the class, load strategy, schema version
  @Property(...)            ─── registers a persisted, observable field
  @Reference(...)           ─── registers a foreign-key relationship
  @ReferenceCollection(...) ─── registers a one-to-many relationship
  @BackReference(...)       ─── registers an inverse/owned relationship
  @Action(...)              ─── marks a method for MobX batching
  @Computed(...)            ─── marks a getter for MobX memoization
        │
        ▼
  ModelRegistry.models: Map<string, ModelMeta>
```

The `ModelMeta` for each class includes:

```typescript
{
  name: "Issue",
  loadStrategy: LoadStrategy.Instant,
  usedForPartialIndexes: true,
  schemaVersion: 1,
  ctor: Issue,                        // the class constructor
  properties: Map<string, PropertyMeta>,
  actions: Set<string>,
  computedProps: Set<string>,
}
```

A **schemaHash** is computed from all models + versions + property names. This fingerprint is stored in IndexedDB and compared on startup — if it differs, a schema migration runs. See `03-indexeddb-and-persistence.md`.

## Decorators in Detail

### `@ClientModel`

```typescript
@ClientModel({ loadStrategy: LoadStrategy.Instant, usedForPartialIndexes: true })
export class Issue extends BaseModel { ... }
```

Registers the class with the registry. The `loadStrategy` controls when instances are loaded into memory — see `04-lazy-loading.md` for the full breakdown of strategies.

Available strategies: `Instant`, `Lazy`, `Partial`, `ExplicitlyRequested`, and `Ephemeral`. `Ephemeral` models live only in the ObjectPool — they are never written to or read from IDB. They are typically updated via `ModelStream` (secondary SSE connections) and are useful for transient data like live metrics or computation results.

`usedForPartialIndexes: true` means other models can use this model's ID fields as index keys in IndexedDB (used by `LazyReferenceCollection` queries).

### `@Property`

```typescript
@Property({ indexed: true })
public teamId: string | null = null;

@Property({ serializer: dateSerializer, deserializer: dateDeserializer })
public createdAt: Date = new Date();

@Property({ lazy: true })
public content = "";
```

Marks a field as persisted and observable.

- `indexed: true` → IndexedDB creates a secondary index on this field. Enables fast `readModelsByIndex("Issue", "teamId", "team-123")` instead of full table scan.
- `serializer/deserializer` → custom JSON conversion. Dates get stored as ISO strings and deserialized back to `Date` objects on hydration.
- `lazy: true` → field is excluded from the default hydration. Only loaded when explicitly requested (used for large payloads like document content).

### `@EphemeralProperty`

```typescript
@EphemeralProperty()
public lastUserInteraction: Date | null = null;
```

Observable but **never persisted** to IndexedDB and never sent to the server. Lives in memory only. Good for UI state that should be reactive but doesn't belong in the database — hover state, loading flags, etc.

### `@Reference`

```typescript
@Property({ indexed: true })
public teamId: string | null = null;

@Reference("Team", { onDelete: "cascade" })
public team: Team;
```

This is a two-part declaration. You define the raw ID field with `@Property`, and then `@Reference` promotes it into a relationship. At runtime, `issue.team` becomes a virtual getter that calls `objectPool.getById("Team", this.teamId)` — an O(1) lookup with no async required.

The `onDelete` option tells the engine what to do when the referenced model is deleted:

- `"cascade"` — delete this model too (e.g., delete Issue when Team is deleted)
- `"nullify"` — set the ID field to null (e.g., clear `assigneeId` when User is deleted)
- `"restrict"` — throw a `RestrictDeleteError` if any instance still holds this reference (i.e., you must clean up first)

### `@ReferenceArray`

```typescript
@ReferenceArray("Label")
public labelIds: string[] = [];
```

The parent stores an array of IDs directly on itself. The decorator creates a virtual getter `labels` that resolves each ID from the pool. Unlike `@ReferenceCollection`, the IDs live on the parent — not on the children.

### `@ReferenceCollection`

```typescript
@ReferenceCollection("Issue", { lazy: true })
public issues: LazyReferenceCollection<Issue>;
```

One-to-many where the **foreign key lives on the child**. `team.issues` is a `LazyReferenceCollection` that, when loaded, queries all Issues where `teamId === team.id`. The collection is lazy — it doesn't load until you call `.load()` or use the `useCollection` hook.

See `04-lazy-loading.md` for how this works internally.

### `@BackReference`

```typescript
@BackReference("Favorite", "issueId")
public favorite: LazyBackReference;
```

The inverse of a `@Reference`. Means: "find the Favorite record that has `issueId` pointing to me." This is also an ownership relationship — when this Issue is deleted, the engine will cascade-delete the Favorite.

### `@OwnedCollection`

```typescript
@Property()
public memberIds: string[] = [];

@OwnedCollection("User", { idsField: "memberIds" })
public members: LazyOwnedCollection<User>;
```

The parent stores an array of child IDs directly as a `@Property`. The `@OwnedCollection` turns that array into a lazy collection. When the array changes, the collection reflects it on next load.

### `@Action`

```typescript
@Action
moveToTeam(newTeamId: string) {
  this.teamId = newTeamId;
}
```

Wraps the method in a MobX `action()`. This batches all property changes inside the method into a single notification — instead of one re-render per property set, there's one re-render for the entire method call.

### `@Computed`

```typescript
@Computed
get identifier() {
  return `${(this.teamId ?? "").slice(0, 4)}-${this.sortOrder}`;
}
```

Wraps the getter in MobX `computed()`. The value is memoized and only re-evaluated when its tracked dependencies (`teamId`, `sortOrder`) change. Components that read `issue.identifier` only re-render when those fields change — not on every unrelated property change.

## How Hydration Works

When the engine loads a raw record from IndexedDB or a server response, it calls `model.hydrate(data)` on a new or existing instance. Hydration runs the deserializers, sets property values, and resolves references via the pool.

```
Raw JSON from server or IDB:
{ id: "issue-1", title: "Fix bug", teamId: "team-eng", createdAt: "2024-01-15T..." }
        │
        ▼
model.hydrate(data)
        │
  ├─ id, title, teamId set directly
  ├─ createdAt: dateDeserializer("2024-01-15T...") → Date object
  └─ team: virtual getter set up → resolves pool.getById("Team", "team-eng")
        │
        ▼
Pool.put("Issue", model)  →  notify listeners  →  React re-renders
```

The model is observable (via MobX) from this point forward. Any subsequent property change fires reactivity.
