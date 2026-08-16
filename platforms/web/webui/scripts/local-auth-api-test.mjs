// 真实 D1 + Worker 的本站凭据回归测试，不 mock 认证、PBKDF2 或 session。

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { hashPassword } from '../worker/auth.js';

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe', ...options });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} failed`);
    return result.stdout;
}

function sql(command) {
    return run('npx', [
        'wrangler', 'd1', 'execute', 'krkr2-games', '--local', '--command', command
    ]);
}

function query(command) {
    return JSON.parse(run('npx', [
        'wrangler', 'd1', 'execute', 'krkr2-games', '--local', '--json', '--command', command
    ]))[0]?.results || [];
}

function tokenHash(token) {
    return createHash('sha256').update(token).digest('base64url');
}

function cookie(name, value) {
    return `${name}=${value}`;
}

function responseCookie(response, name) {
    const values = response.headers.getSetCookie?.() || [response.headers.get('set-cookie') || ''];
    return values.find((value) => value.startsWith(`${name}=`))?.split(';')[0] || '';
}

if (!existsSync('dist/index.html')) run('npm', ['run', 'build']);
run('npx', ['wrangler', 'd1', 'migrations', 'apply', 'krkr2-games', '--local']);

const suffix = randomUUID().replaceAll('-', '');
const testIp = `local-auth-test-${suffix}`;
const userA = `usr_local_a_${suffix}`;
const userB = `usr_local_b_${suffix}`;
const userC = `usr_local_c_${suffix}`;
const sessionA = `session-a-${suffix}`;
const sessionB = `session-b-${suffix}`;
const sessionC = `session-c-${suffix}`;
const setupGrantA = `setup-a-${suffix}`;
const setupGrantB = `setup-b-${suffix}`;
const resetGrantC = `reset-c-${suffix}`;
const setupPassword = 'x';
const changedPassword = 'changed-password-456';
const resetPassword = 'reset-password-789';
const tooLongPassword = 'x'.repeat(129);
const usernameSuffix = suffix.slice(0, 12);
const localUsername = `User.${usernameSuffix}`;
const normalizedUsername = localUsername.toLowerCase();
const occupiedUsername = `taken_${usernameSuffix}`;
const duplicateOccupiedUsername = `ＴＡＫＥＮ＿${usernameSuffix}`;
const rateProbeUsername = `rate_${usernameSuffix}`;
const offsetProbeUsername = `offset_${usernameSuffix}`;
const offsetProbeIp = `${testIp}-offset`;
const distributedProbeIps = Array.from(
    { length: 8 }, () => `${testIp}-distributed-${randomUUID()}`
);
const occupiedPasswordHash = await hashPassword('occupied-password-123');
const now = Date.now();

sql(`
INSERT INTO users (id, display_name, avatar_url, created_at, updated_at, last_login_at)
VALUES
 ('${userA}', 'Local Auth A', '', ${now}, ${now}, ${now}),
 ('${userB}', 'Local Auth B', '', ${now}, ${now}, ${now}),
 ('${userC}', 'Local Auth C', '', ${now}, ${now}, ${now});
INSERT INTO auth_identities
 (provider, provider_subject, user_id, provider_login, display_name, avatar_url, created_at, updated_at)
VALUES
 ('steam', 'steam_a_${suffix}', '${userA}', 'steam_a', 'Local Auth A', '', ${now}, ${now}),
 ('steam', 'steam_b_${suffix}', '${userB}', 'steam_b', 'Local Auth B', '', ${now}, ${now}),
 ('steam', 'steam_c_${suffix}', '${userC}', 'steam_c', 'Local Auth C', '', ${now}, ${now});
INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
VALUES
 ('${tokenHash(sessionA)}', '${userA}', ${now}, ${now + 3600000}, ${now}),
 ('${tokenHash(sessionB)}', '${userB}', ${now}, ${now + 3600000}, ${now}),
 ('${tokenHash(sessionC)}', '${userC}', ${now}, ${now + 3600000}, ${now});
INSERT INTO local_credentials
 (user_id, username, username_normalized, password_hash, created_at, updated_at)
VALUES
 ('${userB}', '${occupiedUsername}', '${occupiedUsername}', '${occupiedPasswordHash}', ${now}, ${now});
INSERT INTO local_auth_grants
 (token_hash, user_id, purpose, provider, session_token_hash, created_at, expires_at)
VALUES
 ('${tokenHash(setupGrantA)}', '${userA}', 'setup', 'steam', '${tokenHash(sessionA)}',
  ${now}, ${now + 600000}),
 ('${tokenHash(setupGrantB)}', '${userB}', 'setup', 'steam', '${tokenHash(sessionB)}',
  ${now}, ${now + 600000}),
 ('${tokenHash(resetGrantC)}', '${userC}', 'reset', 'steam', NULL,
  ${now}, ${now + 600000});
`);

