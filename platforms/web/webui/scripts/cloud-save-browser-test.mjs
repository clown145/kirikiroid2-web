// 真实浏览器 UI 往返：IndexedDB -> 手动上传 -> R2 -> 清空本机 -> 手动下载。

import puppeteer from 'puppeteer-core';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const BASE = process.env.KRKR2_TEST_BASE || 'http://127.0.0.1:8787';
const suffix = randomUUID().replaceAll('-', '');
const userId = `usr_browser_${suffix}`;
const gameId = `game_browser_${suffix}`;
const token = `browser-${suffix}`;
const now = Date.now();
const tokenHash = createHash('sha256').update(token).digest('base64url');

function sql(command) {
    const result = spawnSync(
        'npx', ['wrangler', 'd1', 'execute', 'krkr2-games', '--local', '--command', command],
        { encoding: 'utf8' }
    );
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

async function clickButton(page, text) {
    const clicked = await page.evaluate((label) => {
        const button = [...document.querySelectorAll('button')]
            .find((item) => item.textContent.trim() === label || item.textContent.includes(label));
        button?.click();
        return !!button;
    }, text);
    if (!clicked) throw new Error(`找不到按钮：${text}`);
}

sql(`
  INSERT INTO users (id, display_name, avatar_url, created_at, updated_at, last_login_at)
  VALUES ('${userId}', '浏览器同步测试', '', ${now}, ${now}, ${now});
  INSERT INTO user_sessions VALUES ('${tokenHash}', '${userId}', ${now}, ${now + 3600000}, ${now});
  INSERT INTO games VALUES ('${gameId}', '浏览器云存档测试', '', '', '', '', '[]', 0, 0, 1, ${now}, ${now});
`);

const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--no-sandbox']
});

let failures = 0;
const ok = (condition, label) => {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}`);
    if (!condition) failures++;
};

try {
    const page = await browser.newPage();
    await page.setCookie({
        name: '__Host-krkr2_user', value: token, url: `${BASE}/`,
        httpOnly: true, secure: true, sameSite: 'Lax'
    });
    await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle2' });

    await page.evaluate(async (id) => {
        const space = 'game_' + id;
        await window.KrKr2IDB.open(space);
        window.KrKr2IDB.registerSpace(space);
        await window.KrKr2IDB.saveFile('/savedata/test.dat', new Uint8Array([11, 22, 33, 44, 55]));
        await window.KrKr2IDB.whenIdle();
    }, gameId);

    await clickButton(page, '管理同步');
    await page.waitForSelector('.sync-toolbar button');
    await clickButton(page, '同步全部存档');
    await page.waitForFunction(() =>
        document.body.innerText.includes('完成：') ||
        document.body.innerText.includes('已同步') ||
        document.body.innerText.includes('已上传'),
        { timeout: 15000 }
    );
    ok(await page.evaluate(() => document.body.innerText.includes('已同步')), 'UI 完成手动上传');

    await clickButton(page, '关闭');
    await page.evaluate(async (id) => {
        await window.KrKr2IDB.replaceFiles('game_' + id, [], {
            dirty: false, baseRevision: null, contentHash: null
        });
    }, gameId);

    await clickButton(page, '管理同步');
    await page.waitForSelector('.sync-toolbar button');
    await page.waitForFunction(() =>
        document.body.innerText.includes('仅站点云端') ||
        document.body.innerText.includes('仅WebDAV') ||
        document.body.innerText.includes('云端有更新'),
        { timeout: 10000 }
    );
    await page.evaluate(() => {
        const row = [...document.querySelectorAll('.sync-row')]
            .find((item) => item.textContent.includes('浏览器云存档测试'));
        [...row.querySelectorAll('button')]
            .find((item) => item.textContent.trim() === '同步').click();
    });
    await page.waitForFunction(() =>
        document.body.innerText.includes('已下载远端版本') ||
        document.body.innerText.includes('已下载') ||
        document.body.innerText.includes('已同步'),
        { timeout: 15000 }
    );

    const restored = await page.evaluate(async (id) => {
        const snapshot = await window.KrKr2IDB.snapshot('game_' + id);
        return { bytes: [...snapshot.files[0].data], meta: snapshot.meta };
    }, gameId);
    ok(restored.bytes.join(',') === '11,22,33,44,55', '从 R2 恢复原始存档字节');
    ok(restored.meta.dirty === false && !!restored.meta.baseRevision, '下载后记录同步基线且无待同步变化');
} finally {
    await browser.close();
    sql(`
      DELETE FROM save_heads WHERE user_id = '${userId}';
      DELETE FROM save_revisions WHERE user_id = '${userId}';
      DELETE FROM save_devices WHERE user_id = '${userId}';
      DELETE FROM user_sessions WHERE user_id = '${userId}';
      DELETE FROM users WHERE id = '${userId}';
      DELETE FROM games WHERE id = '${gameId}';
    `);
}

console.log(failures ? `\n✗ ${failures} 项问题` : '\n✓ 云存档浏览器往返通过');
process.exit(failures ? 1 : 0);
