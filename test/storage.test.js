import 'fake-indexeddb/auto';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  closeProjectDb,
  deleteProject,
  importLegacyOnce,
  listProjects,
  loadProject,
  saveProject,
} from '../src/storage.js';
import { createProject } from '../src/project.js';

const DB_NAME = 'plan-calc';
const realIndexedDb = globalThis.indexedDB;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deleteDatabase() {
  closeProjectDb();
  await wait(0);
  await new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = resolve;
    request.onerror = resolve;
    request.onblocked = resolve;
  });
}

function seedLegacy(record) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('state', 'readwrite');
      tx.objectStore('state').put(record, 'current');
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
}

beforeEach(async () => {
  globalThis.indexedDB = realIndexedDb;
  await deleteDatabase();
});

test('saveProject / loadProject / listProjects / deleteProject round trip', async () => {
  const project = createProject({ id: 'p1', name: 'Casa' });
  await saveProject(project);
  const loaded = await loadProject('p1');
  assert.equal(loaded.name, 'Casa');
  const list = await listProjects();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'p1');
  assert.equal(list[0].hasUnderlay, false);
  await deleteProject('p1');
  assert.equal(await loadProject('p1'), null);
  assert.equal((await listProjects()).length, 0);
});

test('importLegacyOnce migrates the old current record exactly once', async () => {
  await seedLegacy({
    kind: 'image',
    name: 'viejo.png',
    sourceType: 'image/png',
    sourceBuffer: new ArrayBuffer(8),
    page: 1,
    snapLines: true,
    pages: [
      [1, { calibration: { pxPerMeter: 40 }, measurements: [{ id: 1, a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }], areas: [], walls: [], openings: [] }],
    ],
  });
  const migrated = await importLegacyOnce();
  assert.ok(migrated, 'returns the imported project');
  assert.equal(migrated.underlay.name, 'viejo.png');
  assert.equal(migrated.sheets['1'].measure.measurements.length, 1);

  const list = await listProjects();
  assert.equal(list.length, 1);

  const again = await importLegacyOnce();
  assert.equal(again, null, 'does not import twice');
  assert.equal((await listProjects()).length, 1);
});

test('importLegacyOnce does nothing without legacy data', async () => {
  assert.equal(await importLegacyOnce(), null);
  assert.equal((await listProjects()).length, 0);
});

test('retries a transient open failure with a fresh connection', async () => {
  let failures = 1;
  globalThis.indexedDB = new Proxy(realIndexedDb, {
    get(target, prop, receiver) {
      if (prop === 'open') {
        return (...args) => {
          if (failures > 0) {
            failures -= 1;
            const request = { error: new Error('Connection to Indexed Database server lost') };
            queueMicrotask(() => request.onerror && request.onerror());
            return request;
          }
          return target.open(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const project = createProject({ id: 'retry', name: 'Retry' });
  await saveProject(project);
  const loaded = await loadProject('retry');
  assert.equal(loaded.name, 'Retry');
  assert.equal(failures, 0);
});