const port = 9000 + Math.floor(Math.random() * 500);
const worker = spawn(
    'npx', ['wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port)],
    { stdio: ['ignore', 'pipe', 'pipe'] }
);
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
    const ipRateKeys = [testIp, offsetProbeIp, ...distributedProbeIps]
        .map((ip) => `'local-auth:ip:${ip}'`).join(', ');
    const accountRateKeys = [
        `login:${normalizedUsername}`,
        `current:${userA}`,
        `login:${rateProbeUsername}`,
        `login:${offsetProbeUsername}`
    ].map((identity) => `'local-auth:account:${tokenHash(identity)}'`).join(', ');
    sql(`
      DELETE FROM local_auth_grants WHERE user_id IN ('${userA}', '${userB}', '${userC}');
      DELETE FROM local_credentials WHERE user_id IN ('${userA}', '${userB}', '${userC}');
      DELETE FROM user_sessions WHERE user_id IN ('${userA}', '${userB}', '${userC}');
      DELETE FROM auth_identities WHERE user_id IN ('${userA}', '${userB}', '${userC}');
      DELETE FROM users WHERE id IN ('${userA}', '${userB}', '${userC}');
      DELETE FROM local_auth_rate_limits
       WHERE bucket_key IN (${ipRateKeys}, ${accountRateKeys});
    `);
}

