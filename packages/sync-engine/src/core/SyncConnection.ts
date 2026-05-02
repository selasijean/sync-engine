/**
 * SyncConnection — WebSocket for receiving delta packets from the server.
 *
 * Delta packet processing (7 steps):
 *   1. Handle sync group changes
 *   4. Apply sync actions → IndexedDB (the ONLY way model tables get updated)
 *   5. Apply sync actions → in-memory ObjectPool + rebase + cascade + invalidate
 *   6. Update lastSyncId
 *   7. Resolve transactions waiting for this syncId
 *
 * Cascade delete (from BackReference metadata):
 *   When a model is deleted, find all BackReferences pointing to it and
 *   remove those "owned" models too. Also handle onDelete: "cascade" on References.
 *
 * Collection invalidation:
 *   When models are inserted, deleted, or moved between parents, the
 *   affected RefCollections are invalidated so they re-query
 *   the pool on next access.
 */

import type { StorageAdapter } from "./Database";
import { ObjectPool } from "./ObjectPool";
import { ModelRegistry } from "./ModelRegistry";
import { TransactionQueue } from "./TransactionQueue";
import { LoadStrategy, PropertyType, type ModelMeta } from "./types";
import {
  BaseSSEConnection,
  type SSEClientFactory,
  type SSEErrorReporter,
} from "./BaseSSEConnection";

// Re-export so existing imports from "@sync-engine/SyncConnection" keep working.
export {
  type SSEClient,
  type SSEClientFactory,
  type SSEErrorReporter,
  createBrowserSSEFactory,
} from "./BaseSSEConnection";

export interface SyncAction {
  modelName: string;
  modelId: string;
  action: "I" | "U" | "D" | "A" | "V" | "C";
  data?: Record<string, unknown>;
}

export interface DeltaPacket {
  syncId: number;
  syncActions: SyncAction[];
  addedSyncGroups?: string[];
  removedSyncGroups?: string[];
}

/**
 * Callback when new sync groups are added. StoreManager uses this to
 * fetch all models scoped to the new groups from the server.
 */
export type SyncGroupChangeHandler = (
  addedGroups: string[],
  removedGroups: string[],
) => Promise<void>;

/**
 * Return null to drop the message. When not provided, raw payloads are
 * assumed to already match `DeltaPacket`.
 */
export type SyncMessageTransform = (
  raw: unknown,
) => DeltaPacket | null | undefined;

export class SyncConnection extends BaseSSEConnection {
  // Serializes packet processing to prevent interleaved async mutations.
  private packetQueue: DeltaPacket[] = [];
  private processing = false;

  constructor(
    url: string,
    private database: StorageAdapter,
    private pool: ObjectPool,
    private queue: TransactionQueue,
    private onPacket?: (p: DeltaPacket) => void,
    private onSyncGroupsChanged?: SyncGroupChangeHandler,
    private isCollectionLoaded?: (
      modelName: string,
      indexKey: string,
      value: string,
    ) => boolean,
    sseClientFactory?: SSEClientFactory,
    private transform?: SyncMessageTransform,
    reportError?: SSEErrorReporter,
  ) {
    super(url, sseClientFactory, reportError);
  }

  protected buildUrl(): string {
    const meta = this.database.currentMeta;
    const lastSyncId = meta?.lastSyncId ?? 0;
    const syncGroups = (meta?.subscribedSyncGroups ?? []).join(",");
    return `${this.url}?lastSyncId=${lastSyncId}&syncGroups=${encodeURIComponent(syncGroups)}`;
  }

  protected onMessage(data: string): void {
    const raw = JSON.parse(data);
    const packet =
      this.transform != null ? this.transform(raw) : (raw as DeltaPacket);
    if (packet == null) {
      return;
    }
    this.enqueuePacket(packet);
  }

  protected onReconnect(): void {
    this.queue.resendCached();
  }

  // =========================================================================
  // Sequential packet processing
  // =========================================================================

