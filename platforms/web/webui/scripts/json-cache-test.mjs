// JSON 清单多资源缓存端到端测试。
//
// 先从画廊使用的 KrKr2Cache.download 完整下载，再新开 Document 通过正式
// json-url loader 挂载并读取两个资源。是否命中以测试服务器收到的 Range
// 请求数为准，不使用缓存内部统计自证。

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const VITE_PORT = 5199;
const FILE_PORT = 5200;
const VITE = `http://localhost:${VITE_PORT}`;
const ORIGIN = `http://localhost:${FILE_PORT}`;
const MANIFEST_URL = `${ORIGIN}/manifest.json`;

const resources = new Map();
const xp3 = Buffer.alloc(3 * 1024 * 1024);
const config = Buffer.alloc(768 * 1024);
for (let i = 0; i < xp3.length; i++) xp3[i] = (i * 13 + 5) & 0xff;
for (let i = 0; i < config.length; i++) config[i] = (i * 19 + 11) & 0xff;
resources.set('/data.xp3', xp3);
resources.set('/assets/config.tjs', config);

const manifestBody = Buffer.from(JSON.stringify([
    { name: 'data.xp3', url: './data.xp3', size: xp3.length },
    { name: 'assets/config.tjs', url: './assets/config.tjs', size: config.length, ranges: false }
]));

let manifestGets = 0;
let resourceGets = 0;
let resourceRanges = 0;

function responseHeaders(size, etag) {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Range',
        'Access-Control-Expose-Headers':
            'Content-Range, Accept-Ranges, Content-Length, ETag',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(size),
        'ETag': `"${etag}"`
    };
}

const fileServer = createServer((req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, responseHeaders(0, 'options'));
        res.end();
        return;
    }

    if (req.url === '/manifest.json') {
        const headers = responseHeaders(manifestBody.length, 'json-cache-manifest-v1');
        if (req.method === 'HEAD') {
            res.writeHead(200, headers);
            res.end();
            return;
        }
        manifestGets++;
        res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
        res.end(manifestBody);
        return;
    }

    const body = resources.get(req.url);
    if (!body) {
        res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
        res.end();
        return;
    }
    const headers = responseHeaders(body.length, 'json-cache-' + req.url);
    if (req.method === 'HEAD') {
        res.writeHead(200, headers);
        res.end();
        return;
    }
    const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    resourceGets++;
    if (!match) {
        res.writeHead(200, headers);
        res.end(body);
        return;
    }
    resourceRanges++;
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : body.length - 1;
    const slice = body.subarray(start, Math.min(end + 1, body.length));
    res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${start + slice.length - 1}/${body.length}`,
        'Content-Length': String(slice.length)
    });
    res.end(slice);
});

await new Promise((resolve) => fileServer.listen(FILE_PORT, resolve));

const vite = spawn('npx', ['vite', '--port', String(VITE_PORT), '--strictPort'], {
    stdio: 'ignore', detached: false
});
let up = false;
for (let i = 0; i < 40; i++) {
    try {
        const response = await fetch(VITE + '/play.html');
        if (response.ok) { up = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!up) {
    vite.kill();
    fileServer.close();
    console.error('  vite dev 启动失败');
    process.exit(1);
}

const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox']
});
let failures = 0;
const ok = (condition, message) => {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${message}`);
    if (!condition) failures++;
};

console.log('JSON 多资源缓存');

