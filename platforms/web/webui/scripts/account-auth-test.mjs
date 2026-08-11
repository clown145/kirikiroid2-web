// 玩家认证入口冒烟测试。不访问 Steam/GitHub 账号，只检查本地 Worker 生成的
// 重定向、state cookie、PKCE 参数与玩家/管理员权限边界。

const BASE = process.env.KRKR2_TEST_BASE || 'http://localhost:8787';
const results = [];
const ok = (label, pass) => results.push([label, !!pass]);

const me = await fetch(`${BASE}/api/account/me`);
const meData = await me.json();
ok('未登录时 account/me 返回 200', me.status === 200);
ok('未登录时 user 为 null', meData.user === null);
ok('Steam 登录入口可用', meData.availableProviders?.steam === true);

const avatar = await fetch(`${BASE}/api/account/avatar`);
ok('未登录不能读取玩家头像', avatar.status === 401);

const steam = await fetch(
    `${BASE}/api/account/login/steam?returnTo=${encodeURIComponent('//evil.example/path')}`,
    { redirect: 'manual' }
);
const steamLocation = new URL(steam.headers.get('location'));
const steamReturnTo = new URL(steamLocation.searchParams.get('openid.return_to'));
const steamState = steamReturnTo.searchParams.get('state');
const statePayload = JSON.parse(Buffer.from(steamState.split('.')[0], 'base64url').toString());
const steamCookie = steam.headers.get('set-cookie') || '';

ok('Steam 登录返回 302', steam.status === 302);
ok('Steam 重定向到官方域名', steamLocation.origin === 'https://steamcommunity.com');
ok('Steam 使用 OpenID checkid_setup', steamLocation.searchParams.get('openid.mode') === 'checkid_setup');
ok('Steam callback 回到同源 Worker', steamReturnTo.origin === BASE);
ok('外部 returnTo 被归一化到首页', statePayload.returnTo === '/');
ok('OAuth state cookie 为 HttpOnly', /HttpOnly/i.test(steamCookie));
ok('OAuth state cookie 为 Secure', /Secure/i.test(steamCookie));
ok('OAuth state cookie 使用 SameSite=Lax', /SameSite=Lax/i.test(steamCookie));

const unauthLink = await fetch(`${BASE}/api/account/login/steam?link=1`, { redirect: 'manual' });
ok('未登录不能绑定平台账号', unauthLink.status === 401);

const github = await fetch(`${BASE}/api/account/login/github`, { redirect: 'manual' });
if (github.status === 302) {
    const githubLocation = new URL(github.headers.get('location'));
    ok('GitHub 重定向到官方域名', githubLocation.origin === 'https://github.com');
    ok('GitHub OAuth 带 state', !!githubLocation.searchParams.get('state'));
    ok('GitHub OAuth 使用 PKCE S256',
        githubLocation.searchParams.get('code_challenge_method') === 'S256' &&
        !!githubLocation.searchParams.get('code_challenge'));
    ok('GitHub 只申请 read:user', githubLocation.searchParams.get('scope') === 'read:user');
} else {
    ok('未配置 GitHub 时明确返回 503', github.status === 503);
}

const logout = await fetch(`${BASE}/api/account/logout`, { method: 'POST' });
const logoutCookie = logout.headers.get('set-cookie') || '';
ok('玩家退出接口成功', logout.status === 200);
ok('玩家 cookie 与管理员 cookie 分离',
    logoutCookie.startsWith('__Host-krkr2_user=') && !logoutCookie.includes('__Host-krkr2_sess='));
ok('退出会清除玩家 cookie', /Max-Age=0/i.test(logoutCookie));

let failed = 0;
for (const [label, pass] of results) {
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}`);
    if (!pass) failed++;
}
console.log(failed ? `\n✗ ${failed} 项问题` : '\n✓ 玩家认证入口通过');
process.exit(failed ? 1 : 0);
