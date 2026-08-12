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
    await page.click('.account-trigger');
    const hasCacheBtn = await page.evaluate(() =>
        [...document.querySelectorAll('.account-menu button')]
            .some((b) => b.textContent.includes('本地缓存')));
    ok(hasCacheBtn, '账号菜单有「本地缓存」入口');

    await page.evaluate(() => {
        [...document.querySelectorAll('.account-menu button')]
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
            ok(/选择游戏下载位置/.test(prompt.text), '首次完整下载先引导选择存储位置');
            ok(/浏览器清理缓存|清除浏览数据/.test(prompt.text),
                '引导框说明了浏览器存储会被清除');
            // 取消本次下载，避免测试访问条目中的外部下载地址。
            await page.evaluate(() => {
                [...document.querySelectorAll('.download-location-actions button')]
                    .find((b) => b.textContent.includes('取消下载'))?.click();
            });
            await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));
            const dismissed = await page.evaluate(() => !document.querySelector('.download-location-dialog'));
            ok(dismissed, '取消后引导框关闭且不开始下载');
        } else {
            console.log('    (无 File System Access，跳过存储位置引导断言)');
        }
        // 收尾：别把下载留着跑，会污染后面的断言与磁盘
        await page.evaluate(() => window.KrKr2Cache.stopDownload());
    } else {
        console.log('    (库里没有条目，跳过卡片相关断言)');
    }

    // 下载位置建议不依赖 D1 中是否已有游戏：用一条内存游戏验证完整交互。
    const locationPage = await browser.newPage();
    await locationPage.setRequestInterception(true);
    locationPage.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname === '/api/games') {
            request.respond({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    games: [{
                        id: 'location-test', title: '下载位置测试', description: '', tags: [],
                        coverUrl: '', downloadUrl: 'https://example.invalid/game.zip'
                    }]
                })
            });
        } else if (url.pathname === '/api/games/location-test') {
            request.respond({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    game: {
                        id: 'location-test', title: '下载位置测试', description: '', tags: [],
                        coverUrl: '', downloadUrl: 'https://example.invalid/game.zip'
                    }
                })
            });
        } else if (url.pathname === '/api/account/me') {
            request.respond({ status: 200, contentType: 'application/json', body: '{"user":null}' });
        } else {
            request.continue();
        }
    });
    await locationPage.evaluateOnNewDocument(() => {
        window.showDirectoryPicker = async () => { throw new DOMException('cancelled', 'AbortError'); };
        let cache;
        window.__downloadStarts = 0;
        Object.defineProperty(window, 'KrKr2Cache', {
            configurable: true,
            get() { return cache; },
            set(value) {
                value.storageInfo = async () => ({
                    kind: 'opfs', name: '', supported: true, bound: false, needsPermission: false
                });
                value.list = async () => [];
                value.usage = async () => ({ bytes: 0, totalBytes: 0, limit: 1024, games: 0 });
                value.downloadState = () => null;
                value.download = async () => { window.__downloadStarts++; };
                value.stopDownload = async () => {};
                cache = value;
            }
        });
    });
    await locationPage.goto(BASE + '/', { waitUntil: 'networkidle2' });
    await locationPage.click('.dl-btn');
    await locationPage.waitForSelector('.download-location-dialog');
    const locationPrompt = await locationPage.$eval('.download-location-dialog', (el) => ({
        text: el.textContent.replace(/\s+/g, ' ').trim(),
        buttons: [...el.querySelectorAll('button')].map((button) => button.textContent.trim()),
        checkbox: !!el.querySelector('input[type="checkbox"]')
    }));
    ok(/选择游戏下载位置/.test(locationPrompt.text) &&
        /浏览器清理缓存|清除浏览数据/.test(locationPrompt.text),
        '完整下载前说明选择文件夹的理由和浏览器存储风险');
    ok(locationPrompt.checkbox && locationPrompt.buttons.includes('取消下载') &&
        locationPrompt.buttons.includes('存浏览器里') && locationPrompt.buttons.includes('选择文件夹'),
        '建议框提供不再显示勾选及三种明确操作');

    await locationPage.click('.download-location-actions .btn-ghost');
    await locationPage.waitForSelector('.download-location-dialog', { hidden: true });
    ok(await locationPage.evaluate(() => window.__downloadStarts === 0),
        '取消建议框不会开始下载');

    await locationPage.click('.dl-btn');
    await locationPage.click('.download-location-choice input');
    await locationPage.evaluate(() => {
        [...document.querySelectorAll('.download-location-actions button')]
            .find((button) => button.textContent.includes('存浏览器里'))?.click();
    });
    await locationPage.waitForSelector('.download-location-dialog', { hidden: true });
    const preference = await locationPage.evaluate(() => ({
        starts: window.__downloadStarts,
        enabled: JSON.parse(localStorage.getItem('krkr2-settings') || '{}').downloadFolderPrompt
    }));
    ok(preference.starts === 1 && preference.enabled === false,
        '勾选后存浏览器里会开始下载并永久关闭建议');

    await locationPage.click('.dl-btn');
    await new Promise((resolve) => setTimeout(resolve, 100));
    ok(await locationPage.$('.download-location-dialog') === null &&
        await locationPage.evaluate(() => window.__downloadStarts === 2),
        '关闭建议后再次完整下载会直接使用浏览器内部存储');

    await locationPage.click('.account-trigger');
    await locationPage.evaluate(() => {
        [...document.querySelectorAll('.account-menu button')]
            .find((button) => button.textContent.includes('本地缓存'))?.click();
    });
    await locationPage.waitForSelector('.cache-prompt-reset');
    await locationPage.click('.cache-prompt-reset');
    ok(await locationPage.evaluate(() =>
        JSON.parse(localStorage.getItem('krkr2-settings') || '{}').downloadFolderPrompt === true),
        '本地缓存面板可以重新开启下载位置提示');
    await new Promise((resolve) => setTimeout(resolve, 100));
    ok(await locationPage.$('.cache-prompt-reset') === null,
        '重新开启后缓存面板立即更新');

    await locationPage.goto(BASE + '/game/location-test', { waitUntil: 'networkidle2' });
    await locationPage.click('.detail-download');
    await locationPage.waitForSelector('.download-location-dialog');
    ok(true, '游戏详情的完整下载使用同一份位置建议');

    await locationPage.evaluate(() => {
        const settings = JSON.parse(localStorage.getItem('krkr2-settings') || '{}');
        settings.downloadFolderPrompt = false;
        localStorage.setItem('krkr2-settings', JSON.stringify(settings));
    });
    await locationPage.goto(BASE + '/settings', { waitUntil: 'networkidle2' });
    const promptSetting = await locationPage.evaluate(() => {
        const row = [...document.querySelectorAll('.setting-row')]
            .find((element) => element.textContent.includes('完整下载前建议选择文件夹'));
        return row ? { found: true, checked: row.querySelector('input')?.checked } : { found: false };
    });
    ok(promptSetting.found && promptSetting.checked === false,
        '设置页提供下载位置建议开关并反映关闭状态');
    await locationPage.close();

    // 已绑定但失权时，存储边界必须拒绝写入，不能静默回退到 OPFS。
    const permissionBoundary = await page.evaluate(async () => {
        const folder = window.KrKr2Folder;
        const originalHasBinding = folder.hasBinding;
        const originalTryRestore = folder.tryRestore;
        folder.hasBinding = async () => true;
        folder.tryRestore = async () => null;
        try {
            await window.KrKr2CacheStore.activeStore();
            return { rejected: false, code: '' };
        } catch (error) {
            return { rejected: true, code: error?.code || '' };
        } finally {
            folder.hasBinding = originalHasBinding;
            folder.tryRestore = originalTryRestore;
        }
    });
    ok(permissionBoundary.rejected && permissionBoundary.code === 'folder-permission-required',
        '文件夹失权时缓存边界拒绝回退到浏览器内部存储');

    // 在脚本创建文件夹与缓存 API 时替换权限状态，模拟保存了一个待续权句柄。
    const deniedPage = await browser.newPage();
    const deniedErrors = [];
    deniedPage.on('pageerror', (e) => deniedErrors.push(e.message));
    await deniedPage.evaluateOnNewDocument(() => {
        let folder;
        let bound = true;
        Object.defineProperty(window, 'KrKr2Folder', {
            configurable: true,
            get() { return folder; },
            set(value) {
                value.supported = () => true;
                value.hasBinding = async () => bound;
                value.tryRestore = async () => null;
                value.name = async () => bound ? 'Galgame' : '';
                value.unbind = async () => { bound = false; };
                folder = value;
            }
        });
        let cache;
        Object.defineProperty(window, 'KrKr2Cache', {
            configurable: true,
            get() { return cache; },
            set(value) {
                value.storageInfo = async () => ({
                    kind: 'folder', name: 'Galgame', supported: true,
                    bound: true, needsPermission: true
                });
                value.list = async () => {
                    const error = new Error('已绑定的游戏下载文件夹需要重新授权');
                    error.code = 'folder-permission-required';
                    throw error;
                };
                cache = value;
            }
        });
    });
    await deniedPage.goto(BASE + '/', { waitUntil: 'networkidle2' });
    await deniedPage.waitForSelector('.folder-permission-dialog');
    const galleryPrompt = await deniedPage.$eval(
        '.folder-permission-dialog', (el) => el.textContent.replace(/\s+/g, ' ').trim());
    ok(/需要重新授权文件夹/.test(galleryPrompt) && /恢复访问/.test(galleryPrompt),
        '图库加载后立即提示恢复文件夹访问');

    await deniedPage.evaluate(() => {
        [...document.querySelectorAll('.folder-permission-actions button')]
            .find((b) => b.textContent.includes('暂时忽略'))?.click();
    });
    await deniedPage.waitForSelector('.folder-permission-dialog', { hidden: true });
    ok(await deniedPage.$('.account-warning-dot') !== null,
        '暂时忽略后账号菜单仍显示权限异常标记');

    await deniedPage.setRequestInterception(true);
    deniedPage.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname === '/api/games/permission-test') {
            request.respond({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    game: {
                        id: 'permission-test', title: '权限测试', description: '', tags: [],
                        coverUrl: '', downloadUrl: 'https://example.invalid/game.zip'
                    }
                })
            });
        } else {
            request.continue();
        }
    });
    await deniedPage.goto(BASE + '/game/permission-test', { waitUntil: 'networkidle2' });
    await deniedPage.waitForSelector('.folder-permission-dialog');
    ok(true, '直接进入游戏详情也立即提示恢复文件夹访问');
    await deniedPage.evaluate(() => {
        [...document.querySelectorAll('.folder-permission-actions button')]
            .find((b) => b.textContent.includes('暂时忽略'))?.click();
    });
    await deniedPage.waitForSelector('.folder-permission-dialog', { hidden: true });
    ok(await deniedPage.$('.account-warning-dot') !== null,
        '详情页暂时忽略后账号菜单仍显示权限异常标记');

    for (const path of ['/settings', '/help', '/admin']) {
        await deniedPage.goto(BASE + path, { waitUntil: 'networkidle2' });
        await deniedPage.waitForSelector('.folder-permission-dialog');
        const actions = await deniedPage.$$eval(
            '.folder-permission-actions button', (buttons) => buttons.map((button) => button.textContent.trim()));
        ok(actions.includes('暂时忽略') && actions.includes('解除绑定') && actions.includes('恢复访问'),
            `${path} 进入时检测文件夹权限并允许暂时忽略`);
    }
    ok(deniedErrors.length === 0,
        deniedErrors.length ? '失权模拟页面异常: ' + deniedErrors[0] : '失权模拟无页面异常');
    await deniedPage.close();

    // 历史记录直达库内播放器：解除绑定前不得启动 wasm/游戏源。
    const blockedPlayer = await browser.newPage();
    const playerErrors = [];
    blockedPlayer.on('pageerror', (e) => playerErrors.push(e.message));
    await blockedPlayer.setRequestInterception(true);
    blockedPlayer.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname === '/api/games/permission-test') {
            request.respond({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    game: {
                        id: 'permission-test', title: '权限测试', description: '', tags: [],
                        coverUrl: '', downloadUrl: 'https://example.invalid/game.zip'
                    }
                })
            });
        } else {
            request.continue();
        }
    });
    await blockedPlayer.evaluateOnNewDocument(() => {
        let folder;
        let bound = true;
        Object.defineProperty(window, 'KrKr2Folder', {
            configurable: true,
            get() { return folder; },
            set(value) {
                value.supported = () => true;
                value.hasBinding = async () => bound;
                value.tryRestore = async () => null;
                value.name = async () => bound ? 'Galgame' : '';
                value.unbind = async () => { bound = false; };
                folder = value;
            }
        });
        let engine;
        window.__engineBoots = 0;
        Object.defineProperty(window, 'KrKr2Engine', {
            configurable: true,
            get() { return engine; },
            set(value) {
                const originalBoot = value.boot;
                value.boot = function (...args) {
                    window.__engineBoots++;
                    return originalBoot.apply(this, args);
                };
                engine = value;
            }
        });
    });
    await blockedPlayer.goto(BASE + '/play/permission-test', { waitUntil: 'networkidle2' });
    await blockedPlayer.waitForSelector('.folder-permission-dialog');
    const blockedState = await blockedPlayer.evaluate(() => ({
        boots: window.__engineBoots,
        actions: [...document.querySelectorAll('.folder-permission-actions button')]
            .map((button) => button.textContent.trim())
    }));
    ok(blockedState.boots === 0 && !blockedState.actions.includes('暂时忽略') &&
        blockedState.actions.includes('解除绑定'),
        '历史记录直达播放器时权限门阻止引擎启动且不可暂时忽略');
    blockedPlayer.once('dialog', (dialog) => dialog.accept());
    await blockedPlayer.evaluate(() => {
        [...document.querySelectorAll('.folder-permission-actions button')]
            .find((button) => button.textContent.includes('解除绑定'))?.click();
    });
    await blockedPlayer.waitForFunction(() => window.__engineBoots > 0);
    ok(true, '明确解除绑定后播放器才继续启动');
    ok(playerErrors.length === 0,
        playerErrors.length ? '播放器权限门页面异常: ' + playerErrors[0] : '播放器权限门无页面异常');
    await blockedPlayer.close();

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
