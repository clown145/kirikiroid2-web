import assert from 'node:assert/strict';

class MemoryStorage {
    data = new Map();
    getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
    setItem(key, value) { this.data.set(key, String(value)); }
    removeItem(key) { this.data.delete(key); }
}

globalThis.localStorage = new MemoryStorage();
globalThis.sessionStorage = new MemoryStorage();

const files = new Map();
const collections = new Set();
let version = 0;

function response(body, init = {}) {
    return new Response(init.status === 204 ? null : body, init);
}

globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    const path = decodeURIComponent(url.pathname);
    const method = options.method || 'GET';
    if (options.headers?.Authorization !== 'Basic dXNlcjpwYXNz') {
        return response('', { status: 401 });
    }
    if (method === 'MKCOL') {
        if (collections.has(path)) return response('', { status: 405 });
        collections.add(path);
        return response('', { status: 201 });
    }
    if (method === 'PUT') {
        const current = files.get(path);
        if (options.headers?.['If-None-Match'] === '*' && current) {
            return response('', { status: 412 });
        }
        if (options.headers?.['If-Match'] && options.headers['If-Match'] !== current?.etag) {
            return response('', { status: 412 });
        }
        const bytes = new Uint8Array(await new Response(options.body).arrayBuffer());
        files.set(path, { bytes, etag: `"${++version}"` });
        return response('', { status: current ? 204 : 201 });
    }
    if (method === 'GET') {
        const item = files.get(path);
        if (!item) return response('', { status: 404 });
        return response(item.bytes, { status: 200, headers: { ETag: item.etag } });
    }
    if (method === 'DELETE') {
        if (!files.delete(path)) return response('', { status: 404 });
        return response('', { status: 204 });
    }
    return response('', { status: 405 });
};

const {
    createWebDavBackend,
    getWebDavConfig,
    saveWebDavConfig,
    testWebDavConnection
} = await import('../src/shared/webdav.js');

const raw = {
    name: '测试 DAV',
    url: 'https://dav.example.test/base',
    username: 'user',
    password: 'pass',
    root: 'apps/Kirikiroid2',
    rememberPassword: false
};

await testWebDavConnection(raw);
assert.equal([...files.keys()].some((key) => key.includes('.krkr2-test-')), false,
    '连接测试应删除临时文件');

const saved = saveWebDavConfig(raw);
assert.equal(JSON.parse(localStorage.getItem('krkr2-webdav-config')).password, undefined,
    '未勾选记住密码时不应持久化密码');
assert.equal(getWebDavConfig().password, 'pass', '会话内仍应可以读取密码');

const backend = createWebDavBackend(saved);
const game = { id: 'game-a', title: '测试游戏' };
const archive = { bytes: new Uint8Array([1, 2, 3]), sha256: 'a'.repeat(64) };
const metadata = {
    contentHash: 'b'.repeat(64),
    fileCount: 2,
    device: { id: 'device-123', name: '测试设备' }
};
const first = await backend.upload(game, archive, metadata, null);
assert.equal(first.parentRevisionId, null);
assert.equal((await backend.list([game])).saves[0].id, first.id);
assert.deepEqual(new Uint8Array(await (await backend.archive(game.id, first)).arrayBuffer()), archive.bytes);

const second = await backend.upload(game, archive, { ...metadata, contentHash: 'c'.repeat(64) }, first.id);
assert.equal(second.parentRevisionId, first.id);
assert.equal((await backend.history(game.id)).length, 2);

const restored = await backend.restore(game, first.id, { id: 'device-456', name: '另一台设备' });
assert.equal(restored.parentRevisionId, second.id);
assert.equal(restored.contentHash, first.contentHash);
assert.equal((await backend.list([game])).saves[0].id, restored.id);

await assert.rejects(
    backend.upload(game, archive, { ...metadata, contentHash: 'd'.repeat(64) }, first.id),
    (err) => err.status === 409 && err.head?.id === restored.id,
    '过期基线必须返回带最新 head 的冲突'
);

console.log('✓ WebDAV 配置、连接、版本链与冲突检测通过');
