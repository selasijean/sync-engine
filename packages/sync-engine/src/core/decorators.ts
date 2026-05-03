/**
 * Decorators for defining models and their properties.
 *
 * Usage looks like:
 *
 *   @ClientModel({ loadStrategy: LoadStrategy.Instant })
 *   class Issue extends BaseModel {
 *     @Property() title = "";
 *     @Reference("User", { nullable: true }) assignee: any;
 *     @Action moveToTeam(id: string) { ... }
 *     @Computed get identifier() { ... }
 *   }
 *
 * Each decorator registers metadata in the ModelRegistry at class-definition
 * time. The engine reads that metadata later for serialization, hydration,
 * observability, indexing, and reference resolution.
 */

import { ModelRegistry } from "./ModelRegistry";
import { defineObservableProperty } from "./observability";
import { PropertyType, LoadStrategy, type IObjectPool } from "./types";
import type { LazyCollectionBase, BackRef } from "./LazyCollection";

// `this`-binding shapes used by the runtime accessors below. Kept narrow so
// decorators.ts doesn't need to import BaseModel (which would create a cycle).

interface RefHolder {
  store: IObjectPool | null;
  [key: string]: unknown;
}

interface CollectionHolder {
  __collections?: Record<string, LazyCollectionBase>;
}

interface BackRefHolder {
  __backRefs?: Record<string, BackRef>;
}

// Helper: ensure a model is registered before attaching properties to it.
// Legacy decorator target — no better type exists for prototype manipulation
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ensureRegistered(name: string, ctor: any) {
  if (ModelRegistry.getModelMeta(name) == null) {
    ModelRegistry.registerModel(name, ctor);
  }
}

// ---------------------------------------------------------------------------
// @ClientModel — class decorator
//
// Registers the model name, constructor, and load strategy in the registry.
// ---------------------------------------------------------------------------

export function ClientModel(
  opts: {
    loadStrategy?: LoadStrategy;
    usedForPartialIndexes?: boolean;
    schemaVersion?: number;
  } = {},
) {
  // Legacy decorator target — no better type exists for prototype manipulation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function <T extends new (...args: any[]) => any>(ctor: T) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ctor as any)._modelName = ctor.name;
    const meta = ModelRegistry.registerModel(ctor.name, ctor);
    if (opts.loadStrategy != null) {
      meta.loadStrategy = opts.loadStrategy;
    }
    if (opts.usedForPartialIndexes != null) {
      meta.usedForPartialIndexes = opts.usedForPartialIndexes;
    }
    if (opts.schemaVersion != null) {
      meta.schemaVersion = opts.schemaVersion;
    }
    return ctor;
  };
}

// ---------------------------------------------------------------------------
// @Property — persisted, observable property
// ---------------------------------------------------------------------------

export function Property(
  opts: {
    indexed?: boolean;
    // Legacy decorator target — no better type exists for prototype manipulation
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    serializer?: (v: any) => any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deserializer?: (v: any) => any;
  } = {},
) {
  // Legacy decorator target — no better type exists for prototype manipulation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function (target: any, key: string) {
    ensureRegistered(target.constructor.name, target.constructor);
    ModelRegistry.registerProperty(target.constructor.name, {
      name: key,
      type: PropertyType.Property,
      indexed: opts.indexed,
      serializer: opts.serializer,
      deserializer: opts.deserializer,
    });
    defineObservableProperty(target, key);
  };
}

// ---------------------------------------------------------------------------
// @EphemeralProperty — observable but NOT persisted to IndexedDB
// ---------------------------------------------------------------------------

export function EphemeralProperty() {
  // Legacy decorator target — no better type exists for prototype manipulation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function (target: any, key: string) {
    ensureRegistered(target.constructor.name, target.constructor);
    ModelRegistry.registerProperty(target.constructor.name, {
      name: key,
      type: PropertyType.EphemeralProperty,
    });
    defineObservableProperty(target, key);
  };
}

