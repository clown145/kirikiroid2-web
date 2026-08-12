// 用 wrangler 本地 D1/R2 跑真实云存档 API，不 mock Worker binding。

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe', ...options });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} failed`);
    return result.stdout;
}

if (!existsSync('dist/index.html')) run('npm', ['run', 'build']);
run('npx', ['wrangler', 'd1', 'migrations', 'apply', 'krkr2-games', '--local']);

const suffix = randomUUID().replaceAll('-', '');
const userId = `usr_test_${suffix}`;
const gameId = `game_cloud_test_${suffix}`;
const token = `cloud-test-${suffix}`;
const tokenHash = createHash('sha256').update(token).digest('base64url');
const now = Date.now();
const sql = `
INSERT INTO users (id, display_name, avatar_url, created_at, updated_at, last_login_at)
VALUES ('${userId}', 'Cloud Test', '', ${now}, ${now}, ${now});
INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
VALUES ('${tokenHash}', '${userId}', ${now}, ${now + 3600000}, ${now});
INSERT INTO games (id, title, cover_url, download_url, entry_xp3, description, tags,
 sort_order, pinned, published, created_at, updated_at)
VALUES ('${gameId}', 'Cloud Test Game', '', '', '', '', '[]', 0, 0, 1, ${now}, ${now});`;
run('npx', ['wrangler', 'd1', 'execute', 'krkr2-games', '--local', '--command', sql]);

const port = 8800 + Math.floor(Math.random() * 200);
const worker = spawn('npx', ['wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe']
});
let workerOutput = '';
worker.stdout.on('data', (data) => { workerOutput += data; });
worker.stderr.on('data', (data) => { workerOutput += data; });

const base = `http://127.0.0.1:${port}`;

async function stopWorker() {
    if (worker.exitCode !== null) return;
    worker.kill('SIGTERM');
    await Promise.race([
        once(worker, 'exit'),
        new Promise((resolve) => setTimeout(resolve, 5000))
    ]);
}

function cleanupDatabase() {
    run('npx', ['wrangler', 'd1', 'execute', 'krkr2-games', '--local', '--command',
        `DELETE FROM save_heads WHERE user_id = '${userId}';
         DELETE FROM save_revisions WHERE user_id = '${userId}';
         DELETE FROM save_devices WHERE user_id = '${userId}';
         DELETE FROM user_sessions WHERE user_id = '${userId}';
         DELETE FROM users WHERE id = '${userId}';
         DELETE FROM games WHERE id = '${gameId}';`]);
}

let ready = false;
for (let i = 0; i < 60; i++) {
    try {
        const response = await fetch(base + '/api/account/me');
        if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!ready) {
    await stopWorker();
    cleanupDatabase();
    throw new Error('wrangler dev 启动失败\n' + workerOutput.slice(-2000));
}

let failures = 0;
const ok = (condition, label) => {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}`);
    if (!condition) failures++;
};
const cookie = `__Host-krkr2_user=${token}`;
const deviceHeaders = {
    Cookie: cookie,
    Origin: base,
    'Content-Type': 'application/zip',
    'X-KrKr2-Device-Id': `device_${suffix}`,
    'X-KrKr2-Device-Name': encodeURIComponent('API 测试设备'),
    'X-KrKr2-File-Count': '1'
};

function hash(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

async function upload(bytes, baseRevision = null, archiveHash = hash(bytes)) {
    const headers = {
        ...deviceHeaders,
        'Content-Length': String(bytes.byteLength),
        'X-KrKr2-Content-Hash': hash(Buffer.concat([Buffer.from('content:'), bytes])),
        'X-KrKr2-Archive-Sha256': archiveHash
    };
    if (baseRevision) headers['X-KrKr2-Base-Revision'] = baseRevision;
    return fetch(`${base}/api/saves/${encodeURIComponent(gameId)}/revisions`, {
        method: 'POST', headers, body: bytes
    });
}

try {
    const firstBytes = Buffer.from([0x50, 0x4b, 3, 4, 1, 2, 3]);
    const badHashResponse = await upload(firstBytes, null, '0'.repeat(64));
    ok(badHashResponse.status >= 400, 'R2 拒绝摘要不匹配的快照');

    const firstResponse = await upload(firstBytes);
    const first = await firstResponse.json();
    ok(firstResponse.status === 201, '首次上传创建云端版本');
    ok(!!first.revision?.id, '首次上传返回版本 id');

    const listResponse = await fetch(base + '/api/saves', { headers: { Cookie: cookie } });
    const list = await listResponse.json();
    ok(listResponse.ok && list.saves?.[0]?.id === first.revision.id, '列表 head 指向首次版本');

    const conflictResponse = await upload(Buffer.from([0x50, 0x4b, 9, 9]));
    const conflict = await conflictResponse.json();
    ok(conflictResponse.status === 409 && conflict.conflict === true, '缺少正确基线时返回 409 冲突');

    const secondBytes = Buffer.from([0x50, 0x4b, 3, 4, 8, 8, 8]);
    const secondResponse = await upload(secondBytes, first.revision.id);
    const second = await secondResponse.json();
    ok(secondResponse.status === 201, '携带当前 head 可创建下一版本');
    ok(second.revision?.parentRevisionId === first.revision.id, '新版本父节点是旧 head');

    const download = await fetch(
        `${base}/api/saves/${encodeURIComponent(gameId)}/revisions/${second.revision.id}/archive`,
        { headers: { Cookie: cookie } }
    );
    ok(download.ok && Buffer.compare(Buffer.from(await download.arrayBuffer()), secondBytes) === 0,
        '下载得到对应 R2 快照');

    const historyResponse = await fetch(`${base}/api/saves/${encodeURIComponent(gameId)}/history`, {
        headers: { Cookie: cookie }
    });
    const history = await historyResponse.json();
    ok(historyResponse.ok && history.revisions?.length === 2, '历史按版本保留');

    const restoreResponse = await fetch(`${base}/api/saves/${encodeURIComponent(gameId)}/restore`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            revisionId: first.revision.id,
            deviceId: `device_${suffix}`,
            deviceName: 'API 测试设备'
        })
    });
    const restored = await restoreResponse.json();
    ok(restoreResponse.status === 201, '恢复历史会创建新版本而非倒退 head');
    ok(restored.revision?.parentRevisionId === second.revision.id, '恢复版本连接在当前 head 后面');
} finally {
    await stopWorker();
    cleanupDatabase();
}

console.log(failures ? `\n✗ ${failures} 项问题` : '\n✓ 云存档 API 全部通过');
process.exit(failures ? 1 : 0);
