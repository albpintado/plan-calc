import 'fake-indexeddb/auto';
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { saveState, loadState, clearState, closeState } from '../src/persistence.js';

const DB_NAME = 'plan-calc';
const realIndexedDb = globalThis.indexedDB;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deleteDatabase() {
  closeState();
  await wait(0);
  await new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = resolve;
    request.onerror = resolve;
    request.onblocked = resolve;
  });
}

function failingOpen(error) {
  const request = { error, result: undefined };
  queueMicrotask(() => request.onerror && request.onerror());
  return request;
}

beforeEach(async () => {
  globalThis.indexedDB = realIndexedDb;
  await deleteDatabase();
});

afterEach(() => {
  globalThis.indexedDB = realIndexedDb;
  closeState();
});

test('loadState returns null when nothing has been saved', async () => {
  assert.equal(await loadState(), null);
});

test('saveState round-trips an ArrayBuffer and the page annotations', async () => {
  const bytes = new Uint8Array([1, 2, 3, 250]);
  await saveState({
    version: 1,
    kind: 'pdf',
    name: 'plan.pdf',
    page: 2,
    sourceType: 'application/pdf',
    sourceBuffer: bytes.buffer,
    pages: [[2, { calibration: null, measurements: [{ id: 1 }], areas: [] }]],
  });

  const saved = await loadState();
  assert.equal(saved.kind, 'pdf');
  assert.equal(saved.page, 2);
  assert.equal(saved.sourceType, 'application/pdf');
  assert.deepEqual([...new Uint8Array(saved.sourceBuffer)], [1, 2, 3, 250]);
  assert.equal(saved.pages[0][0], 2);
  assert.equal(saved.pages[0][1].measurements[0].id, 1);
});

test('operations reopen the database after the connection was closed', async () => {
  await saveState({ version: 1, kind: 'image', name: 'a.png', sourceBuffer: new ArrayBuffer(4) });
  closeState();
  const saved = await loadState();
  assert.equal(saved.name, 'a.png');
  assert.equal(saved.sourceBuffer.byteLength, 4);
});

test('clearState removes the saved record', async () => {
  await saveState({ version: 1, kind: 'image', name: 'a.png' });
  await clearState();
  assert.equal(await loadState(), null);
});

test('retries a transient open failure with a fresh connection', async () => {
  let failures = 1;
  globalThis.indexedDB = new Proxy(realIndexedDb, {
    get(target, prop, receiver) {
      if (prop === 'open') {
        return (...args) => {
          if (failures > 0) {
            failures -= 1;
            return failingOpen(new Error('Connection to Indexed Database server lost'));
          }
          return target.open(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  await saveState({ version: 1, kind: 'image', name: 'retried.png' });
  assert.equal(await loadState() !== null, true);
  assert.equal(failures, 0);
});

test('gives up after the retry budget is exhausted', async () => {
  let attempts = 0;
  globalThis.indexedDB = new Proxy(realIndexedDb, {
    get(target, prop, receiver) {
      if (prop === 'open') {
        return (...args) => {
          attempts += 1;
          return failingOpen(new Error('The object can not be found here'));
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  await assert.rejects(() => loadState(), /The object can not be found here/);
  assert.ok(attempts >= 2, `expected multiple attempts, got ${attempts}`);
});