let failures = 0;
const ok = (condition, label) => {
    console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}`);
    if (!condition) failures++;
};

function authCookies(session, grant = '') {
    return [
        session ? cookie('__Host-krkr2_user', session) : '',
        grant ? cookie('__Host-krkr2_local_grant', grant) : ''
    ].filter(Boolean).join('; ');
}

async function post(path, body, requestCookie = '', origin = base, ip = testIp) {
    const headers = {
        'Content-Type': 'application/json',
        Origin: origin,
        'CF-Connecting-IP': ip
    };
    if (requestCookie) headers.Cookie = requestCookie;
    const response = await fetch(base + path, {
        method: 'POST', headers, body: JSON.stringify(body)
    });
    return { response, data: await response.json() };
}

async function me(requestCookie) {
    const response = await fetch(base + '/api/account/me', {
        headers: {
            ...(requestCookie ? { Cookie: requestCookie } : {}),
            'CF-Connecting-IP': testIp
        }
    });
    return response.json();
}

async function insertGrant({ token, userId, purpose, sessionToken = null }) {
    const stamp = Date.now();
    sql(`
      INSERT INTO local_auth_grants
       (token_hash, user_id, purpose, provider, session_token_hash, created_at, expires_at)
      VALUES ('${tokenHash(token)}', '${userId}', '${purpose}', 'steam',
       ${sessionToken ? `'${tokenHash(sessionToken)}'` : 'NULL'}, ${stamp}, ${stamp + 600000});
    `);
}

try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
        try {
            const response = await fetch(base + '/api/account/me');
            if (response.ok) { ready = true; break; }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error('wrangler dev 启动失败\n' + workerOutput.slice(-2000));

    const firstMe = await me(authCookies(sessionA));
    ok(firstMe.localLogin?.configured === false && firstMe.localLogin?.shouldPrompt === true,
        'OAuth 用户首次登录时提示可选本站凭据');

    const promptBefore = await me(authCookies(sessionC));
    const dismissed = await post('/api/account/local/prompt', { dismissed: true }, authCookies(sessionC));
    const promptAfter = await me(authCookies(sessionC));
    ok(promptBefore.localLogin?.shouldPrompt === true && dismissed.response.ok &&
        promptAfter.localLogin?.shouldPrompt === false,
    '暂不设置后不再提示');

    const linkStart = await fetch(
        `${base}/api/account/login/steam?link=1&returnTo=${encodeURIComponent('/settings')}`,
        {
            redirect: 'manual',
            headers: {
                Cookie: authCookies(sessionC),
                'CF-Connecting-IP': testIp
            }
        }
    );
    const linkLocation = new URL(linkStart.headers.get('location'));
    const linkReturnTo = new URL(linkLocation.searchParams.get('openid.return_to'));
    const linkState = linkReturnTo.searchParams.get('state');
    const linkPayload = JSON.parse(
        Buffer.from(linkState.split('.')[0], 'base64url').toString()
    );
    const linkOauthCookie = responseCookie(linkStart, '__Host-krkr2_oauth_steam');
    ok(linkPayload.purpose === 'link' && !!linkPayload.sessionBinding &&
        linkPayload.sessionBinding !== tokenHash(sessionC) &&
        !linkPayload.sessionBinding.includes(sessionC),
    '账号绑定 state 只携带 HMAC session binding');

    await post('/api/account/logout', {}, authCookies(sessionC));
    const revokedLinkCallback = await fetch(
        `${base}/api/account/callback/steam?state=${encodeURIComponent(linkState)}`,
        {
            redirect: 'manual',
            headers: {
                Cookie: `${linkOauthCookie}; ${authCookies(sessionC)}`,
                'CF-Connecting-IP': testIp
            }
        }
    );
    const revokedLinkTarget = new URL(revokedLinkCallback.headers.get('location'));
    ok(revokedLinkCallback.status === 302 &&
        revokedLinkTarget.searchParams.get('authError') === 'link_session_expired',
    '原 session 撤销后旧 link callback 不能绑定身份');

    const crossOrigin = await post(
        '/api/account/local/credentials',
        { username: 'cross_origin', password: setupPassword, grant: true },
        authCookies(sessionA, setupGrantA),
        'https://evil.example'
    );
    ok(crossOrigin.response.status === 403 && crossOrigin.data.code === 'invalid_origin',
        '凭据写接口拒绝跨站 Origin');

    const staleSetup = await post(
        '/api/account/local/credentials',
        { password: changedPassword, grant: true },
        authCookies(sessionB, setupGrantB)
    );
    ok(staleSetup.response.status === 401 && staleSetup.data.code === 'grant_scope_invalid',
        'setup grant 不能修改已有凭据');

    const resetWithoutCredential = await post(
        '/api/account/local/credentials',
        { username: 'reset_without_credential', password: changedPassword, grant: true },
        authCookies('', resetGrantC)
    );
    ok(resetWithoutCredential.response.status === 409 &&
        resetWithoutCredential.data.code === 'credential_not_configured',
    'reset grant 不能替代首次设置流程');

    const tooLongSetup = await post(
        '/api/account/local/credentials',
        { username: localUsername, password: tooLongPassword, grant: true },
        authCookies(sessionA, setupGrantA)
    );
    ok(tooLongSetup.response.status === 400 &&
        tooLongSetup.data.code === 'invalid_password',
    '本站密码取消最小位数限制但仍拒绝超过 128 位');

    const setup = await post(
        '/api/account/local/credentials',
        { username: localUsername, password: setupPassword, grant: true },
        authCookies(sessionA, setupGrantA)
    );
    const setupSessionCookie = responseCookie(setup.response, '__Host-krkr2_user');
    ok(setup.response.ok && setup.data.localLogin?.username === localUsername && !!setupSessionCookie,
        '绑定原 OAuth session 的 setup grant 可设置 1 位密码');
    ok((await me(authCookies(sessionA))).user === null,
        '首次设置凭据后旧 OAuth session 失效');

    const stored = query(
        `SELECT username_normalized, password_hash FROM local_credentials WHERE user_id = '${userA}'`
    )[0];
    ok(stored?.username_normalized === normalizedUsername &&
        stored.password_hash?.startsWith('pbkdf2$') &&
        stored.password_hash !== setupPassword,
    '登录名规范化且 D1 只保存 PBKDF2 哈希');

    const normalizedLogin = await post(
        '/api/account/local/login',
        { username: localUsername.toUpperCase(), password: setupPassword }
    );
    const loginSessionCookie = responseCookie(normalizedLogin.response, '__Host-krkr2_user');
    ok(normalizedLogin.response.ok && normalizedLogin.data.user?.id === userA && !!loginSessionCookie,
        '本站登录名大小写归一化后可登录');

    const duplicate = await post(
        '/api/account/local/credentials',
        {
            username: duplicateOccupiedUsername,
            password: changedPassword,
            currentPassword: setupPassword
        },
        setupSessionCookie
    );
    ok(duplicate.response.status === 409 && duplicate.data.code === 'username_taken',
        'NFKC 与大小写归一化后的重复登录名被拒绝');

    const wrongCurrent = await post(
        '/api/account/local/credentials',
        { password: changedPassword, currentPassword: 'wrong-current-password' },
        setupSessionCookie
    );
    ok(wrongCurrent.response.status === 401 &&
        wrongCurrent.data.code === 'current_password_invalid',
    '错误的当前密码不能修改凭据');

    const extraSession = `extra-session-${suffix}`;
    const extraNow = Date.now();
    sql(`
      INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
      VALUES ('${tokenHash(extraSession)}', '${userA}', ${extraNow},
       ${extraNow + 3600000}, ${extraNow});
    `);
    const changed = await post(
        '/api/account/local/credentials',
        { password: changedPassword, currentPassword: setupPassword },
        setupSessionCookie
    );
    const changedSessionCookie = responseCookie(changed.response, '__Host-krkr2_user');
    ok(changed.response.ok && changed.data.localLogin?.username === localUsername &&
        !!changedSessionCookie,
    '当前密码验证后可改密并保留原登录名');
    ok((await me(loginSessionCookie)).user === null &&
        (await me(authCookies(extraSession))).user === null &&
        (await me(setupSessionCookie)).user === null,
    '改密撤销账号的其他所有 session');
    ok((await me(changedSessionCookie)).user?.id === userA,
        '改密后只换发当前设备的新 session');

    const oldPasswordLogin = await post(
        '/api/account/local/login', { username: normalizedUsername, password: setupPassword }
    );
    const newPasswordLogin = await post(
        '/api/account/local/login', { username: normalizedUsername, password: changedPassword }
    );
    ok(oldPasswordLogin.response.status === 401 && newPasswordLogin.response.ok,
        '改密后旧密码失效、新密码生效');

    const racePasswordA = 'race-password-a-012';
    const racePasswordB = 'race-password-b-345';
    const currentPasswordRace = await Promise.all([
        post(
            '/api/account/local/credentials',
            { password: racePasswordA, currentPassword: changedPassword },
            changedSessionCookie
        ),
        post(
            '/api/account/local/credentials',
            { password: racePasswordB, currentPassword: changedPassword },
            changedSessionCookie
        )
    ]);
    const currentWinners = currentPasswordRace
        .map((item, index) => ({ ...item, index }))
        .filter((item) => item.response.ok);
    const currentWinner = currentWinners[0];
    const racedPassword = currentWinner?.index === 0 ? racePasswordA : racePasswordB;
    const racedSessionCookie = currentWinner
        ? responseCookie(currentWinner.response, '__Host-krkr2_user')
        : '';
    ok(currentWinners.length === 1 && !!racedSessionCookie,
        '并发旧密码请求只有一个 CAS mutation 能成功');
    ok((await me(changedSessionCookie)).user === null,
        '并发改密成功后原授权 session 被撤销');

    const raceOldLogin = await post(
        '/api/account/local/login', { username: normalizedUsername, password: changedPassword }
    );
    const raceWinnerLogin = await post(
        '/api/account/local/login', { username: normalizedUsername, password: racedPassword }
    );
    ok(raceOldLogin.response.status === 401 && raceWinnerLogin.response.ok,
        'stale old hash 不能在并发请求中覆盖获胜密码');

    const racedSessionToken = racedSessionCookie.split('=')[1];
    const reauthGrant = `reauth-a-${suffix}`;
    await insertGrant({
        token: reauthGrant,
        userId: userA,
        purpose: 'reauth',
        sessionToken: racedSessionToken
    });
    const unboundReauth = await post(
        '/api/account/local/credentials',
        { password: resetPassword, grant: true },
        authCookies('', reauthGrant)
    );
    ok(unboundReauth.response.status === 401 &&
        unboundReauth.data.code === 'grant_session_invalid',
    'reauth grant 离开原 session 后不可使用');

    const resetGrantA = `reset-a-${suffix}`;
    const secondResetGrantA = `reset-a-second-${suffix}`;
    const secondResetPassword = 'reset-password-second-012';
    await insertGrant({ token: resetGrantA, userId: userA, purpose: 'reset' });
    await insertGrant({ token: secondResetGrantA, userId: userA, purpose: 'reset' });
    const resetRace = await Promise.all([
        post(
            '/api/account/local/credentials',
            { password: resetPassword, grant: true },
            authCookies('', resetGrantA)
        ),
        post(
            '/api/account/local/credentials',
            { password: secondResetPassword, grant: true },
            authCookies('', secondResetGrantA)
        )
    ]);
    const resetWinners = resetRace
        .map((item, index) => ({ ...item, index }))
        .filter((item) => item.response.ok);
    const resetWinner = resetWinners[0];
    const winningResetPassword = resetWinner?.index === 0
        ? resetPassword
        : secondResetPassword;
    const resetSessionCookie = resetWinner
        ? responseCookie(resetWinner.response, '__Host-krkr2_user')
        : '';
    ok(resetWinners.length === 1 &&
        resetWinner?.data.localLogin?.username === localUsername && !!resetSessionCookie,
    '并发 reset grants 只有一个原子 mutation 能成功');
    ok((await me(racedSessionCookie)).user === null,
        'OAuth 重置密码撤销此前 session');

    const replay = await post(
        '/api/account/local/credentials',
        { password: 'replayed-password-000', grant: true },
        authCookies('', resetGrantA)
    );
    const siblingGrant = await post(
        '/api/account/local/credentials',
        { password: 'sibling-password-000', grant: true },
        authCookies('', secondResetGrantA)
    );
    ok(replay.response.status === 401 && replay.data.code === 'grant_invalid' &&
        siblingGrant.response.status === 401 && siblingGrant.data.code === 'grant_invalid',
    'stale/replayed grant 不能覆盖获胜密码');

    const resetLogin = await post(
        '/api/account/local/login', { username: normalizedUsername, password: winningResetPassword }
    );
    ok(resetLogin.response.ok, 'OAuth 重置后的新密码可登录');

    const offsetFailure = await post(
        '/api/account/local/login',
        { username: offsetProbeUsername, password: 'offset-failure-password-012' },
        '', base, offsetProbeIp
    );
    const offsetSuccess = await post(
        '/api/account/local/login',
        { username: normalizedUsername, password: winningResetPassword },
        '', base, offsetProbeIp
    );
    const offsetAttempts = query(
        `SELECT attempts FROM local_auth_rate_limits
         WHERE bucket_key = 'local-auth:ip:${offsetProbeIp}'`
    )[0]?.attempts;
    ok(offsetFailure.response.status === 401 && offsetSuccess.response.ok &&
        Number(offsetAttempts) === 1,
    '成功登录只撤销自身预占，不能抵消同 IP 的失败次数');

    const rateProbe = await Promise.all(distributedProbeIps.map((ip) => post(
        '/api/account/local/login',
        { username: rateProbeUsername, password: 'rate-probe-password-012' },
        '', base, ip
    )));
    const rateLimited = rateProbe.filter((item) =>
        item.response.status === 429 && item.data.code === 'rate_limited'
    ).length;
    const rateProbeKey =
        `local-auth:account:${tokenHash(`login:${rateProbeUsername}`)}`;
    const reserved = query(
        `SELECT attempts FROM local_auth_rate_limits
         WHERE bucket_key = '${rateProbeKey}'`
    )[0]?.attempts;
    ok(rateLimited === 3 && Number(reserved) === 8,
        `D1 全局账号桶跨 IP 原子预占不会少计密码尝试 ` +
        `(429=${rateLimited}, attempts=${reserved ?? 'missing'})`);
} finally {
    await stopWorker();
    cleanupDatabase();
}

console.log(failures ? `\n✗ ${failures} 项问题` : '\n✓ 本站凭据 API 全部通过');
process.exit(failures ? 1 : 0);
