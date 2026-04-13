/**
 * Test model fixtures.
 *
 * Decorators execute at class-definition time and register these models into
 * the global ModelRegistry singleton.  Importing this file is enough — models
 * are only registered once no matter how many test files import it.
 *
 * Relationships used to exercise every delete mode:
 *
 *   TestWorkspace ──< TestProject        cascade  (project deleted when workspace deleted)
 *   TestProject   ──< TestTask           cascade  (task deleted when project deleted)
 *   TestUser      ──< TestTask.assignee  nullify  (assigneeId set to null when user deleted)
 *   TestTask      ──> TestComment        restrict (cannot delete task while comments exist)
 *
 * BackReference cascade (SyncConnection):
 *   TestNote has @BackReference('TestTask', 'taskId')
 *   → when a delta deletes TestTask, TestNotes with taskId === task.id are removed.
 */

import { BaseModel } from "@sync-engine/BaseModel";
import {
  ClientModel,
  Property,
  Reference,
  ReferenceCollection,
  BackReference,
} from "@sync-engine/decorators";
import { LoadStrategy } from "@sync-engine/types";
import type { LazyReferenceCollection } from "@sync-engine/LazyCollection";
const dateSerializer = (v: Date) => (v instanceof Date ? v.toISOString() : v);
const dateDeserializer = (v: unknown) => new Date(v as string);
import type { StoreManager } from "@sync-engine/StoreManager";

/** Hydrate, make observable, and register a model in the given StoreManager's pool. */
export function addToPool(sm: StoreManager, modelName: string, model: BaseModel) {
  model.makeModelObservable();
  sm.objectPool.put(modelName, model);
}

/**
 * Hydrate a model, make it observable, and set a fake store on it —
 * the minimal setup for testing an existing pool model without a real StoreManager.
 */
export function hydrateObservable(
  model: BaseModel,
  data: Record<string, unknown>,
  store: { getById: (...args: unknown[]) => unknown; put: (...args: unknown[]) => void } = {
    getById: () => undefined,
    put: () => {},
  },
) {
  model.hydrate(data);
  model.makeModelObservable();
  model.store = store as Parameters<typeof addToPool>[0]["objectPool"];
}

type FakeStoreManagerOverrides = {
  commitCreate?: (model: BaseModel) => void;
  commitUpdate?: (id: string, name: string, changes: Record<string, unknown>) => void;
};

/**
 * Returns a minimal fake StoreManager suitable for wiring BaseModel.storeManager in tests.
 * Pass overrides to spy on specific methods.
 */
export function makeFakeStoreManager(overrides: FakeStoreManagerOverrides = {}): StoreManager {
  return {
    objectPool: { getById: () => undefined, put: () => {} },
    commitCreate: overrides.commitCreate ?? (() => {}),
    commitUpdate: overrides.commitUpdate ?? (() => {}),
    loadCollection: async () => [],
    loadByIds: async () => [],
  } as unknown as StoreManager;
}

// ── TestWorkspace ─────────────────────────────────────────────────────────────

@ClientModel({ loadStrategy: LoadStrategy.Instant })
export class TestWorkspace extends BaseModel {
  @Property()
  public name = "";
}

// ── TestProject ───────────────────────────────────────────────────────────────

@ClientModel({ loadStrategy: LoadStrategy.Instant })
export class TestProject extends BaseModel {
  @Property()
  public title = "";

  @Property()
  public status = "";

  /** Cascade: deleting the workspace also deletes this project. */
  @Property({ indexed: true })
  public workspaceId = "";

  @Reference("TestWorkspace", { onDelete: "cascade" })
  public workspace: TestWorkspace;

  @ReferenceCollection("TestTask", { inverseOf: "projectId" })
  public tasks: LazyReferenceCollection<TestTask>;
}

// ── TestUser ──────────────────────────────────────────────────────────────────

@ClientModel({ loadStrategy: LoadStrategy.Instant })
export class TestUser extends BaseModel {
  @Property()
  public name = "";

  @Property()
  public email = "";
}

// ── TestTask ──────────────────────────────────────────────────────────────────

@ClientModel({ loadStrategy: LoadStrategy.Instant })
export class TestTask extends BaseModel {
  @Property({ serializer: dateSerializer, deserializer: dateDeserializer })
  public createdAt: Date = new Date();

  @Property({ serializer: dateSerializer, deserializer: dateDeserializer })
  public updatedAt: Date = new Date();

  @Property()
  public title = "";

  @Property()
  public done = false;

  /** Cascade: deleting the project also deletes this task. */
  @Property({ indexed: true })
  public projectId = "";

  @Reference("TestProject", { onDelete: "cascade" })
  public project: TestProject;

  /** Nullify: deleting the user clears this field instead of deleting the task. */
  @Property({ indexed: true })
  public assigneeId: string | null = null;

  @Reference("TestUser", { nullable: true, onDelete: "nullify" })
  public assignee: TestUser | null;
}

// ── TestComment ───────────────────────────────────────────────────────────────

@ClientModel({ loadStrategy: LoadStrategy.Instant })
export class TestComment extends BaseModel {
  @Property()
  public text = "";

  /** Restrict: cannot delete a TestTask while a TestComment references it. */
  @Property({ indexed: true })
  public taskId = "";

  @Reference("TestTask", { onDelete: "restrict" })
  public task: TestTask;
}

// ── TestActivity (on-demand / progressive loading) ────────────────────────────
//
// LoadStrategy.Partial means this model is NOT loaded at bootstrap.
// It is fetched on demand when a collection referencing it is first accessed.

@ClientModel({ loadStrategy: LoadStrategy.Partial })
export class TestActivity extends BaseModel {
  @Property()
  public text = "";

  @Property({ indexed: true })
  public taskId = "";

  @Reference("TestTask")
  public task: TestTask;
}

// ── TestNote (BackReference cascade via SyncConnection) ───────────────────────

@ClientModel({ loadStrategy: LoadStrategy.Instant })
export class TestNote extends BaseModel {
  @Property()
  public content = "";

  @Property({ indexed: true })
  public taskId = "";

  @Reference("TestTask")
  public task: TestTask;

  /**
   * BackReference pointing to TestTask.
   * inverseOf = 'taskId'  → the property on THIS model that holds the task's id.
   *
   * SyncConnection.cascadeDelete uses this: when a TestTask delta arrives with
   * action 'D', it finds TestNotes whose taskId matches and removes them.
   */
  @BackReference("TestTask", "taskId")
  public taskRef: TestTask;
}
