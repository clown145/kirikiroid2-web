// 字节缓存端到端测试。
//
// 验证的是"预加载"这套东西的核心断言：同一段字节只应该走一次网络。
// 因此测的是真实的 vlfs.js + cache-store.js（不复刻逻辑），并用一台
// 自带请求计数的 Range 服务器直接数 HTTP 请求条数 —— 命中率靠计数说话，
// 不靠内部统计字段自证。
//
// 自己拉起 vite dev 与文件服务器，`node scripts/byte-cache-test.mjs` 即可跑。

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const VITE_PORT = 5197;
const FILE_PORT = 5198;
const VITE = `http://localhost:${VITE_PORT}`;
const FILE_URL = `http://localhost:${FILE_PORT}/test.bin`;

const SIZE = 2 * 1024 * 1024;            // 2MiB
const BODY = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) BODY[i] = (i * 7 + 3) & 0xff;

// --- Range 文件服务器（带请求计数） -----------------------------------
let rangeRequests = 0;
let headRequests = 0;

const fileServer = createServer((req, res) => {
    const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Range',
        'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, ETag, X-Content-SHA256',
        // 页面开着 COEP: require-corp，跨源资源不发这个头会被直接拦掉
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Accept-Ranges': 'bytes'
    };

    if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        res.end();
        return;
    }
    if (req.method === 'HEAD') {
        headRequests++;
        res.writeHead(200, {
            ...cors,
            'Content-Length': String(SIZE),
            // 固定强 ETag：缓存指纹应当稳定，跨"会话"仍命中
            'ETag': '"byte-cache-test-v1"'
        });
        res.end();
        return;
    }

    const range = req.headers.range;
    if (range) {
        rangeRequests++;
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        const start = parseInt(m[1], 10);
        const end = m[2] ? parseInt(m[2], 10) : SIZE - 1;
        const slice = BODY.subarray(start, Math.min(end + 1, SIZE));
        res.writeHead(206, {
            ...cors,
            'Content-Range': `bytes ${start}-${start + slice.length - 1}/${SIZE}`,
            'Content-Length': String(slice.length),
            'ETag': '"byte-cache-test-v1"'
        });
        res.end(slice);
        return;
    }

    rangeRequests++;   // 全量 GET 也算一次网络往返
    res.writeHead(200, { ...cors, 'Content-Length': String(SIZE) });
    res.end(BODY);
});

await new Promise((r) => fileServer.listen(FILE_PORT, r));

// --- vite dev ---------------------------------------------------------
const vite = spawn('npx', ['vite', '--port', String(VITE_PORT), '--strictPort'], {
    stdio: 'ignore', detached: false
});

let up = false;
for (let i = 0; i < 40; i++) {
    try {
        const r = await fetch(VITE + '/play.html');
        if (r.ok) { up = true; break; }
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 500));
}
if (!up) {
    vite.kill(); fileServer.close();
    console.error('  vite dev 启动失败');
    process.exit(1);
}

const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox']
});

let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };

console.log('字节缓存');

