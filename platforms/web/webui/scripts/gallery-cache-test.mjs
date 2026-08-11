// 画廊页缓存 UI 冒烟测试。
//
// 后端逻辑由 byte-cache-test / downloader-test 覆盖，这里只验证画廊页
// 这一层没接错线：三支 storage 脚本在不加载引擎的页面上也可用、下载入口
// 出现在卡片上、缓存面板打得开。
//
// 需要 wrangler dev（8787）提供 /api/games。

import puppeteer from 'puppeteer-core';

const BASE = 'http://localhost:8787';

let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };

console.log('画廊页缓存 UI');

const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: ['--no-sandbox']
});

try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('requestfailed', (r) => {
        // 引擎产物在纯前端构建里本就不存在，与本测试无关
        if (!/index\.(js|wasm)|build-config\.js|assets\.zip/.test(r.url())) {
            errors.push('请求失败 ' + r.url());
        }
    });

    await page.goto(BASE + '/', { waitUntil: 'networkidle2' });

    // 画廊页不加载引擎，但缓存这套必须可用
    const globals = await page.evaluate(() => ({
        store: !!window.KrKr2CacheStore,
        probe: !!window.KrKr2SourceProbe,
        downloader: !!window.KrKr2Downloader,
        folder: !!window.KrKr2Folder,
        admin: !!window.KrKr2Cache,
        // 引擎相关的东西不该出现在画廊页
        noEngine: !window.KrKr2Engine && !window.VLFS
    }));
    ok(globals.store && globals.probe && globals.downloader &&
        globals.folder && globals.admin, '五支缓存脚本在画廊页可用');
    ok(globals.noEngine, '画廊页仍未加载引擎（保持解耦）');

    // 存储位置：未绑定时应报告 opfs
    const storage = await page.evaluate(() => window.KrKr2Cache.storageInfo());
    ok(storage.kind === 'opfs', `未绑定时用浏览器内部存储（${storage.kind}）`);
    ok(storage.bound === false, '初始状态没有文件夹绑定');

    // 缓存管理面板
    const hasCacheBtn = await page.evaluate(() =>
        [...document.querySelectorAll('.nav-right button')].some((b) => b.textContent.includes('本地缓存')));
    ok(hasCacheBtn, '导航栏有「本地缓存」入口');

    await page.evaluate(() => {
        [...document.querySelectorAll('.nav-right button')]
            .find((b) => b.textContent.includes('本地缓存'))?.click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));

    const panel = await page.evaluate(() => {
        const box = document.querySelector('.modal-box');
        return box ? { text: box.textContent.replace(/\s+/g, ' ').trim() } : null;
    });
    ok(!!panel, '缓存面板能打开');
    ok(!!panel && /还没有缓存任何游戏|已占用/.test(panel.text),
        '面板显示用量或空状态');
    ok(!!panel && /存储位置/.test(panel.text), '面板显示当前存储位置');

    await page.evaluate(() => {
        [...document.querySelectorAll('.modal-actions button')]
            .find((b) => b.textContent.includes('关闭'))?.click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 200)));

    // API 可用时应该有卡片，且带下载入口
    const cards = await page.evaluate(() => {
        const els = [...document.querySelectorAll('.card')];
        return {
            count: els.length,
            withDl: els.filter((e) => e.querySelector('.dl-btn')).length
        };
    });
    if (cards.count > 0) {
        ok(cards.withDl > 0, `卡片上有下载入口（${cards.withDl}/${cards.count}）`);

        // 点下载按钮不能触发导航（整卡是 <a href>）
        const before = page.url();
        await page.evaluate(() => document.querySelector('.dl-btn')?.click());
        await page.evaluate(() => new Promise((r) => setTimeout(r, 600)));
        ok(page.url() === before, '点下载按钮不会跳去玩（prevent + stop 生效）');

        // 支持 FSA 时，首次下载应先问「存哪里」而不是直接开下
        const prompt = await page.evaluate(() => {
            const box = document.querySelector('.modal-box');
            return {
                supported: typeof window.showDirectoryPicker === 'function',
                text: box ? box.textContent.replace(/\s+/g, ' ').trim() : ''
            };
        });
        if (prompt.supported) {
            ok(/把游戏存到哪里/.test(prompt.text), '首次完整下载先引导选择存储位置');
            ok(/可能把它清掉|临时存储/.test(prompt.text), '引导框说明了浏览器存储会被清除');
            // 选「暂不」应该继续下载而不是卡住
            await page.evaluate(() => {
                [...document.querySelectorAll('.modal-actions button')]
                    .find((b) => b.textContent.includes('暂不'))?.click();
            });
            await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));
            const dismissed = await page.evaluate(() => !document.querySelector('.modal-box'));
            ok(dismissed, '选「暂不」后引导框关闭');
        } else {
            console.log('    (无 File System Access，跳过存储位置引导断言)');
        }
        // 收尾：别把下载留着跑，会污染后面的断言与磁盘
        await page.evaluate(() => window.KrKr2Cache.stopDownload());
    } else {
        console.log('    (库里没有条目，跳过卡片相关断言)');
    }

    const realErrors = errors.filter((e) => !/JSPI|WebGL|Web Lock/i.test(e));
    ok(realErrors.length === 0,
        realErrors.length ? '页面异常: ' + realErrors[0].slice(0, 120) : '无页面异常');
} catch (err) {
    console.log('  FAIL  测试执行异常: ' + (err?.message || err));
    failures++;
} finally {
    await browser.close();
}

console.log(failures === 0 ? '\n✓ 全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
