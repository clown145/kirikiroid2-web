// 玩家认证入口冒烟测试。不访问 Steam/GitHub 账号，只检查本地 Worker 生成的
// 重定向、state cookie、PKCE 参数与玩家/管理员权限边界。

import { validateSteamAssertion } from '../worker/user-auth.js';

const BASE = process.env.KRKR2_TEST_BASE || 'http://localhost:8787';
const results = [];
const ok = (label, pass) => results.push([label, !!pass]);
const jsonHeaders = { 'Content-Type': 'application/json', Origin: BASE };

const me = await fetch(`${BASE}/api/account/me`);
const meData = await me.json();
ok('未登录时 account/me 返回 200', me.status === 200);
ok('未登录时 user 为 null', meData.user === null);
ok('未登录时不提示设置本地登录',
    meData.localLogin?.configured === false &&
    meData.localLogin?.username === '' &&
    meData.localLogin?.shouldPrompt === false);
ok('Steam 登录入口可用', meData.availableProviders?.steam === true);

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

function syntheticSteamAssertion(returnTo) {
    const callback = new URL(`${BASE}/api/account/callback/steam`);
    const claimed = 'https://steamcommunity.com/openid/id/76561198000000000';
    callback.searchParams.set('state', steamState);
    callback.searchParams.set('openid.ns', 'http://specs.openid.net/auth/2.0');
    callback.searchParams.set('openid.mode', 'id_res');
    callback.searchParams.set('openid.op_endpoint', 'https://steamcommunity.com/openid/login');
    callback.searchParams.set('openid.claimed_id', claimed);
    callback.searchParams.set('openid.identity', claimed);
    callback.searchParams.set('openid.return_to', returnTo);
    callback.searchParams.set('openid.response_nonce', '2026-08-16T00:00:00Ztest');
    callback.searchParams.set('openid.assoc_handle', 'test-handle');
    callback.searchParams.set(
        'openid.signed',
        'op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle'
    );
    callback.searchParams.set('openid.sig', 'test-signature');
    return new Request(callback);
}

let canonicalSteamAssertionAccepted = false;
try {
    validateSteamAssertion(syntheticSteamAssertion(steamReturnTo.toString()), {});
    canonicalSteamAssertionAccepted = true;
} catch {}
ok('Steam OpenID 前置校验接受本站 callback', canonicalSteamAssertionAccepted);

let crossRpSteamAssertionRejected = false;
try {
    validateSteamAssertion(
        syntheticSteamAssertion(`https://evil.example/callback?state=${encodeURIComponent(steamState)}`),
        {}
    );
} catch {
    crossRpSteamAssertionRejected = true;
}
ok('其他站点取得的 Steam OpenID 断言不能拼接本站 state', crossRpSteamAssertionRejected);

const stateAsAdminSession = await fetch(`${BASE}/api/admin/me`, {
    headers: { Cookie: `__Host-krkr2_sess=${steamState}` }
});
ok('OAuth state 不能冒充管理员 session', stateAsAdminSession.status === 401);

const unauthLink = await fetch(`${BASE}/api/account/login/steam?link=1`, { redirect: 'manual' });
ok('未登录不能绑定平台账号', unauthLink.status === 401);

const unauthReauth = await fetch(
    `${BASE}/api/account/login/steam?purpose=reauth`,
    { redirect: 'manual' }
);
const unauthReauthData = await unauthReauth.json();
ok('未登录不能发起账号重验证',
    unauthReauth.status === 401 && unauthReauthData.code === 'not_logged_in');

const reset = await fetch(
    `${BASE}/api/account/login/steam?purpose=reset&returnTo=${encodeURIComponent('/settings')}`,
    { redirect: 'manual' }
);
const resetLocation = new URL(reset.headers.get('location'));
const resetReturnTo = new URL(resetLocation.searchParams.get('openid.return_to'));
const resetState = resetReturnTo.searchParams.get('state');
const resetPayload = JSON.parse(Buffer.from(resetState.split('.')[0], 'base64url').toString());
ok('未登录可以发起绑定平台的密码找回', reset.status === 302);
ok('密码找回 state 只记录用途、不指定或创建用户',
    resetPayload.purpose === 'reset' &&
    resetPayload.linkUserId === null &&
    resetPayload.targetUserId === null);

const invalidPurpose = await fetch(
    `${BASE}/api/account/login/steam?purpose=create-local-user`,
    { redirect: 'manual' }
);
ok('拒绝未知 OAuth 用途', invalidPurpose.status === 400);

const localCredentials = await fetch(`${BASE}/api/account/local/credentials`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ username: 'new-user', password: 'long-enough-password' })
});
const localCredentialsData = await localCredentials.json();
ok('没有当前密码或 OAuth grant 不能设置本站凭据',
    localCredentials.status === 401 && localCredentialsData.code === 'reauth_required');

const localPrompt = await fetch(`${BASE}/api/account/local/prompt`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ dismissed: true })
});
const localPromptData = await localPrompt.json();
ok('未登录不能更改密码登录提示状态',
    localPrompt.status === 401 && localPromptData.code === 'not_logged_in');

const crossOriginLogin = await fetch(`${BASE}/api/account/local/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ username: 'not-a-real-user', password: 'not-a-real-password' })
});
const crossOriginData = await crossOriginLogin.json();
ok('本站凭据写接口拒绝跨站请求',
    crossOriginLogin.status === 403 && crossOriginData.code === 'invalid_origin');

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

const logout = await fetch(`${BASE}/api/account/logout`, {
    method: 'POST',
    headers: { Origin: BASE }
});
const logoutCookie = logout.headers.get('set-cookie') || '';
ok('玩家退出接口成功', logout.status === 200);
ok('玩家 cookie 与管理员 cookie 分离',
    logoutCookie.startsWith('__Host-krkr2_user=') && !logoutCookie.includes('__Host-krkr2_sess='));
ok('退出会清除玩家 cookie', /Max-Age=0/i.test(logoutCookie));
ok('退出同时清除一次性本地认证 grant',
    logoutCookie.includes('__Host-krkr2_local_grant=') && /Max-Age=0/i.test(logoutCookie));

let failed = 0;
for (const [label, pass] of results) {
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}`);
    if (!pass) failed++;
}
console.log(failed ? `\n✗ ${failed} 项问题` : '\n✓ 玩家认证入口通过');
process.exit(failed ? 1 : 0);
