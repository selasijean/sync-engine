/// <reference types="vitest/globals" />
import "reflect-metadata";
// Ensures all fixture model classes are defined (decorators run) before any
// test executes. SWC may skip evaluating modules whose exports are unused.
import "./fixtures";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

// Give every test a fresh, isolated IndexedDB.
// Tests that use Database should use crypto.randomUUID() as workspaceId
// so their DB names never collide.
beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).indexedDB = new IDBFactory();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).IDBKeyRange = IDBKeyRange;
});
