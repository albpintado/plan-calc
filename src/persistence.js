const DB_NAME = 'plan-calc';
const DB_VERSION = 1;
const STORE = 'state';
const KEY = 'current';
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
    // A stale connection's onclose/onversionchange must not tear down a newer
    // connection, so every handler checks that it still owns dbPromise.
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
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
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
    // A blocked open is temporary: another connection is still closing, so wait.
    // Only give up after a timeout to avoid hanging forever on a stuck peer.
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

function runTransaction(db, mode, run) {
  return new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = db.transaction(STORE, mode);
    } catch (error) {
      reject(error);
      return;
    }
    let request;
    try {
      request = run(transaction.objectStore(STORE));
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => {
      resolve(request && 'result' in request ? request.result : undefined);
    };
    transaction.onerror = () => reject(transaction.error || new Error('Transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted'));
  });
}

// WebKit (all iOS browsers, including Brave) drops the IndexedDB connection
// across reloads and reports it as a variety of errors, including
// NotFoundError ("The object can not be found here"). Retry every failure with
// a fresh connection instead of trying to whitelist transient error names.
async function withStore(mode, run) {
  let lastError;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const db = await openDb();
      return await runTransaction(db, mode, run);
    } catch (error) {
      lastError = error;
      resetDb();
      await delay(RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastError;
}

export async function saveState(state) {
  return withStore('readwrite', (store) => store.put(state, KEY));
}

export async function loadState() {
  const value = await withStore('readonly', (store) => store.get(KEY));
  return value ?? null;
}

export async function clearState() {
  return withStore('readwrite', (store) => store.delete(KEY));
}

export function closeState() {
  resetDb();
}
