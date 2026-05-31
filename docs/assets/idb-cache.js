// idb-cache.js — stale-while-revalidate cache for the static JSON
// payloads (db.json, lists.json, graph.json) so the graph view can boot
// from already-parsed objects on revisits instead of re-fetching + re-
// parsing every time.
//
// API:
//   const data = await loadCached('graph.json', { onRefresh: (fresh) => {} });
//
// On a cold first load this just fetches + parses + stores. On warm
// revisits it returns the IDB-stored object instantly, then kicks off a
// background fetch and invokes `onRefresh` if the upstream copy changed.

const DB_NAME = 'lev-cache';
const DB_VERSION = 1;
const STORE = 'payloads';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in self)) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function fingerprint(text) {
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-1', buf);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

// Resolve to cached data ASAP, then refresh in the background and call
// `onRefresh(freshData)` if the server copy has changed.
export async function loadCached(url, { onRefresh } = {}) {
  let cachedRecord = null;
  try {
    cachedRecord = await idbGet(url);
  } catch {
    // IDB unavailable (private mode, quota exceeded, etc.) — fall through.
  }

  const networkPromise = (async () => {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
    const text = await res.text();
    const data = JSON.parse(text);
    const hash = await fingerprint(text);
    if (cachedRecord?.hash !== hash) {
      try { await idbPut(url, { hash, data, ts: Date.now() }); } catch {}
      if (cachedRecord && onRefresh) onRefresh(data);
    }
    return data;
  })();

  if (cachedRecord) {
    // Don't await network — let it run in the background.
    networkPromise.catch(() => {});
    return cachedRecord.data;
  }
  return networkPromise;
}

// Wipe cached payloads (useful for debugging). Not wired to a button —
// callable from devtools: `import('./idb-cache.js').then(m => m.clearCache())`.
export async function clearCache() {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {}
}
