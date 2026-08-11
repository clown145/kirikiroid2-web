// 下载器测试。
//
// 验证"边玩边下"真正要求的三件事：
//   1. 能把整个源填满，且不重复下载已有区间（续传不从头再来）
//   2. 引擎在等字节时会让路（预取抢带宽是"开了反而更卡"的根因）
//   3. 停止/恢复不丢已下载的进度
//
// 与 byte-cache-test 一样，用自带计数的 Range 服务器直接数 HTTP 条数。

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const VITE_PORT = 5195;
const FILE_PORT = 5196;
const VITE = `http://localhost:${VITE_PORT}`;
const FILE_URL = `http://localhost:${FILE_PORT}/big.bin`;

// 32MiB / 2MiB 块 = 16 块。够大才停得到"中途"：8MiB 配 6 并发在测试
// 叫停之前就已经下完，续传那一段根本测不到。同时也跨过了 cache-store
// 的 16MiB 提交批次，顺带覆盖分批落盘。
const SIZE = 32 * 1024 * 1024;
const CHUNKS = 16;
const BODY = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) BODY[i] = (i * 31 + 17) & 0xff;

let rangeRequests = 0;
let slowMs = 0;                          // 人为放慢，便于观察并发与让路

const fileServer = createServer(async (req, res) => {
    const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Range',
        'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, ETag',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Accept-Ranges': 'bytes'
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    if (req.method === 'HEAD') {
        res.writeHead(200, { ...cors, 'Content-Length': String(SIZE), 'ETag': '"dl-test-v1"' });
        res.end();
        return;
    }
    if (slowMs) await new Promise((r) => setTimeout(r, slowMs));

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
            'ETag': '"dl-test-v1"'
        });
        res.end(slice);
        return;
    }
    rangeRequests++;
    res.writeHead(200, { ...cors, 'Content-Length': String(SIZE) });
    res.end(BODY);
});

await new Promise((r) => fileServer.listen(FILE_PORT, r));

const vite = spawn('npx', ['vite', '--port', String(VITE_PORT), '--strictPort'], {
    stdio: 'ignore', detached: false
});
let up = false;
for (let i = 0; i < 40; i++) {
    try { const r = await fetch(VITE + '/play.html'); if (r.ok) { up = true; break; } } catch {}
    await new Promise((r) => setTimeout(r, 500));
}
if (!up) { vite.kill(); fileServer.close(); console.error('  vite dev 启动失败'); process.exit(1); }

const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox']
});

let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };

console.log('下载器');

