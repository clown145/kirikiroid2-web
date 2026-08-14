const DB_NAME = 'krkr2-hf-upload';
const DB_VERSION = 1;
const SESSION_STORE = 'sessions';
const FILE_STORE = 'files';

function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
    });
}

let dbPromise;

function plainUploadAction(upload) {
    if (!upload) return null;
    return {
        type: upload.type,
        href: upload.href,
        expiresAt: Number(upload.expiresAt) || 0,
        ...(upload.type === 'multipart' ? {
            chunkSize: Number(upload.chunkSize),
            parts: Array.from(upload.parts || [], (part) => ({
                partNumber: Number(part.partNumber),
                url: String(part.url)
            }))
        } : {})
    };
}

export function toStoredUploadFile(state) {
    const result = { ...state };
    if ('upload' in state) result.upload = plainUploadAction(state.upload);
    if ('parts' in state) result.parts = { ...(state.parts || {}) };
    return result;
}

function openDatabase() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            const sessions = db.createObjectStore(SESSION_STORE, { keyPath: 'id' });
            sessions.createIndex('updatedAt', 'updatedAt');
            const files = db.createObjectStore(FILE_STORE, { keyPath: ['sessionId', 'path'] });
            files.createIndex('sessionId', 'sessionId');
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    return dbPromise;
}

export function newUploadSessionId() {
    return crypto.randomUUID();
}

export async function saveUploadSession(session) {
    const db = await openDatabase();
    const tx = db.transaction(SESSION_STORE, 'readwrite');
    tx.objectStore(SESSION_STORE).put({ ...session, updatedAt: Date.now() });
    await transactionDone(tx);
}

export async function patchUploadSession(id, patch) {
    const db = await openDatabase();
    const tx = db.transaction(SESSION_STORE, 'readwrite');
    const store = tx.objectStore(SESSION_STORE);
    const current = await requestResult(store.get(id));
    if (!current) {
        tx.abort();
        throw new Error('上传会话不存在');
    }
    store.put({ ...current, ...patch, id, updatedAt: Date.now() });
    await transactionDone(tx);
}

export async function getUploadSession(id) {
    const db = await openDatabase();
    return requestResult(db.transaction(SESSION_STORE).objectStore(SESSION_STORE).get(id));
}

export async function getLatestUploadSession() {
    const db = await openDatabase();
    const tx = db.transaction(SESSION_STORE);
    const index = tx.objectStore(SESSION_STORE).index('updatedAt');
    return new Promise((resolve, reject) => {
        const request = index.openCursor(null, 'prev');
        request.onsuccess = () => resolve(request.result?.value || null);
        request.onerror = () => reject(request.error);
    });
}

export async function saveUploadFile(state) {
    const db = await openDatabase();
    const tx = db.transaction(FILE_STORE, 'readwrite');
    tx.objectStore(FILE_STORE).put({ ...toStoredUploadFile(state), updatedAt: Date.now() });
    await transactionDone(tx);
}

export async function saveUploadFiles(states) {
    if (!states.length) return;
    const db = await openDatabase();
    const tx = db.transaction(FILE_STORE, 'readwrite');
    const store = tx.objectStore(FILE_STORE);
    const updatedAt = Date.now();
    for (const state of states) store.put({ ...toStoredUploadFile(state), updatedAt });
    await transactionDone(tx);
}

export async function patchUploadFile(sessionId, path, patch) {
    const db = await openDatabase();
    const tx = db.transaction(FILE_STORE, 'readwrite');
    const store = tx.objectStore(FILE_STORE);
    const current = await requestResult(store.get([sessionId, path]));
    store.put(toStoredUploadFile({
        sessionId,
        path,
        ...(current || {}),
        ...patch,
        updatedAt: Date.now()
    }));
    await transactionDone(tx);
}

/** 每个分片完成后单独开启 readwrite 事务，保证并发完成的 ETag 不会互相覆盖。 */
export async function saveCompletedPart(sessionId, path, partNumber, etag) {
    const db = await openDatabase();
    const tx = db.transaction(FILE_STORE, 'readwrite');
    const store = tx.objectStore(FILE_STORE);
    const current = await requestResult(store.get([sessionId, path]));
    if (!current) {
        tx.abort();
        throw new Error('上传文件状态不存在');
    }
    store.put({
        ...current,
        parts: { ...(current.parts || {}), [partNumber]: etag },
        updatedAt: Date.now()
    });
    await transactionDone(tx);
}

export async function listUploadFiles(sessionId) {
    const db = await openDatabase();
    const tx = db.transaction(FILE_STORE);
    return requestResult(tx.objectStore(FILE_STORE).index('sessionId').getAll(sessionId));
}

export async function deleteUploadSession(id) {
    const db = await openDatabase();
    const tx = db.transaction([SESSION_STORE, FILE_STORE], 'readwrite');
    tx.objectStore(SESSION_STORE).delete(id);
    const fileStore = tx.objectStore(FILE_STORE);
    const cursorRequest = fileStore.index('sessionId').openKeyCursor(IDBKeyRange.only(id));
    cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        fileStore.delete(cursor.primaryKey);
        cursor.continue();
    };
    await transactionDone(tx);
}
