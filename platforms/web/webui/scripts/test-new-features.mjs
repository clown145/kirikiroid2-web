import assert from 'node:assert/strict';

class MemoryStorage {
    data = new Map();
    getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
    setItem(key, value) { this.data.set(key, String(value)); }
    removeItem(key) { this.data.delete(key); }
}

globalThis.localStorage = new MemoryStorage();
globalThis.sessionStorage = new MemoryStorage();

// 模拟不支持 ETag 和 If-Match 的兼容型 WebDAV（如坚果云/Alist等常见服务端）
const files = new Map();
const collections = new Set();

globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    const path = decodeURIComponent(url.pathname);
    const method = options.method || 'GET';

    if (method === 'MKCOL') {
        collections.add(path);
        return new Response(null, { status: 201 });
    }
    if (method === 'PUT') {
        const bytes = new Uint8Array(await new Response(options.body).arrayBuffer());
        files.set(path, { bytes });
        // 不返回 ETag，模拟宽松 WebDAV
        return new Response(null, { status: 200 });
    }
    if (method === 'GET') {
        const item = files.get(path);
        if (!item) return new Response(null, { status: 404 });
        return new Response(item.bytes, { status: 200 });
    }
    if (method === 'DELETE') {
        // 递归删除该目录下的文件
        for (const k of files.keys()) {
            if (k === path || k.startsWith(path + '/')) files.delete(k);
        }
        return new Response(null, { status: 204 });
    }
    return new Response('', { status: 405 });
};

const {
    createWebDavBackend,
    saveWebDavConfig,
    testWebDavConnection
} = await import('../src/shared/webdav.js');

const raw = {
    name: '兼容模式 WebDAV',
    url: 'https://dav.example.test/base',
    username: 'user',
    password: 'pass',
    root: 'apps/Kirikiroid2',
    rememberPassword: true
};

const testRes = await testWebDavConnection(raw);
assert.equal(testRes.ok, true, '兼容模式 WebDAV 应当测试通过');
assert.equal(testRes.supportsConditional, false, '应正确识别为不支持条件写入的兼容模式');

const saved = saveWebDavConfig({ ...raw, supportsConditional: testRes.supportsConditional });
const backend = createWebDavBackend(saved);

const game = { id: 'game-relax', title: '测试兼容模式游戏' };
const archive = { bytes: new Uint8Array([1, 2, 3]), sha256: 'a'.repeat(64) };
const metadata = {
    contentHash: 'b'.repeat(64),
    fileCount: 1,
    device: { id: 'device-123', name: '测试设备' }
};

const rev = await backend.upload(game, archive, metadata, null);
assert.equal(rev.gameId, game.id);

const list = await backend.list([game]);
assert.equal(list.saves.length, 1);
assert.equal(list.saves[0].id, rev.id);

// 测试删除远端存档
await backend.delete(game.id);
const listAfterDelete = await backend.list([game]);
assert.equal(listAfterDelete.saves.length, 0, '删除后远端列表应为空');

console.log('✓ WebDAV 兼容模式连接、上传、列表与删除测试全部通过！');