// ---------------------------------------------------------------------------
// @Reference / @LazyReference — links a user-declared ID field to a virtual
// model accessor.
//
// The user declares the ID field explicitly with @Property:
//
//   @Property({ indexed: true }) teamId = "";
//   @Reference("Team", { onDelete: "cascade" }) declare team: Team;
//
// The decorator:
//   1. Promotes `teamId` from PropertyType.Property → PropertyType.Reference.
//   2. Registers `team` as a virtual PropertyType.ReferenceModel (not persisted).
//   3. Defines a getter/setter that links `team` ↔ `teamId`.
//
// The ID field name defaults to `${key}Id` but can be overridden with idField:
//   @Reference("Team", { idField: "parentTeamId" }) declare team: Team;
//
// `@Reference`     — eager: makeModelObservable() pulls the referenced model
//                    into the pool via storeManager.loadOne so the accessor
//                    doesn't return null on first read.
// `@LazyReference` — lazy: the getter returns whatever is in the pool right
//                    now (or null); no automatic load.
// ---------------------------------------------------------------------------

interface ReferenceOpts {
  nullable?: boolean;
  idField?: string;
  onDelete?: "cascade" | "nullify" | "restrict";
}

function defineReference(
  lazy: boolean,
  referenceTo: string,
  opts: ReferenceOpts,
) {
  // Legacy decorator target — no better type exists for prototype manipulation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function (target: any, key: string) {
    const modelName = target.constructor.name;
    ensureRegistered(modelName, target.constructor);
    const idKey = opts.idField ?? key + "Id";

    ModelRegistry.updateProperty(modelName, idKey, {
      type: PropertyType.Reference,
      referenceTo,
      nullable: opts.nullable,
      onDelete: opts.onDelete,
      lazy,
    });

    ModelRegistry.registerProperty(modelName, {
      name: key,
      type: PropertyType.ReferenceModel,
      referenceTo,
      idField: idKey,
    });

    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: false,
      get(this: RefHolder) {
        const id = this[idKey];
        if (typeof id !== "string" || id === "") {
          return null;
        }
        // Register a tracked dependency on the pool entry so MobX observers
        // re-run when the target is removed or its pool slot is replaced — not
        // just when the FK changes. Closes the gap where a deletion or in-place
        // identity swap would leave observers reading a stale value.
        this.store?.trackModel(referenceTo, id);
        return this.store?.getById(referenceTo, id) ?? null;
      },
      set(this: RefHolder, model: { id: string } | null) {
        this[idKey] = model != null ? model.id : null;
      },
    });
  };
}

export function Reference(referenceTo: string, opts: ReferenceOpts = {}) {
  return defineReference(false, referenceTo, opts);
}

export function LazyReference(referenceTo: string, opts: ReferenceOpts = {}) {
  return defineReference(true, referenceTo, opts);
}

// ---------------------------------------------------------------------------
// @ReferenceCollection / @LazyReferenceCollection — one-to-many from parent side.
//
// Registers metadata only. The runtime `RefCollection` object is created during
// BaseModel.makeModelObservable() and exposes `.items`, `.load()`, `.isLoaded`,
// `.isLoading`, `.resolveFromPool()`, etc.
//
//   const issues = team.issues;              // RefCollection
//   const items = issues.resolveFromPool(pool); // sync, from memory
//   await issues.load();                     // async, from IDB
//   issues.items;                            // the loaded models
//
// `@ReferenceCollection`     — eager: makeModelObservable() fires `.load()` so
//                              children land in the pool alongside the parent.
//                              Recursion is automatic.
// `@LazyReferenceCollection` — lazy: collection stays Idle until something
//                              calls `.load()` or the React hook subscribes.
// ---------------------------------------------------------------------------

interface ReferenceCollectionOpts {
  inverseOf?: string;
}

function defineReferenceCollection(
  lazy: boolean,
  referenceTo: string,
  opts: ReferenceCollectionOpts,
) {
  // Legacy decorator target — no better type exists for prototype manipulation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function (target: any, key: string) {
    const modelName = target.constructor.name;
    ensureRegistered(modelName, target.constructor);

    // Derive the foreign key on the child model. Convention: parentModelName
    // (lowercased first char) + "Id". Override with inverseOf when needed.
    const inverseKey =
      opts.inverseOf ??
      modelName.charAt(0).toLowerCase() + modelName.slice(1) + "Id";

    ModelRegistry.registerProperty(modelName, {
      name: key,
      type: PropertyType.ReferenceCollection,
      referenceTo,
      lazy,
      inverseOf: inverseKey,
    });

    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: false,
      get(this: CollectionHolder) {
        return this.__collections?.[key] ?? null;
      },
    });
  };
}

