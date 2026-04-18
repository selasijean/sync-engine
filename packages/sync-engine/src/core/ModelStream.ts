/**
 * Lightweight SSE connection for secondary services (e.g. a calculation engine).
 * Writes to IDB and upserts into the ObjectPool — no sync state management.
 * Ephemeral models skip IDB and are only held in the pool.
 */

import type { StorageAdapter } from "./Database";
import { ObjectPool } from "./ObjectPool";
import { ModelRegistry } from "./ModelRegistry";
import { BaseSSEConnection, type SSEClientFactory } from "./BaseSSEConnection";
import { LoadStrategy } from "./types";

interface ModelUpdate {
  modelName: string;
  modelId: string;
  data: Record<string, unknown>;
}

export class ModelStream extends BaseSSEConnection {
  private updateQueue: ModelUpdate[] = [];
  private processing = false;

  constructor(
    url: string,
    private database: StorageAdapter,
    private pool: ObjectPool,
    private onStatusChange?: (connected: boolean) => void,
    sseClientFactory?: SSEClientFactory,
  ) {
    super(url, sseClientFactory);
  }

  disconnect() {
    super.disconnect();
    this.updateQueue = [];
    this.processing = false;
  }

  protected onOpen() {
    this.onStatusChange?.(true);
  }

  protected onClose() {
    this.onStatusChange?.(false);
  }

  protected onMessage(data: string): void {
    const update = JSON.parse(data) as ModelUpdate;
    this.enqueue(update);
  }

  private async enqueue(update: ModelUpdate) {
    this.updateQueue.push(update);
    if (this.processing) {
      return;
    }
    this.processing = true;
    while (this.updateQueue.length > 0) {
      await this.applyUpdate(this.updateQueue.shift()!);
    }
    this.processing = false;
  }

  private async applyUpdate(update: ModelUpdate) {
    const { modelName, modelId, data } = update;
    if (data == null) {
      return;
    }

    const modelMeta = ModelRegistry.getModelMeta(modelName);
    if (modelMeta == null) {
      return;
    }

    const record = { id: modelId, ...data };

    if (modelMeta.loadStrategy !== LoadStrategy.Ephemeral) {
      await this.database.writeModels(modelName, [record]);
    }

    const existing = this.pool.getById(modelName, modelId);
    if (existing != null) {
      existing.hydrate(data);
      this.pool.put(modelName, existing);
    }
  }
}
