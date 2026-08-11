// 学习型资源清单必须跨页面保留，并在游戏源变化时丢弃。
// 使用真实 Chromium OPFS，而不是复制一套 game-cache 实现。

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';

const PORT = 5200;
const BASE = `http://localhost:${PORT}`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const gameId = `prefetch-cache-test-${Date.now()}`;

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    stdio: 'ignore',
    detached: false
});

let failures = 0;
const check = (condition, label) => {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}`);
    if (!condition) failures++;
};

async function waitForServer() {
    for (let attempt = 0; attempt < 40; attempt++) {
        try {
            const response = await fetch(BASE + '/play.html');
            if (response.ok) return;
        } catch (ignored) {}
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('vite dev 启动失败');
}

let browser;
try {
    await waitForServer();
    browser = await puppeteer.launch({
        executablePath: CHROME,
        headless: 'new',
        args: ['--no-sandbox']
    });
    const page = await browser.newPage();
    await page.goto(BASE + '/play.html', { waitUntil: 'domcontentloaded' });

    const first = await page.evaluate(async (id) => {
        await window.KrKr2GameCache.deleteGame(id).catch(() => {});
        await window.KrKr2GameCache.openSource(id, {
            kind: 'xp3', slot: '/data.xp3', url: 'https://example.invalid/a',
            size: 1, fingerprint: 'etag-a'
        });
        const image = await window.KrKr2GameCache.rememberPrefetchPath(
            id, '/data.xp3>fg/hero.psb');
        const voice = await window.KrKr2GameCache.rememberPrefetchPath(
            id, '/data.xp3>voice/001.ogg');
        const script = await window.KrKr2GameCache.rememberPrefetchPath(
            id, '/data.xp3>scenario/00.ks');
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return {
            image,
            voice,
            script,
            paths: await window.KrKr2GameCache.loadPrefetchManifest(id)
        };
    }, gameId);

    check(first.image === true, '记录立绘路径');
    check(first.voice === true, '记录语音路径');
    check(first.script === false, '不把脚本加入资源清单');
    check(JSON.stringify(first.paths) === JSON.stringify([
        '/data.xp3>voice/001.ogg', '/data.xp3>fg/hero.psb'
    ]), '最近资源优先返回');

    await page.reload({ waitUntil: 'domcontentloaded' });
    const second = await page.evaluate(async (id) => ({
        paths: await window.KrKr2GameCache.loadPrefetchManifest(id)
    }), gameId);
    check(JSON.stringify(second.paths) === JSON.stringify(first.paths),
          '刷新页面后 OPFS 清单仍可复用');

    const changed = await page.evaluate(async (id) => {
        await window.KrKr2GameCache.openSource(id, {
            kind: 'xp3', slot: '/data.xp3', url: 'https://example.invalid/b',
            size: 1, fingerprint: 'etag-b'
        });
        const paths = await window.KrKr2GameCache.loadPrefetchManifest(id);
        await window.KrKr2GameCache.deleteGame(id);
        return paths;
    }, gameId);
    check(changed.length === 0, '源指纹变化会清空学习清单');
} catch (error) {
    console.error('  ! ' + (error?.stack || error));
    failures++;
} finally {
    if (browser) await browser.close();
    vite.kill();
}

console.log(failures ? `\n✗ ${failures} 项问题` : '\n✓ 通过');
process.exit(failures ? 1 : 0);
