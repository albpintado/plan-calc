import { migrateLegacyRecord } from './project.js';

const DB_NAME = 'plan-calc';
const DB_VERSION = 3;
const META_STORE = 'projects';
const DOC_STORE = 'documents';
const FLAG_STORE = 'meta';
const LEGACY_STORE = 'state';
const LEGACY_KEY = 'current';
const LEGACY_FLAG = 'legacyImportedAt';

const MAX_ATTEMPTS = 4;
const RETRY_DELAY_MS = 90;
const OPEN_TIMEOUT_MS = 2500;

let dbPromise = null;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function closeConnection(db) {
  if (!db) return;
  try {
    db.close();
  } catch {
    // Already closing.
  }
}

function resetDb() {
  const current = dbPromise;
  dbPromise = null;
  if (current) current.then(closeConnection).catch(() => {});
}

function openDb() {
  if (dbPromise) return dbPromise;
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const isCurrent = () => dbPromise === promise;
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(DOC_STORE)) {
        db.createObjectStore(DOC_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(FLAG_STORE)) {
        db.createObjectStore(FLAG_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        closeConnection(db);
        return;
      }
      db.onclose = () => {
        if (!isCurrent()) return;
        dbPromise = null;
        closeConnection(db);
      };
      db.onversionchange = () => {
        closeConnection(db);
        if (isCurrent()) dbPromise = null;
      };
      finish(resolve, db);
    };
    request.onerror = () => finish(reject, request.error || new Error('Could not open the database'));
    request.onblocked = () => {
      setTimeout(() => {
        if (settled) return;
        if (isCurrent()) dbPromise = null;
        finish(reject, new Error('The database is blocked by another tab'));
      }, OPEN_TIMEOUT_MS);
    };
  });
  dbPromise = promise;
  promise.catch(() => {
    if (dbPromise === promise) dbPromise = null;
  });
  return promise;
}

function runTransaction(db, stores, mode, run) {
  return new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = db.transaction(stores, mode);
    } catch (error) {
      reject(error);
      return;
    }
    let result;
    try {
      result = run(
        stores.length === 1 ? transaction.objectStore(stores[0]) : transaction,
        transaction,
      );
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () =>
      resolve(result && typeof result.then === 'function' ? result : result);
    transaction.onerror = () => reject(transaction.error || new Error('Transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted'));
  });
}

// WebKit (iOS) drops the IndexedDB connection across reloads and reports it as a
// variety of errors, including NotFoundError. Retry every failure with a fresh
// connection instead of whitelisting error names.
async function withStores(stores, mode, run) {
  let lastError;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const db = await openDb();
      return await runTransaction(db, stores, mode, run);
    } catch (error) {
      lastError = error;
      resetDb();
      await delay(RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastError;
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function closeProjectDb() {
  resetDb();
}

export async function listProjects() {
  const metas = await withStores([META_STORE], 'readonly', (store) => requestValue(store.getAll()));
  return (metas || [])
    .filter((meta) => meta && meta.id && meta.id !== LEGACY_FLAG)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function loadProject(id) {
  const doc = await withStores([DOC_STORE], 'readonly', (store) =>
    requestValue(store.get(id)),
  );
  return doc || null;
}

export async function saveProject(project) {
  const now = Date.now();
  project.updatedAt = now;
  const meta = {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: now,
    hasUnderlay: Boolean(project.underlay),
    thumbnail: project.thumbnail || null,
  };
  await withStores([META_STORE, DOC_STORE], 'readwrite', (transaction) => {
    transaction.objectStore(META_STORE).put(meta);
    transaction.objectStore(DOC_STORE).put(project);
  });
  return meta;
}

export async function deleteProject(id) {
  await withStores([META_STORE, DOC_STORE], 'readwrite', (transaction) => {
    transaction.objectStore(META_STORE).delete(id);
    transaction.objectStore(DOC_STORE).delete(id);
  });
}

async function readLegacyRecord() {
  try {
    return await withStores([LEGACY_STORE], 'readonly', (store) => requestValue(store.get(LEGACY_KEY)));
  } catch {
    return null;
  }
}

async function hasMigrated() {
  try {
    const flag = await withStores([FLAG_STORE], 'readonly', (store) =>
      requestValue(store.get(LEGACY_FLAG)),
    );
    return Boolean(flag);
  } catch {
    return false;
  }
}

async function markMigrated() {
  await withStores([FLAG_STORE], 'readwrite', (store) =>
    store.put({ key: LEGACY_FLAG, at: Date.now() }),
  );
}

// One-shot: turn the pre-platform `current` record into a project.
export async function importLegacyOnce() {
  if (await hasMigrated()) return null;
  const record = await readLegacyRecord();
  if (!record) return null;
  const project = migrateLegacyRecord(record, {
    name: record.name ? `${record.name} (imported)` : 'Imported project',
  });
  await saveProject(project);
  await markMigrated();
  return project;
}
