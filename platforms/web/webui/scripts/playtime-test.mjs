// 游玩时长与排行榜 API 冒烟测试。
// 验证未登录应答、心跳参数校验、单游戏榜与全站榜单接口响应格式。

const BASE = process.env.KRKR2_TEST_BASE || 'http://localhost:8787';
const results = [];
const ok = (label, pass) => results.push([label, !!pass]);

// 1. 未登录查询个人时长
const meRes = await fetch(`${BASE}/api/playtime/me`);
const meData = await meRes.json();
ok('未登录时 /api/playtime/me 返回 200', meRes.status === 200);
ok('未登录时 playtimes 为空数组', Array.isArray(meData.playtimes) && meData.playtimes.length === 0);
ok('未登录时 totalSeconds 为 0', meData.totalSeconds === 0);
ok('未登录时标记 guest: true', meData.guest === true);

// 2. 未登录上报心跳
const guestHeartbeat = await fetch(`${BASE}/api/playtime/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gameId: 'test_game', deltaSeconds: 60 })
});
const guestHbData = await guestHeartbeat.json();
ok('未登录上报心跳返回 200', guestHeartbeat.status === 200);
ok('未登录上报心跳 ok: true 且 saved: false', guestHbData.ok === true && guestHbData.saved === false);

// 3. 错误参数校验
const invalidHb1 = await fetch(`${BASE}/api/playtime/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gameId: '', deltaSeconds: 60 })
});
ok('缺少 gameId 时返回 400', invalidHb1.status === 400);

const invalidHb2 = await fetch(`${BASE}/api/playtime/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gameId: 'test_game', deltaSeconds: -10 })
});
ok('deltaSeconds <= 0 时返回 400', invalidHb2.status === 400);

// 4. 单游戏排行榜接口
const gameLbRes = await fetch(`${BASE}/api/leaderboard/game/test_game`);
const gameLbData = await gameLbRes.json();
ok('单游戏排行榜返回 200', gameLbRes.status === 200);
ok('包含 stats 统计对象', typeof gameLbData.stats === 'object' && gameLbData.stats !== null);
ok('包含 leaderboard 列表', Array.isArray(gameLbData.leaderboard));

// 5. 全站综合榜单接口
const globalUsersRes = await fetch(`${BASE}/api/leaderboard/global/users`);
const globalUsersData = await globalUsersRes.json();
ok('全站玩家榜返回 200', globalUsersRes.status === 200);
ok('全站玩家榜 type: users', globalUsersData.type === 'users');
ok('全站玩家榜 list 为数组', Array.isArray(globalUsersData.list));

const globalGamesRes = await fetch(`${BASE}/api/leaderboard/global/games`);
const globalGamesData = await globalGamesRes.json();
ok('全站热门作品榜返回 200', globalGamesRes.status === 200);
ok('全站热门作品榜 type: games', globalGamesData.type === 'games');
ok('全站热门作品榜 list 为数组', Array.isArray(globalGamesData.list));

// 6. 隐私修改接口未登录拦截
const privacyRes = await fetch(`${BASE}/api/playtime/privacy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hidePlaytime: true })
});
ok('未登录修改隐私设置返回 401', privacyRes.status === 401);

let failed = 0;
for (const [label, pass] of results) {
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}`);
    if (!pass) failed++;
}

if (failed > 0) {
    console.error(`\n${failed} 个测试失败`);
    process.exit(1);
} else {
    console.log(`\n全部 ${results.length} 个游玩时长与排行榜冒烟测试通过`);
}