export function ReferenceCollection(
  referenceTo: string,
  opts: ReferenceCollectionOpts = {},
) {
  return defineReferenceCollection(false, referenceTo, opts);
}

export function LazyReferenceCollection(
  referenceTo: string,
  opts: ReferenceCollectionOpts = {},
) {
  return defineReferenceCollection(true, referenceTo, opts);
}

// ---------------------------------------------------------------------------
// @BackReference — inverse of a Reference
//
// Metadata-only registration. The runtime BackRef is created in
// BaseModel.makeModelObservable().
//
// Key behavior: a BackReference is "owned" by the referenced model.
// When the owning model is deleted, the back-referenced model is also removed.
// This cascade is handled in SyncConnection during delta packet processing.
// ---------------------------------------------------------------------------

export function BackReference(referenceTo: string, inverseOf: string) {
  // Legacy decorator target — no better type exists for prototype manipulation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function (target: any, key: string) {
    ensureRegistered(target.constructor.name, target.constructor);
    ModelRegistry.registerProperty(target.constructor.name, {
      name: key,
      type: PropertyType.BackReference,
      referenceTo,
      inverseOf,
    });

    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: false,
      get(this: BackRefHolder) {
        return this.__backRefs?.[key] ?? null;
      },
    });
  };
}

// ---------------------------------------------------------------------------
// @ReferenceArray — many-to-many stored as array of IDs
// ---------------------------------------------------------------------------

export function ReferenceArray(referenceTo: string) {
  // Legacy decorator target — no better type exists for prototype manipulation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function (target: any, key: string) {
    ensureRegistered(target.constructor.name, target.constructor);
    ModelRegistry.registerProperty(target.constructor.name, {
      name: key,
      type: PropertyType.ReferenceArray,
      referenceTo,
    });
    defineObservableProperty(target, key);
  };
}

// ---------------------------------------------------------------------------
// @OwnedCollection / @LazyOwnedCollection — many-to-many where the parent
// owns an array of IDs.
//
// The parent stores the IDs as a @Property; the decorator wraps that array
// with a runtime `OwnedRefs` collection.
//
//   @Property()
//   public issueIds: string[] = [];
//
//   @OwnedCollection("Issue", { idsField: "issueIds" })
//   public issues: OwnedRefs<Issue>;
//
// `@OwnedCollection`     — eager: makeModelObservable() fires `.load()`.
// `@LazyOwnedCollection` — lazy: collection stays Idle until `.load()` is called.
// ---------------------------------------------------------------------------

interface OwnedCollectionOpts {
  idsField: string;
}

function defineOwnedCollection(
  lazy: boolean,
  referenceTo: string,
  opts: OwnedCollectionOpts,
) {
  // Legacy decorator target — no better type exists for prototype manipulation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function (target: any, key: string) {
    const modelName = target.constructor.name;
    ensureRegistered(modelName, target.constructor);

    ModelRegistry.registerProperty(modelName, {
      name: key,
      type: PropertyType.OwnedCollection,
      referenceTo,
      idsField: opts.idsField,
      lazy,
    });

    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: false,
      get(this: CollectionHolder) {
        return this.__collections?.[key] ?? null;
      },
    });
  };
}

export function OwnedCollection(
  referenceTo: string,
  opts: OwnedCollectionOpts,
) {
  return defineOwnedCollection(false, referenceTo, opts);
}

export function LazyOwnedCollection(
  referenceTo: string,
  opts: OwnedCollectionOpts,
) {
  return defineOwnedCollection(true, referenceTo, opts);
}

// ---------------------------------------------------------------------------
// @Action and @Computed — register method names for MobX wiring
// ---------------------------------------------------------------------------

// Legacy decorator target — no better type exists for prototype manipulation
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function Action(target: any, key: string, _d: PropertyDescriptor) {
  ensureRegistered(target.constructor.name, target.constructor);
  ModelRegistry.registerAction(target.constructor.name, key);
}

// Legacy decorator target — no better type exists for prototype manipulation
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function Computed(target: any, key: string, _d: PropertyDescriptor) {
  ensureRegistered(target.constructor.name, target.constructor);
  ModelRegistry.registerComputed(target.constructor.name, key);
}
