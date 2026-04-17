/**
 * ModelRegistry is a singleton that holds metadata for every model class.
 *
 * When decorators like @ClientModel and @Property run at class definition time,
 * they register information here. The rest of the engine reads from this
 * registry to know how to serialize, hydrate, observe, and sync each model.
 *
 * Also computes a schemaHash — a fingerprint of all models and their properties.
 * If the hash changes between sessions, the local IndexedDB needs a migration.
 */

import type { BaseModel } from "./BaseModel";
import { type ModelMeta, type PropertyMeta, LoadStrategy } from "./types";

class ModelRegistryImpl {
  private models = new Map<string, ModelMeta>();
  private cachedHash: string | null = null;

  /** Register a model class. Returns existing metadata if already registered. */
  registerModel(
    name: string,
    ctor: new (...args: unknown[]) => unknown,
  ): ModelMeta {
    if (!this.models.has(name)) {
      this.models.set(name, {
        name,
        loadStrategy: LoadStrategy.Instant,
        usedForPartialIndexes: false,
        properties: new Map(),
        actions: new Set(),
        computedProps: new Set(),
        ctor: ctor as new () => BaseModel,
        schemaVersion: 1,
      });
    }
    this.cachedHash = null; // invalidate hash on any change
    return this.models.get(name)!;
  }

  /** Register a property on a model. */
  registerProperty(modelName: string, prop: PropertyMeta) {
    const meta = this.models.get(modelName);
    if (meta == null) {
      throw new Error(`Model "${modelName}" not registered`);
    }
    meta.properties.set(prop.name, prop);
    this.cachedHash = null;
  }

  /**
   * Merge partial metadata into an already-registered property.
   * Used by @Reference to promote a user-declared @Property to PropertyType.Reference,
   * adding referenceTo / onDelete / nullable without losing indexed / serializer etc.
   */
  updateProperty(
    modelName: string,
    propertyName: string,
    updates: Partial<PropertyMeta>,
  ) {
    const meta = this.models.get(modelName);
    if (meta == null) {
      throw new Error(`Model "${modelName}" not registered`);
    }
    const existing = meta.properties.get(propertyName);
    if (existing == null) {
      throw new Error(
        `Property "${propertyName}" not found on model "${modelName}". ` +
          `Declare it with @Property() before applying @Reference.`,
      );
    }
    meta.properties.set(propertyName, { ...existing, ...updates });
    this.cachedHash = null;
  }

  registerAction(modelName: string, name: string) {
    this.models.get(modelName)?.actions.add(name);
  }

  registerComputed(modelName: string, name: string) {
    this.models.get(modelName)?.computedProps.add(name);
  }

  /** Look up metadata by model name. */
  getModelMeta(name: string): ModelMeta | undefined {
    return this.models.get(name);
  }

  /** Look up metadata from a model instance (reads the class name). */
  getMetaForInstance(instance: object): ModelMeta | undefined {
    const name = (instance.constructor as { _modelName?: string })._modelName;
    return name != null ? this.models.get(name) : undefined;
  }

  /** Get all registered model metadata. */
  allModels(): ModelMeta[] {
    return [...this.models.values()];
  }

  /**
   * A hash of all model names, versions, load strategies, and property metadata.
   * Used to detect when IndexedDB needs a migration.
   */
  get schemaHash(): string {
    if (this.cachedHash != null) {
      return this.cachedHash;
    }

    const sorted = [...this.models.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const parts = sorted.map(([name, meta]) => {
      const props = [...meta.properties.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((prop) =>
          [
            prop.name,
            prop.type,
            `lazy=${prop.lazy === true}`,
            `nullable=${prop.nullable === true}`,
            `indexed=${prop.indexed === true}`,
            `serializer=${prop.serializer != null}`,
            `deserializer=${prop.deserializer != null}`,
            `referenceTo=${prop.referenceTo ?? ""}`,
            `inverseOf=${prop.inverseOf ?? ""}`,
            `idField=${prop.idField ?? ""}`,
            `idsField=${prop.idsField ?? ""}`,
            `onDelete=${prop.onDelete ?? ""}`,
          ].join(";"),
        )
        .join(",");

      return [
        name,
        `version=${meta.schemaVersion}`,
        `loadStrategy=${meta.loadStrategy}`,
        `usedForPartialIndexes=${meta.usedForPartialIndexes}`,
        `props=[${props}]`,
      ].join(":");
    });

    // Simple string hash
    const raw = parts.join("|");
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
      hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
    }
    this.cachedHash = Math.abs(hash).toString(36);
    return this.cachedHash;
  }
}

export const ModelRegistry = new ModelRegistryImpl();
