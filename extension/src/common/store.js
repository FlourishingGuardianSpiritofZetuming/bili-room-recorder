/** 极简 IndexedDB 封装：会话 + 事件。Service Worker 和面板共用同一个库。 */

const DB_NAME = 'bili-voice-recorder';
const DB_VERSION = 1;

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('events')) {
        const st = db.createObjectStore('events', { keyPath: 'pk' });
        st.createIndex('sid', 'sid', { unique: false });
        st.createIndex('sid_seq', ['sid', 'seq'], { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, names, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(names, mode);
    let out;
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
    try {
      out = fn(t);
    } catch (e) {
      reject(e);
    }
  });
}

export async function putSession(session) {
  const db = await openDb();
  await tx(db, ['sessions'], 'readwrite', (t) => t.objectStore('sessions').put(session));
}

export async function getSession(id) {
  const db = await openDb();
  const t = db.transaction('sessions', 'readonly');
  return requestToPromise(t.objectStore('sessions').get(id));
}

function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listSessions() {
  const db = await openDb();
  const t = db.transaction('sessions', 'readonly');
  const all = await requestToPromise(t.objectStore('sessions').getAll());
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

export async function appendEvents(sessionId, events) {
  if (!events.length) return;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const t = db.transaction('events', 'readwrite');
    const st = t.objectStore('events');
    for (const e of events) {
      st.put({ ...e, pk: `${sessionId}|${String(e.seq).padStart(10, '0')}` });
    }
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function getEvents(sessionId) {
  const db = await openDb();
  const t = db.transaction('events', 'readonly');
  const idx = t.objectStore('events').index('sid');
  const all = await requestToPromise(idx.getAll(IDBKeyRange.only(sessionId)));
  return all.sort((a, b) => a.seq - b.seq);
}

export async function getEventsSince(sessionId, afterSeq) {
  const db = await openDb();
  const t = db.transaction('events', 'readonly');
  const idx = t.objectStore('events').index('sid_seq');
  const range = IDBKeyRange.bound([sessionId, afterSeq + 1], [sessionId, Number.MAX_SAFE_INTEGER]);
  const all = await requestToPromise(idx.getAll(range));
  return all.sort((a, b) => a.seq - b.seq);
}

export async function countEvents(sessionId) {
  const db = await openDb();
  const t = db.transaction('events', 'readonly');
  const idx = t.objectStore('events').index('sid');
  return requestToPromise(idx.count(IDBKeyRange.only(sessionId)));
}

export async function deleteSession(sessionId) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const t = db.transaction(['sessions', 'events'], 'readwrite');
    t.objectStore('sessions').delete(sessionId);
    const idx = t.objectStore('events').index('sid');
    const cur = idx.openCursor(IDBKeyRange.only(sessionId));
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) {
        c.delete();
        c.continue();
      }
    };
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

export async function clearAll() {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const t = db.transaction(['sessions', 'events'], 'readwrite');
    t.objectStore('sessions').clear();
    t.objectStore('events').clear();
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}