  /** Queue a packet and drain sequentially. */
  private async enqueuePacket(packet: DeltaPacket) {
    this.packetQueue.push(packet);
    if (this.processing) {
      return;
    } // already draining
    this.processing = true;
    while (this.packetQueue.length > 0) {
      const next = this.packetQueue.shift()!;
      await this.processDeltaPacket(next);
    }
    this.processing = false;
  }

  // =========================================================================
  // 7-step delta packet processing
  // =========================================================================

  private async processDeltaPacket(packet: DeltaPacket) {
    const meta = this.database.currentMeta;
    if (meta == null) {
      return;
    }

    // Step 1: sync group changes → trigger scoped loading
    let groupsChanged = false;
    if (
      (packet.addedSyncGroups?.length ?? 0) > 0 ||
      (packet.removedSyncGroups?.length ?? 0) > 0
    ) {
      groupsChanged = true;
      const groups = new Set(meta.subscribedSyncGroups);
      for (const g of packet.addedSyncGroups ?? []) {
        groups.add(g);
      }
      for (const g of packet.removedSyncGroups ?? []) {
        groups.delete(g);
      }
      meta.subscribedSyncGroups = [...groups];

      // Fetch models scoped to the new sync groups.
      // e.g. user joined a new team → fetch all Issues/Comments for that team.
      if (this.onSyncGroupsChanged != null) {
        await this.onSyncGroupsChanged(
          packet.addedSyncGroups ?? [],
          packet.removedSyncGroups ?? [],
        );
      }
    }

    // Step 4: apply to IndexedDB (server is SSOT — IDB mirrors it)
    for (const action of packet.syncActions) {
      const actionMeta = ModelRegistry.getModelMeta(action.modelName);
      if (actionMeta?.loadStrategy === LoadStrategy.Ephemeral) {
        continue;
      }
      if (["I", "U", "V", "C"].includes(action.action) && action.data != null) {
        await this.database.writeModels(action.modelName, [
          { id: action.modelId, ...action.data },
        ]);
      } else if (action.action === "D" || action.action === "A") {
        await this.database.deleteModel(action.modelName, action.modelId);
      }
    }

    // Step 5: apply to in-memory + rebase + cascade + invalidate
    for (const action of packet.syncActions) {
      this.applySyncAction(action);
    }

    // Step 6: update lastSyncId
    if (packet.syncId > meta.lastSyncId) {
      meta.lastSyncId = packet.syncId;
    }
    if (groupsChanged) {
      meta.firstSyncId = meta.lastSyncId;
    }
    await this.database.saveMeta(meta);

    // Step 7: resolve transactions
    this.queue.resolveBySync(packet.syncId);

    this.onPacket?.(packet);
  }

  // =========================================================================
  // Apply a single sync action to the in-memory ObjectPool
  // =========================================================================

  private applySyncAction(action: SyncAction) {
    const modelMeta = ModelRegistry.getModelMeta(action.modelName);
    if (modelMeta == null) {
      return;
    }

    switch (action.action) {
      case "I": {
        if (action.data == null) {
          break;
        }
        const existing = this.pool.getById(action.modelName, action.modelId);
        if (existing != null) {
          existing.hydrate(action.data);
          this.pool.put(action.modelName, existing);
        } else if (this.shouldHydrateInsert(modelMeta, action.data)) {
          this.pool.hydrateAndPut(action.modelName, modelMeta, {
            id: action.modelId,
            ...action.data,
          });
        }
        this.queue.rebaseAll(action.modelId, action.modelName, action.data);
        this.invalidateAffectedCollections(action.modelName, action.data);
        break;
      }

      case "U":
      case "V":
      case "C": {
        if (action.data == null) {
          break;
        }
        const model = this.pool.getById(action.modelName, action.modelId);
        if (model != null) {
          // Capture old reference values to detect parent changes
          const oldRefs: Record<string, unknown> = {};
          for (const k of Object.keys(action.data)) {
            if (k !== "id") {
              oldRefs[k] = (model as unknown as Record<string, unknown>)[k];
            }
          }
          model.hydrate(action.data);
          this.pool.put(action.modelName, model);
          this.queue.rebaseAll(action.modelId, action.modelName, action.data);

          // If any reference IDs changed (e.g. issue moved teams),
          // invalidate both old and new parent collections
          this.invalidateOnReferenceChange(
            action.modelName,
            oldRefs,
            action.data,
          );
        }
        break;
      }

      case "D":
      case "A": {
        // Cascade delete: remove BackReference-owned models
        this.cascadeDelete(action.modelName, action.modelId);
        // Invalidate parent collections before removing
        this.invalidateCollectionsForModel(action.modelName, action.modelId);
        // Remove from pool
        this.pool.remove(action.modelName, action.modelId);
        break;
      }
    }
  }