try {
    const first = await browser.newPage();
    await first.goto(VITE + '/play.html', { waitUntil: 'domcontentloaded' });
    await first.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));

    const downloaded = await first.evaluate(async (url) => {
        await window.KrKr2Cache.removeAll();
        await window.VLFS.init();
        // 模拟上一版 manifest 已经移除的资源，当前下载应清理这个孤儿。
        const store = await window.KrKr2CacheStore.openOpfs();
        const orphan = await store.open('json-cache-test', {
            fingerprint: 'orphan-v1',
            size: 4,
            url: 'https://invalid.example/old.bin',
            name: 'old.bin',
            title: 'JSON 缓存测试',
            resourceKey: 'file:/old.bin'
        });
        await orphan.replace(new Uint8Array([1, 2, 3, 4]));
        await window.KrKr2Cache.download({
            gameKey: 'json-cache-test',
            title: 'JSON 缓存测试',
            url
        });
        for (let i = 0; i < 400; i++) {
            const state = window.KrKr2Cache.downloadState();
            if (state?.done) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const state = window.KrKr2Cache.downloadState();
        const list = await window.KrKr2Cache.list();
        const opfs = await navigator.storage.getDirectory();
        const root = await opfs.getDirectoryHandle('krkr2-cache');
        const openedStore = await window.KrKr2CacheStore.openOpfs();
        const index = await openedStore._loadIndex();
        const game = index.games['json-cache-test'];
        const gameDir = await root.getDirectoryHandle(game.dir);
        const data = await (await gameDir.getFileHandle('data.xp3')).getFile();
        const assets = await gameDir.getDirectoryHandle('assets');
        const config = await (await assets.getFileHandle('config.tjs')).getFile();
        let oldExists = true;
        try { await gameDir.getFileHandle('old.bin'); } catch { oldExists = false; }
        return {
            state, list, index,
            layout: {
                dir: game.dir,
                dataSize: data.size,
                configSize: config.size,
                oldExists,
                paths: Object.values(game.resources).map((r) => r.path).sort()
            }
        };
    }, MANIFEST_URL);

    if (!downloaded.state?.done || !downloaded.list[0]?.complete) {
        console.log('    diag: ' + JSON.stringify(downloaded));
    }

    ok(downloaded.state?.done === true, 'JSON 清单全部资源下载完成');
    ok(downloaded.list.length === 1, '多个资源在缓存列表中聚合为一个游戏');
    ok(downloaded.list[0]?.resources === 3, '聚合项包含 manifest 和两个资源');
    ok(downloaded.list[0]?.complete === true, '聚合完成状态为 true');
    ok(resourceGets === 2, `两个资源各使用一个 GET（实际 ${resourceGets} 条）`);
    ok(resourceRanges === 0, '冷完整下载没有发送 Range 请求');
    ok(manifestGets === 1, 'manifest 本体只 GET 一次');
    ok(downloaded.layout.dir.startsWith('JSON 缓存测试-'),
       `游戏目录使用标题（${downloaded.layout.dir}）`);
    ok(downloaded.layout.dataSize === xp3.length &&
       downloaded.layout.configSize === config.length,
       'JSON 资源按 data.xp3 与 assets/config.tjs 原结构落盘');
    ok(downloaded.layout.oldExists === false, '清单移除的旧资源文件已删除');
    ok(downloaded.layout.paths.includes('data.xp3') &&
       downloaded.layout.paths.includes('assets/config.tjs'),
       '缓存索引记录原始相对路径');

    const beforeGets = resourceGets;
    const beforeManifestGets = manifestGets;
    await first.close();
    const second = await browser.newPage();
    await second.goto(VITE + '/play.html', { waitUntil: 'domcontentloaded' });
    await second.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));

    const replay = await second.evaluate(async (url) => {
        await window.VLFS.init();
        const result = await window.KrKr2Loaders.load({
            type: 'json-url',
            url,
            gameKey: 'json-cache-test',
            title: 'JSON 缓存测试'
        }, {});

        async function sample(path, pos, len) {
            const fd = window.VLFS.open(path, 0);
            window.VLFS.seek(fd, pos, 0);
            const bytes = await window.VLFS.read(fd, len);
            window.VLFS.close(fd);
            return { length: bytes.length, first: bytes[0], last: bytes[bytes.length - 1] };
        }

        return {
            result,
            xp3: await sample('/data.xp3', 2300000, 4096),
            config: await sample('/assets/config.tjs', 500000, 4096),
            stats: window.VLFS.stats()
        };
    }, MANIFEST_URL);

    ok(replay.xp3.first === ((2300000 * 13 + 5) & 0xff) &&
       replay.xp3.last === (((2300000 + 4095) * 13 + 5) & 0xff),
       '跨 Document 从缓存读回 XP3 正确字节');
    ok(replay.config.first === ((500000 * 19 + 11) & 0xff) &&
       replay.config.last === (((500000 + 4095) * 19 + 11) & 0xff),
       '跨 Document 从缓存读回第二个资源正确字节');
    ok(resourceGets === beforeGets, '播放阶段没有新增资源网络请求');
    ok(manifestGets === beforeManifestGets, '播放阶段 manifest 也命中持久缓存');
    ok(replay.stats.cache?.resources === 2 && replay.stats.cache?.done,
       'VLFS 按两个活跃资源聚合缓存状态');
    ok(replay.stats.cacheHit >= 2, 'VLFS 记录到两个持久缓存命中');

    const remaining = await second.evaluate(async () => {
        await window.KrKr2Cache.remove('json-cache-test');
        return await window.KrKr2Cache.list();
    });
    ok(remaining.length === 0, '按游戏清理会删除全部子资源');

    // File System Access 与 OPFS 都实现 FileSystemDirectoryHandle。用一个
    // OPFS 子目录直接喂给 openFolder，验证用户选择目录下的实际布局。
    const folderLayout = await second.evaluate(async () => {
        const opfs = await navigator.storage.getDirectory();
        try { await opfs.removeEntry('folder-backend-test', { recursive: true }); } catch {}
        const picked = await opfs.getDirectoryHandle('folder-backend-test', { create: true });
        const store = await window.KrKr2CacheStore.openFolder(picked);
        const cache = await store.open('folder-game-id', {
            fingerprint: 'folder-v1', size: 4,
            url: 'https://example.invalid/patch/data.xp3',
            name: 'data.xp3', title: '文件夹游戏',
            resourceKey: 'file:/patch/data.xp3',
            resourcePath: '/patch/data.xp3'
        });
        await cache.replace(new Uint8Array([7, 8, 9, 10]));
        const index = await store._loadIndex();
        const game = index.games['folder-game-id'];
        const gameDir = await picked.getDirectoryHandle(game.dir);
        const patchDir = await gameDir.getDirectoryHandle('patch');
        const file = await (await patchDir.getFileHandle('data.xp3')).getFile();
        const bytes = [...new Uint8Array(await file.arrayBuffer())];
        const meta = await picked.getFileHandle('.krkr2-cache.json');
        await store.removeAll();
        await opfs.removeEntry('folder-backend-test', { recursive: true });
        return { dir: game.dir, bytes, hasHiddenIndex: !!meta };
    });
    ok(folderLayout.dir.startsWith('文件夹游戏-'),
       `文件夹后端也按游戏标题建目录（${folderLayout.dir}）`);
    ok(folderLayout.bytes.join(',') === '7,8,9,10',
       '文件夹后端按 patch/data.xp3 原路径写入');
    ok(folderLayout.hasHiddenIndex, '文件夹后端只额外写入隐藏缓存索引');

    // Windows Chromium 禁止网站在用户目录创建 .dll。用包装句柄模拟该拒绝，
    // 验证逻辑路径不变、实体文件自动落到游戏目录内的隐藏保留区。
    const blockedLayout = await second.evaluate(async () => {
        const opfs = await navigator.storage.getDirectory();
        try { await opfs.removeEntry('folder-blocked-test', { recursive: true }); } catch {}
        const picked = await opfs.getDirectoryHandle('folder-blocked-test', { create: true });

        function rejectDll(dir) {
            return {
                kind: 'directory',
                name: dir.name,
                async getDirectoryHandle(name, options) {
                    return rejectDll(await dir.getDirectoryHandle(name, options));
                },
                async getFileHandle(name, options) {
                    if (/\.dll$/i.test(name)) {
                        throw new DOMException('不允许创建此文件类型', 'SecurityError');
                    }
                    return await dir.getFileHandle(name, options);
                },
                async removeEntry(name, options) {
                    return await dir.removeEntry(name, options);
                }
            };
        }

        const store = await window.KrKr2CacheStore.openFolder(rejectDll(picked));
        const cache = await store.open('blocked-game-id', {
            fingerprint: 'blocked-v1', size: 4,
            url: 'https://example.invalid/plugin/layerexyadraw.dll',
            name: 'layerexyadraw.dll', title: 'Windows 文件夹游戏',
            resourceKey: 'file:/plugin/layerexyadraw.dll',
            resourcePath: '/plugin/layerexyadraw.dll'
        });
        await cache.replace(new Uint8Array([11, 12, 13, 14]));
        const index = await store._loadIndex();
        const game = index.games['blocked-game-id'];
        const record = game.resources['file:/plugin/layerexyadraw.dll'];
        const gameDir = await picked.getDirectoryHandle(game.dir);
        const parts = record.storagePath.split('/');
        let dir = gameDir;
        for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
        const file = await (await dir.getFileHandle(parts.at(-1))).getFile();
        const bytes = [...new Uint8Array(await file.arrayBuffer())];
        await store.removeAll();
        await opfs.removeEntry('folder-blocked-test', { recursive: true });
        return { path: record.path, storagePath: record.storagePath, bytes };
    });
    ok(blockedLayout.path === 'plugin/layerexyadraw.dll',
       '受限扩展名仍保留 manifest 逻辑路径');
    ok(blockedLayout.storagePath.startsWith('.krkr2-cache/files/') &&
       blockedLayout.storagePath.endsWith('.bin'),
       `受限扩展名映射到隐藏实体文件（${blockedLayout.storagePath}）`);
    ok(blockedLayout.bytes.join(',') === '11,12,13,14',
       '映射后的实体文件可正常写入和读回');
} catch (error) {
    console.log('  FAIL  测试执行异常: ' + (error?.stack || error));
    failures++;
} finally {
    await browser.close();
    vite.kill();
    fileServer.close();
}

console.log(failures === 0 ? '\n✓ 全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
