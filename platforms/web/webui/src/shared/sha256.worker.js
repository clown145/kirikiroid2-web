import { Sha256Stream } from './sha256.js';

const HASH_CHUNK_SIZE = 4 * 1024 * 1024;
const cancelledJobs = new Set();

function throwIfCancelled(id) {
    if (cancelledJobs.has(id)) throw new DOMException('Hash cancelled', 'AbortError');
}

async function hashFile(id, file) {
    if (file.size <= 64 * 1024 * 1024) {
        const buffer = await file.arrayBuffer();
        throwIfCancelled(id);
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
        throwIfCancelled(id);
        self.postMessage({ type: 'progress', id, loaded: file.size, total: file.size });
        return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }

    const hasher = new Sha256Stream();
    let offset = 0;

    while (offset < file.size) {
        throwIfCancelled(id);
        const end = Math.min(offset + HASH_CHUNK_SIZE, file.size);
        const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
        throwIfCancelled(id);
        hasher.update(bytes);
        offset = end;
        self.postMessage({ type: 'progress', id, loaded: offset, total: file.size });
    }

    throwIfCancelled(id);
    return hasher.digest();
}

self.addEventListener('message', async (event) => {
    const { type, id, file } = event.data || {};
    if (type === 'cancel') {
        cancelledJobs.add(id);
        return;
    }
    if (type !== 'hash' || !id || !file) return;

    try {
        const sha256 = await hashFile(id, file);
        self.postMessage({ type: 'done', id, sha256 });
    } catch (err) {
        self.postMessage({
            type: 'error',
            id,
            name: err?.name || 'Error',
            message: err?.message || 'SHA-256 计算失败'
        });
    } finally {
        cancelledJobs.delete(id);
    }
});