  // =========================================================================
  // On-demand hydration guard
  //
  // For non-Instant models, SSE inserts should only enter the pool if the
  // relevant collection has already been loaded this session. Otherwise the
  // insert is written to IDB (step 4) and will be picked up the next time
  // loadCollection is called for that parent.
  // =========================================================================

  private shouldHydrateInsert(
    modelMeta: ModelMeta,
    data: Record<string, unknown>,
  ): boolean {
    // No checker registered → behave as before (hydrate everything)
    if (this.isCollectionLoaded == null) {
      return true;
    }

    // Instant models always go into the pool — they were bootstrapped in full
    if (modelMeta.loadStrategy === LoadStrategy.Instant) {
      return true;
    }

    // For on-demand models, hydrate only if the parent collection has been loaded
    for (const [propName, propMeta] of modelMeta.properties) {
      if (
        propMeta.type !== PropertyType.Reference ||
        propMeta.referenceTo == null
      ) {
        continue;
      }
      const parentId = data[propName] as string | undefined;
      if (
        parentId != null &&
        this.isCollectionLoaded(modelMeta.name, propName, parentId)
      ) {
        return true;
      }
    }
    return false;
  }

  // =========================================================================
  // Cascade delete
  //
  // Walk all registered models. For each BackReference that points to the
  // deleted model's type, remove instances where the inverse key matches.
  // Also cascade for References with onDelete: "cascade".
  // =========================================================================

  private cascadeDelete(deletedModelName: string, deletedModelId: string) {
    for (const meta of ModelRegistry.allModels()) {
      for (const [, propMeta] of meta.properties) {
        // BackReference cascade: "owned by" the deleted model
        if (
          propMeta.type === PropertyType.BackReference &&
          propMeta.referenceTo === deletedModelName
        ) {
          const inverseKey = propMeta.inverseOf!;
          const toDelete = this.pool
            .getAll(meta.name)
            .filter(
              (m) =>
                (m as unknown as Record<string, unknown>)[inverseKey] ===
                deletedModelId,
            );
          for (const m of toDelete) {
            this.pool.remove(meta.name, m.id);
          }
          if (meta.loadStrategy !== LoadStrategy.Ephemeral) {
            this.database.deleteModels(
              meta.name,
              toDelete.map((m) => m.id),
            ); // fire and forget
          }
        }

        // Reference with onDelete: "cascade"
        if (
          propMeta.type === PropertyType.Reference &&
          propMeta.referenceTo === deletedModelName &&
          propMeta.onDelete === "cascade"
        ) {
          const toDelete = this.pool
            .getAll(meta.name)
            .filter(
              (m) =>
                (m as unknown as Record<string, unknown>)[propMeta.name] ===
                deletedModelId,
            );
          for (const m of toDelete) {
            this.pool.remove(meta.name, m.id);
          }
          if (meta.loadStrategy !== LoadStrategy.Ephemeral) {
            this.database.deleteModels(
              meta.name,
              toDelete.map((m) => m.id),
            ); // fire and forget
          }
        }
      }
    }
  }