try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => {
        if (!/KrKr2|JSPI|WebGL|Web Lock/i.test(e.message)) {
            console.log('    ! ' + e.message.slice(0, 140));
        }
    });
    page.on('console', (m) => {
        const t = m.text();
        if (/\[downloader\]|\[cache\]/.test(t)) console.log('    log: ' + t);
    });
    await page.goto(VITE + '/play.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));

    ok(await page.evaluate(() => !!window.KrKr2Downloader), 'KrKr2Downloader 已加载');
    ok(await page.evaluate(() => !!window.KrKr2SourceProbe), 'KrKr2SourceProbe 已加载');

    const concurrency = await page.evaluate(() => ({
        full: window.KrKr2Downloader.CONCURRENCY_FULL,
        play: window.KrKr2Downloader.CONCURRENCY_PLAY
    }));
    ok(concurrency.full === 6, `完整下载并发为 6（实际 ${concurrency.full}）`);
    ok(concurrency.play === 3, `边玩边下并发为 3（实际 ${concurrency.play}）`);

    // --- 完整下载：应恰好取满全部块 ---
    await page.evaluate(async () => {
        await window.KrKr2Cache.removeAll();
        await window.VLFS.init();
    });
    rangeRequests = 0;

    const full = await page.evaluate(async (url, size) => {
        await window.KrKr2Cache.download({ gameKey: 'dltest', title: '下载测试', url });
        // 等下载结束（最多 30s）
        for (let i = 0; i < 300; i++) {
            const s = window.KrKr2Cache.downloadState();
            if (s && (s.done || (!s.running && !s.paused))) break;
            await new Promise((r) => setTimeout(r, 100));
        }
        const s = window.KrKr2Cache.downloadState();
        return { state: s, bytes: s ? s.bytes : 0, size };
    }, FILE_URL, SIZE);

    ok(full.state && full.state.done, '完整下载报告完成');
    ok(full.bytes === SIZE, `下满了全部字节（${full.bytes}/${SIZE}）`);
    ok(rangeRequests === CHUNKS,
        `请求数恰为块数，无重复下载（${rangeRequests} 条 / ${CHUNKS} 块）`);

    // 内容正确性：抽查三处
    const verify = await page.evaluate(async (url, size) => {
        const store = await window.KrKr2CacheStore.openOpfs();
        const cache = await store.open('dltest', {
            fingerprint: 'etag-dl-test-v1', size, url, name: 'big.bin', title: '下载测试'
        });
        const spots = [0, 3 * 1024 * 1024, size - 4096];
        const out = [];
        for (const pos of spots) {
            const d = await cache.read(pos, 4096);
            out.push(d ? { pos, first: d[0], last: d[4095] } : null);
        }
        return out;
    }, FILE_URL, SIZE);
    const expect = (i) => (i * 31 + 17) & 0xff;
    ok(verify.every((v, i) => v && v.first === expect(v.pos) &&
        v.last === expect(v.pos + 4095)), '下载内容与源一致（抽查三处）');

    // --- 续传：删掉缓存重来，中途停止再启动 ---
    await page.evaluate(async () => {
        await window.KrKr2Cache.removeAll();
    });
    rangeRequests = 0;
    slowMs = 300;      // 放慢，好在中途叫停

    const resumed = await page.evaluate(async (url) => {
        await window.KrKr2Cache.download({ gameKey: 'dltest', title: '下载测试', url });
        // 按固定时间叫停，不按 bytes 轮询：轮询到"有数据"时往往已经下完了
        await new Promise((r) => setTimeout(r, 500));
        const partial = window.KrKr2Cache.downloadState().bytes;
        window.KrKr2Cache.stopDownload();
        await new Promise((r) => setTimeout(r, 300));
        return { partial };
    }, FILE_URL);

    ok(resumed.partial > 0 && resumed.partial < SIZE,
        `中途停止时已有部分数据（${resumed.partial} 字节）`);
    const afterStop = rangeRequests;
    slowMs = 0;

    const finished = await page.evaluate(async (url, size) => {
        await window.KrKr2Cache.download({ gameKey: 'dltest', title: '下载测试', url });
        for (let i = 0; i < 300; i++) {
            const s = window.KrKr2Cache.downloadState();
            if (s && (s.done || (!s.running && !s.paused))) break;
            await new Promise((r) => setTimeout(r, 100));
        }
        const s = window.KrKr2Cache.downloadState();
        return { bytes: s ? s.bytes : 0, done: s ? s.done : false };
    }, FILE_URL, SIZE);

    ok(finished.done && finished.bytes === SIZE, '续传后下载完成');
    // 允许被 stop() 打断的在途块重下，但不该整份重来
    ok(rangeRequests <= CHUNKS + concurrency.full,
        `续传没有重下已有区间（总请求 ${rangeRequests} ≤ ${CHUNKS + concurrency.full}）`);

    // --- 让路：引擎在等字节时不调度新块 ---
    await page.evaluate(async () => { await window.KrKr2Cache.removeAll(); });
    rangeRequests = 0;
    slowMs = 100;

    const yielded = await page.evaluate(async (url) => {
        // 先把按需读标记按住，再启动下载器
        window.VLFS._demandActive = 1;
        await window.KrKr2Cache.download({ gameKey: 'dltest', title: '下载测试', url });
        const diag = {
            demandActive: window.VLFS._demandActive,
            busy: window.VLFS.demandBusy(500),
            startBytes: window.KrKr2Cache.downloadState().bytes
        };
        await new Promise((r) => setTimeout(r, 1200));
        const during = window.KrKr2Cache.downloadState();
        diag.busyAfterWait = window.VLFS.demandBusy(500);
        diag.demandActiveAfterWait = window.VLFS._demandActive;

        // 放开，等它跑起来
        window.VLFS._demandActive = 0;
        window.VLFS._demandEndedAt = 0;
        await new Promise((r) => setTimeout(r, 1500));
        const after = window.KrKr2Cache.downloadState();
        window.KrKr2Cache.stopDownload();
        return {
            duringBytes: during ? during.bytes : -1,
            afterBytes: after ? after.bytes : -1,
            diag
        };
    }, FILE_URL);
    console.log('    diag: ' + JSON.stringify(yielded.diag));
    ok(yielded.diag.startBytes === 0,
        `让路测试起点是干净的（${yielded.diag.startBytes} 字节）`);
    ok(yielded.diag.busy === true, 'demandBusy() 在按需读进行中为 true');

    ok(yielded.duringBytes === 0,
        `按需读进行中，下载器未取任何数据（${yielded.duringBytes} 字节）`);
    ok(yielded.afterBytes > 0,
        `按需读结束后下载器恢复（${yielded.afterBytes} 字节）`);

    slowMs = 0;
    await page.evaluate(async () => { await window.KrKr2Cache.removeAll(); });
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
