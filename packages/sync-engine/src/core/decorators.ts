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
import { PropertyType, LoadStrategy } from "./types";

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
    lazy?: boolean;
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
      lazy: opts.lazy,
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
// @Reference — links a user-declared ID field to a virtual model accessor.
//
// The user declares the ID field explicitly with @Property:
//
//   @Property({ indexed: true }) teamId = "";
//   @Reference("Team", { onDelete: "cascade" }) declare team: Team;
//
// @Reference then:
//   1. Promotes `teamId` from PropertyType.Property → PropertyType.Reference,
//      merging in referenceTo / onDelete / nullable.
//   2. Registers `team` as a virtual PropertyType.ReferenceModel (not persisted).
//   3. Defines a getter/setter that links `team` ↔ `teamId`.
//
// The ID field name defaults to `${key}Id` but can be overridden with idField:
//   @Reference("Team", { idField: "parentTeamId" }) declare team: Team;
// ---------------------------------------------------------------------------

export function Reference(
  referenceTo: string,
  opts: {
    nullable?: boolean;
    lazy?: boolean;
    idField?: string;
    onDelete?: "cascade" | "nullify" | "restrict";
  } = {},
) {
  // Legacy decorator target — no better type exists for prototype manipulation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function (target: any, key: string) {
    const modelName = target.constructor.name;
    ensureRegistered(modelName, target.constructor);
    const idKey = opts.idField ?? key + "Id";

    // 1. Promote the user-declared ID field to PropertyType.Reference, adding
    //    reference metadata. Throws if the user forgot to declare it with @Property.
    ModelRegistry.updateProperty(modelName, idKey, {
      type: PropertyType.Reference,
      referenceTo,
      nullable: opts.nullable,
      onDelete: opts.onDelete,
    });

    // 2. Register the virtual model accessor (NOT persisted)
    ModelRegistry.registerProperty(modelName, {
      name: key,
      type: PropertyType.ReferenceModel,
      referenceTo,
      idField: idKey,
    });

    // 3. Define getter/setter that links the model object ↔ its ID
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: false, // not serialized
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      get(this: any) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const id = this[idKey] as any;
        if (id == null || id === "") {
          return null;
        }
        return this.store?.getById?.(referenceTo, id) ?? null;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      set(this: any, model: any) {
        this[idKey] = model != null ? model.id : null;
      },
    });
  };
}

// ---------------------------------------------------------------------------
// @ReferenceCollection — one-to-many from parent side
//
// Registers metadata only. The runtime LazyReferenceCollection object is
// created during BaseModel.makeModelObservable().
//
// The property becomes a LazyReferenceCollection with .items, .load(),
// .isLoaded, .isLoading, .resolveFromPool(), etc.
//
//   const issues = team.issues;          // LazyReferenceCollection
//   const items = issues.resolveFromPool(pool); // sync, from memory
//   await issues.load();                 // async, from IDB
//   issues.items;                        // the loaded models
// ---------------------------------------------------------------------------

export function ReferenceCollection(
  referenceTo: string,
  opts: { lazy?: boolean; inverseOf?: string } = {},
) {
  // Legacy decorator target — no better type exists for prototype manipulation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function (target: any, key: string) {
    const modelName = target.constructor.name;
    ensureRegistered(modelName, target.constructor);

    // Derive the foreign key on the child model.
    // Convention: parentModelName (lowercased first char) + "Id"
    // Override with inverseOf when convention doesn't match.
    const inverseKey =
      opts.inverseOf ??
      modelName.charAt(0).toLowerCase() + modelName.slice(1) + "Id";

    ModelRegistry.registerProperty(modelName, {
      name: key,
      type: PropertyType.ReferenceCollection,
      referenceTo,
      lazy: opts.lazy,
      inverseOf: inverseKey,
    });

    // The getter reads the LazyReferenceCollection stored on __collections[key].
    // Created in makeModelObservable(). Before that, returns undefined.
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: false,
      // Legacy decorator target — no better type exists for prototype manipulation
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      get(this: any) {
        return this.__collections?.[key] ?? null;
      },
    });
  };
}

// ---------------------------------------------------------------------------
// @BackReference — inverse of a Reference
//
// Metadata-only registration. The runtime LazyBackReference is created in
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
      // Legacy decorator target — no better type exists for prototype manipulation
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      get(this: any) {
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
// @OwnedCollection — many-to-many where the parent owns an array of IDs
//
// The parent model stores the IDs array as a @Property; @OwnedCollection
// wraps it with a lazy-loadable collection interface.
//
//   @Property()
//   public issueIds: string[] = [];
//
//   @OwnedCollection("Issue", { idsField: "issueIds" })
//   public issues: LazyOwnedCollection<Issue>;
// ---------------------------------------------------------------------------

export function OwnedCollection(
  referenceTo: string,
  opts: { idsField: string; lazy?: boolean },
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
      lazy: opts.lazy,
    });

    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      get(this: any) {
        return this.__collections?.[key] ?? null;
      },
    });
  };
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
