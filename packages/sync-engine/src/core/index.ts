// Types & enums
export * from "./types";

// Model definition
export { ModelRegistry } from "./ModelRegistry";
export { defineObservableProperty } from "./observability";
export {
  ClientModel,
  Property,
  EphemeralProperty,
  Reference,
  ReferenceCollection,
  BackReference,
  ReferenceArray,
  Action,
  Computed,
} from "./decorators";
export { BaseModel } from "./BaseModel";

// Bootstrapping
export { ObjectPool } from "./ObjectPool";
export { Database, BootstrapType } from "./Database";
export type { DatabaseMeta, StorageAdapter } from "./Database";
export { MemoryAdapter } from "./MemoryAdapter";
export { FullStore, PartialStore, ModelStore } from "./Store";
export { StoreManager, RestrictDeleteError } from "./StoreManager";
export type {
  BootstrapResponse,
  BootstrapFetcher,
  SyncGroupFetcher,
  StoreManagerConfig,
} from "./StoreManager";

// Lazy loading
export { LazyReferenceCollection, LazyBackReference, CollectionState } from "./LazyCollection";

// Transactions
export {
  BaseTransaction,
  UpdateTransaction,
  CreateTransaction,
  DeleteTransaction,
  ArchiveTransaction,
} from "./Transaction";
export { TransactionQueue } from "./TransactionQueue";
export type { TransactionSender, BatchResponse } from "./TransactionQueue";

// Sync
export { SyncConnection } from "./SyncConnection";
export type { SyncAction, DeltaPacket } from "./SyncConnection";