  // =========================================================================
  // Collection invalidation
  //
  // Instead of manually adding/removing items from RefCollections,
  // we invalidate the affected ones. On next access, they re-query the pool.
  // The ObjectPool.notify() on put/remove already triggers React re-renders.
  // =========================================================================

  /**
   * After an insert: invalidate collections on the parent model.
   * e.g. new Issue with teamId "t-eng" → invalidate Team("t-eng").issues
   */
  private invalidateAffectedCollections(
    modelName: string,
    data: Record<string, unknown>,
  ) {
    const modelMeta = ModelRegistry.getModelMeta(modelName);
    if (modelMeta == null) {
      return;
    }

    for (const [propName, propMeta] of modelMeta.properties) {
      if (propMeta.type !== PropertyType.Reference) {
        continue;
      }
      if (propMeta.referenceTo == null) {
        continue;
      }

      const parentId = data[propName]; // e.g. data.teamId
      if (parentId == null) {
        continue;
      }

      this.invalidateCollectionsOnParent(
        propMeta.referenceTo,
        parentId as string,
        modelName,
      );
    }
  }

  /**
   * After a reference ID change: invalidate both old and new parent collections.
   * e.g. issue moved from team A to team B → invalidate teamA.issues AND teamB.issues
   */
  private invalidateOnReferenceChange(
    modelName: string,
    oldValues: Record<string, unknown>,
    newValues: Record<string, unknown>,
  ) {
    const modelMeta = ModelRegistry.getModelMeta(modelName);
    if (modelMeta == null) {
      return;
    }

    for (const [propName, propMeta] of modelMeta.properties) {
      if (
        propMeta.type !== PropertyType.Reference ||
        propMeta.referenceTo == null
      ) {
        continue;
      }
      const oldId = oldValues[propName];
      const newId = newValues[propName];
      if (oldId === newId || newId === undefined) {
        continue;
      }

      if (oldId != null) {
        this.invalidateCollectionsOnParent(
          propMeta.referenceTo,
          oldId as string,
          modelName,
        );
      }
      if (newId != null) {
        this.invalidateCollectionsOnParent(
          propMeta.referenceTo,
          newId as string,
          modelName,
        );
      }
    }
  }

  /** Before deleting a model, invalidate its parent's collections. */
  private invalidateCollectionsForModel(modelName: string, modelId: string) {
    const model = this.pool.getById(modelName, modelId);
    if (model == null) {
      return;
    }
    const modelMeta = ModelRegistry.getMetaForInstance(model);
    if (modelMeta == null) {
      return;
    }

    for (const [propName, propMeta] of modelMeta.properties) {
      if (
        propMeta.type !== PropertyType.Reference ||
        propMeta.referenceTo == null
      ) {
        continue;
      }
      const parentId = (model as unknown as Record<string, unknown>)[propName];
      if (parentId != null) {
        this.invalidateCollectionsOnParent(
          propMeta.referenceTo,
          parentId as string,
          modelName,
        );
      }
    }
  }

  /** Find the RefCollections on a parent model and invalidate them. */
  private invalidateCollectionsOnParent(
    parentModelName: string,
    parentId: string,
    childModelName: string,
  ) {
    const parent = this.pool.getById(parentModelName, parentId);
    if (parent == null) {
      return;
    }

    const parentMeta = ModelRegistry.getMetaForInstance(parent);
    if (parentMeta == null) {
      return;
    }

    for (const [propName, propMeta] of parentMeta.properties) {
      if (
        propMeta.type === PropertyType.ReferenceCollection &&
        propMeta.referenceTo === childModelName
      ) {
        const collection =
          (parent as unknown as Record<string, unknown>).__collections != null
            ? (
                parent.__collections as Record<
                  string,
                  { invalidate?: () => void }
                >
              )[propName]
            : undefined;
        if (collection?.invalidate != null) {
          collection.invalidate();
        }
      }
    }
  }
}
