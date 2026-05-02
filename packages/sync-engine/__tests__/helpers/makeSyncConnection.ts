import {
  SyncConnection,
  type DeltaPacket,
  type SSEClientFactory,
  type SyncGroupChangeHandler,
  type SyncMessageTransform,
} from "@sync-engine/SyncConnection";
import type { StorageAdapter } from "@sync-engine/Database";
import type { ObjectPool } from "@sync-engine/ObjectPool";
import type { TransactionQueue } from "@sync-engine/TransactionQueue";

interface MakeSyncConnectionOptions {
  url?: string;
  db: StorageAdapter;
  pool: ObjectPool;
  queue: TransactionQueue;
  onPacket?: (p: DeltaPacket) => void;
  onSyncGroupsChanged?: SyncGroupChangeHandler;
  isCollectionLoaded?: (
    modelName: string,
    indexKey: string,
    value: string,
  ) => boolean;
  sseClientFactory?: SSEClientFactory;
  transform?: SyncMessageTransform;
}

export function makeSyncConnection(
  opts: MakeSyncConnectionOptions,
): SyncConnection {
  return new SyncConnection(
    opts.url ?? "http://localhost/events",
    opts.db,
    opts.pool,
    opts.queue,
    opts.onPacket,
    opts.onSyncGroupsChanged,
    opts.isCollectionLoaded,
    opts.sseClientFactory,
    opts.transform,
  );
}