try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => {
        // play.html 会尝试启动引擎，headless 下的守卫报错与本测试无关
        if (!/KrKr2|JSPI|WebGL|Web Lock/i.test(e.message)) {
            console.log('    ! ' + e.message.slice(0, 140));
        }
    });
    page.on('console', (m) => {
        const t = m.text();
        if (/\[cache\]|\[vlfs\] 字节缓存/.test(t)) console.log('    log: ' + t);
    });

    await page.goto(VITE + '/play.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));

    // 全局对象都在（play.html 的 classic script 已执行）
    const globals = await page.evaluate(() => ({
        rangeSet: typeof window.KrKr2RangeSet === 'function',
        store: !!window.KrKr2CacheStore,
        admin: !!window.KrKr2Cache,
        vlfs: !!window.VLFS
    }));
    ok(globals.rangeSet, 'KrKr2RangeSet 已加载');
    ok(globals.store, 'KrKr2CacheStore 已加载');
    ok(globals.admin, 'KrKr2Cache 已加载');
    ok(globals.vlfs, 'VLFS 已加载');

    // --- 第一轮：冷缓存 ---
    const first = await page.evaluate(async (url, size) => {
        await window.KrKr2Cache.removeAll();          // 从干净状态开始
        await window.VLFS.init();

        const store = await window.KrKr2CacheStore.openOpfs();
        const cache = await store.open('bctest', {
            fingerprint: 'etag-byte-cache-test-v1',
            size, url, name: 'test.bin', title: '字节缓存测试'
        });
        window.__cache = cache;
        window.VLFS.registerRemote('/test.bin', url, size, true, cache);

        // 读三段：起始、中间、尾部
        const spots = [[0, 65536], [1048576, 65536], [size - 65536, 65536]];
        const got = [];
        for (const [pos, len] of spots) {
            const fd = window.VLFS.open('/test.bin', 0);
            window.VLFS.seek(fd, pos, 0);
            const data = await window.VLFS.read(fd, len);
            window.VLFS.close(fd);
            got.push({ pos, len, first: data[0], last: data[data.length - 1], n: data.length });
        }
        await cache.flush();
        return { got, stats: window.VLFS.stats(), bytes: cache.bytes() };
    }, FILE_URL, SIZE);

    const expect = (i) => (i * 7 + 3) & 0xff;
    let contentOk = true;
    for (const g of first.got) {
        if (g.n !== g.len) contentOk = false;
        if (g.first !== expect(g.pos)) contentOk = false;
        if (g.last !== expect(g.pos + g.len - 1)) contentOk = false;
    }
    ok(contentOk, '冷缓存读回的字节内容正确（三段：头/中/尾）');
    ok(first.stats.network > 0, `冷缓存走了网络（network=${first.stats.network}）`);
    ok(first.bytes > 0, `落盘了字节（${first.bytes}）`);

    const afterFirst = rangeRequests;
    ok(afterFirst > 0, `服务器确实收到 Range 请求（${afterFirst} 条）`);

    // --- 第二轮：同一进程内重复读同样区间，应当零新增网络 ---
    const second = await page.evaluate(async (size) => {
        const spots = [[0, 65536], [1048576, 65536], [size - 65536, 65536]];
        const got = [];
        for (const [pos, len] of spots) {
            const fd = window.VLFS.open('/test.bin', 0);
            window.VLFS.seek(fd, pos, 0);
            const data = await window.VLFS.read(fd, len);
            window.VLFS.close(fd);
            got.push({ pos, len, first: data[0], last: data[data.length - 1], n: data.length });
        }
        return { got, stats: window.VLFS.stats() };
    }, SIZE);

    let second_ok = true;
    for (const g of second.got) {
        if (g.n !== g.len) second_ok = false;
        if (g.first !== expect(g.pos)) second_ok = false;
        if (g.last !== expect(g.pos + g.len - 1)) second_ok = false;
    }
    ok(second_ok, '重复读回的字节内容仍然正确');
    ok(rangeRequests === afterFirst,
        `重复读没有新增网络请求（仍为 ${rangeRequests} 条）`);

    // --- 第三轮：模拟刷新页面，缓存必须跨 Document 存活 ---
    const beforeReload = rangeRequests;
    const page2 = await browser.newPage();
    page2.on('console', (m) => {
        const t = m.text();
        if (/\[cache\]|\[vlfs\] 字节缓存/.test(t)) console.log('    log: ' + t);
    });
    await page2.goto(VITE + '/play.html', { waitUntil: 'domcontentloaded' });
    await page2.evaluate(() => new Promise((r) => setTimeout(r, 300)));

    const third = await page2.evaluate(async (url, size) => {
        await window.VLFS.init();
        const store = await window.KrKr2CacheStore.openOpfs();
        const cache = await store.open('bctest', {
            fingerprint: 'etag-byte-cache-test-v1',
            size, url, name: 'test.bin', title: '字节缓存测试'
        });
        const restored = cache.bytes();
        window.VLFS.registerRemote('/test.bin', url, size, true, cache);

        const spots = [[0, 65536], [1048576, 65536], [size - 65536, 65536]];
        const got = [];
        for (const [pos, len] of spots) {
            const fd = window.VLFS.open('/test.bin', 0);
            window.VLFS.seek(fd, pos, 0);
            const data = await window.VLFS.read(fd, len);
            window.VLFS.close(fd);
            got.push({ pos, len, first: data[0], last: data[data.length - 1], n: data.length });
        }
        return { restored, got, stats: window.VLFS.stats() };
    }, FILE_URL, SIZE);

    ok(third.restored > 0, `新 Document 从 meta.json 恢复了区间（${third.restored} 字节）`);

    let third_ok = true;
    for (const g of third.got) {
        if (g.n !== g.len) third_ok = false;
        if (g.first !== expect(g.pos)) third_ok = false;
        if (g.last !== expect(g.pos + g.len - 1)) third_ok = false;
    }
    ok(third_ok, '跨 Document 读回的字节内容正确');
    ok(rangeRequests === beforeReload,
        `跨 Document 命中缓存，零新增网络请求（仍为 ${rangeRequests} 条）`);
    ok(third.stats.cacheHit > 0, `统计里记录了缓存命中（cacheHit=${third.stats.cacheHit}）`);
    ok(third.stats.network === 0, `新 Document 未发起任何 Range（network=${third.stats.network}）`);

    // --- 第四轮：指纹变化必须作废旧字节 ---
    const fourth = await page2.evaluate(async (url, size) => {
        const store = await window.KrKr2CacheStore.openOpfs();
        const cache = await store.open('bctest', {
            fingerprint: 'etag-CHANGED',      // 源换了版本
            size, url, name: 'test.bin', title: '字节缓存测试'
        });
        return { bytes: cache.bytes() };
    }, FILE_URL, SIZE);
    ok(fourth.bytes === 0, '指纹变化后旧缓存被丢弃（bytes 归零）');

    // --- 清理与分游戏删除 ---
    const listed = await page2.evaluate(async () => {
        const list = await window.KrKr2Cache.list();
        const usage = await window.KrKr2Cache.usage();
        return { list, usage };
    });
    ok(listed.list.some((g) => g.gameKey === 'bctest'), '缓存列表里能查到该游戏');
    ok(typeof listed.usage.totalBytes === 'number', 'usage() 汇总可用');

    const removed = await page2.evaluate(async () => {
        await window.KrKr2Cache.remove('bctest');
        return (await window.KrKr2Cache.list()).length;
    });
    ok(removed === 0, '分游戏清理后列表为空');
} catch (err) {
    console.log('  FAIL  测试执行异常: ' + (err?.message || err));
    failures++;
} finally {
    await browser.close();
    vite.kill();
    fileServer.close();
}

console.log(failures === 0 ? '\n✓ 全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
