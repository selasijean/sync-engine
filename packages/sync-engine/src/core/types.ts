import type { BaseModel } from "./BaseModel";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** How a model is loaded into the client during bootstrap. */
export enum LoadStrategy {
  /** Loaded immediately during bootstrap. Most models use this. */
  Instant = "instant",
  /** Not loaded at bootstrap. All instances fetched when first needed. */
  Lazy = "lazy",
  /** Only a subset of instances loaded on demand (e.g. DocumentContent). */
  Partial = "partial",
  /** Only loaded when explicitly requested (e.g. DocumentContentHistory). */
  ExplicitlyRequested = "explicitlyRequested",
  /** Stored only in local IndexedDB. Used for features still in development. */
  Local = "local",
}

/** The kind of data a property holds. Determines how it's stored and observed. */
export enum PropertyType {
  /** A regular persisted property owned by the model (e.g. Issue.title). */
  Property = "property",
  /** Like Property but NOT saved to IndexedDB (e.g. User.lastInteraction). */
  EphemeralProperty = "ephemeralProperty",
  /** A foreign key ID pointing to another model (e.g. Issue.teamId). Persisted and indexed. */
  Reference = "reference",
  /** A virtual getter/setter that resolves a Reference ID to the actual model instance. Not persisted. */
  ReferenceModel = "referenceModel",
  /** A one-to-many relationship from the parent side (e.g. Team.templates). */
  ReferenceCollection = "referenceCollection",
  /** Inverse of a Reference. Deleted when the referenced model is deleted. */
  BackReference = "backReference",
  /** A many-to-many relationship stored as an array of IDs (e.g. Project.memberIds). */
  ReferenceArray = "referenceArray",
  /** A collection where the parent owns an array of IDs (e.g. Team.issueIds → issues). */
  OwnedCollection = "ownedCollection",
}

/** Progress phases during the bootstrap pipeline. Used for loading indicators. */
export enum BootstrapPhase {
  Idle = "idle",
  CreatingStores = "creatingStores",
  ConnectingDatabase = "connectingDatabase",
  DeterminingBootstrapType = "determiningBootstrapType",
  Fetching = "fetching",
  WritingToDatabase = "writingToDatabase",
  Hydrating = "hydrating",
  ConnectingSync = "connectingSync",
  Ready = "ready",
  Error = "error",
}

/** Transaction lifecycle states. */
export enum TransactionState {
  /** Created but not yet sent to the server. */
  Pending = "pending",
  /** Sent to the server, waiting for response. */
  Executing = "executing",
  /** Server acknowledged, but the matching delta packet hasn't arrived yet. */
  CompletedButUnsynced = "completedButUnsynced",
  /** Delta packet received. Fully done. */
  Completed = "completed",
  /** Server rejected the transaction. */
  Failed = "failed",
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Metadata about a single property, stored in the ModelRegistry. */
export interface PropertyMeta {
  name: string;
  type: PropertyType;
  lazy?: boolean;
  nullable?: boolean;
  indexed?: boolean;
  serializer?: (value: unknown) => unknown;
  deserializer?: (value: unknown) => unknown;
  referenceTo?: string; // name of the model this reference points to
  inverseOf?: string; // for BackReference: the property name on the other side
  idField?: string; // for ReferenceModel: the backing ID property name (e.g. "teamId")
  idsField?: string; // for OwnedCollection: the array property holding the IDs (e.g. "issueIds")
  onDelete?: "cascade" | "nullify" | "restrict";
}

/** Metadata about a model class, stored in the ModelRegistry. */
export interface ModelMeta {
  name: string;
  loadStrategy: LoadStrategy;
  usedForPartialIndexes: boolean;
  properties: Map<string, PropertyMeta>;
  actions: Set<string>;
  computedProps: Set<string>;
  ctor: new () => BaseModel;
  schemaVersion: number;
  /**
   * The field that scopes this model to a sync group (e.g. "layerId").
   * Declared via @ClientModel({ syncGroupField: "layerId" }).
   * The engine automatically indexes this field in IDB and uses it
   * to evict records during deactivateSyncGroup().
   */
  syncGroupField?: string;
}

/** Tracks what changed on a property: old value and new value. */
export interface PropertyChange {
  oldValue: unknown;
  newValue: unknown;
}

// ---------------------------------------------------------------------------
// Minimal interfaces used by BaseModel to avoid circular imports
// ---------------------------------------------------------------------------

/** Object pool interface as seen from BaseModel. Avoids importing ObjectPool directly. */
export interface IObjectPool {
  getById(modelName: string, id: string): BaseModel | undefined;
  put(modelName: string, instance: BaseModel): void;
}

/** Store manager interface as seen from BaseModel. Avoids importing StoreManager directly. */
export interface IStoreManager {
  readonly objectPool: IObjectPool;
  commitCreate(model: BaseModel): void;
  commitUpdate(
    modelId: string,
    modelName: string,
    changes: Record<string, PropertyChange>,
  ): void;
  loadCollection(
    modelName: string,
    key: string,
    value: string,
  ): Promise<BaseModel[]>;
  loadByIds(modelName: string, ids: string[]): Promise<BaseModel[]>;
}
