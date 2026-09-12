const DB_NAME = 'plan-calc';
const DB_VERSION = 1;
const STORE = 'state';
const KEY = 'current';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error('Could not open the database'));
    request.onblocked = () => reject(new Error('The database is blocked by another tab'));
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

async function withStore(mode, run) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = db.transaction(STORE, mode);
    } catch (error) {
      dbPromise = null;
      reject(error);
      return;
    }
    const request = run(transaction.objectStore(STORE));
    transaction.oncomplete = () => {
      resolve(request && 'result' in request ? request.result : undefined);
    };
    transaction.onerror = () => reject(transaction.error || new Error('Transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted'));
  });
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
