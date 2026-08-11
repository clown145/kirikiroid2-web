// 玩家账号认证：GitHub OAuth + PKCE、Steam OpenID 2.0、可撤销 D1 session。
//
// 管理员后台继续使用 auth.js 的密码与独立 cookie；两套权限边界不得混用。

import { json, error } from './headers.js';

const USER_COOKIE = '__Host-krkr2_user';
const OAUTH_COOKIE_PREFIX = '__Host-krkr2_oauth_';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_TTL_SECONDS = 10 * 60;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class AccountAuthError extends Error {
    constructor(code, message = code) {
        super(message);
        this.code = code;
    }
}

function b64urlEncode(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(value) {
    let input = value.replace(/-/g, '+').replace(/_/g, '/');
    while (input.length % 4) input += '=';
    const binary = atob(input);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function randomToken(byteLength = 32) {
    return b64urlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function sha256(value) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function hmac(value, secret) {
    const key = await crypto.subtle.importKey(
        'raw', encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false, ['sign']
    );
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

function readCookie(request, name) {
    const header = request.headers.get('Cookie') || '';
    for (const part of header.split(';')) {
        const index = part.indexOf('=');
        if (index < 0) continue;
        if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
    }
    return null;
}

function userCookie(token, maxAge = Math.floor(SESSION_TTL_MS / 1000)) {
    return `${USER_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function clearUserCookie() {
    return userCookie('', 0);
}

function oauthCookie(provider, token, maxAge = OAUTH_TTL_SECONDS) {
    return `${OAUTH_COOKIE_PREFIX}${provider}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function clearOAuthCookie(provider) {
    return oauthCookie(provider, '', 0);
}

function sanitizeReturnTo(value) {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
    try {
        const parsed = new URL(value, 'https://krkr2.invalid');
        if (parsed.origin !== 'https://krkr2.invalid') return '/';
        return parsed.pathname + parsed.search + parsed.hash;
    } catch {
        return '/';
    }
}

function publicOrigin(request, env) {
    if (env.PUBLIC_ORIGIN) {
        try {
            const configured = new URL(env.PUBLIC_ORIGIN);
            return configured.origin;
        } catch {
            // 配错时回落当前同源，避免把 OAuth 回调跳到一个畸形地址。
        }
    }
    return new URL(request.url).origin;
}

function redirect(location, cookies = []) {
    const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
    for (const cookie of cookies) headers.append('Set-Cookie', cookie);
    return new Response(null, { status: 302, headers });
}

function redirectResult(request, env, returnTo, errorCode = '') {
    const target = new URL(sanitizeReturnTo(returnTo), publicOrigin(request, env));
    if (errorCode) target.searchParams.set('authError', errorCode);
    else target.searchParams.set('authSuccess', '1');
    return target.toString();
}

async function createState(env, provider, returnTo, linkUserId, extra = {}) {
    const payload = {
        provider,
        returnTo: sanitizeReturnTo(returnTo),
        linkUserId: linkUserId || null,
        nonce: randomToken(18),
        exp: Math.floor(Date.now() / 1000) + OAUTH_TTL_SECONDS,
        ...extra
    };
    const encoded = b64urlEncode(encoder.encode(JSON.stringify(payload)));
    return `${encoded}.${b64urlEncode(await hmac(encoded, env.SESSION_SECRET))}`;
}

async function verifyState(request, env, provider, supplied) {
    const cookie = readCookie(request, `${OAUTH_COOKIE_PREFIX}${provider}`);
    if (!supplied || !cookie || supplied !== cookie) {
        throw new AccountAuthError('state_mismatch');
    }

    const dot = supplied.lastIndexOf('.');
    if (dot < 1) throw new AccountAuthError('state_invalid');
    const encoded = supplied.slice(0, dot);
    const signature = supplied.slice(dot + 1);
    const expected = await hmac(encoded, env.SESSION_SECRET);

    let actual;
    try {
        actual = b64urlDecode(signature);
    } catch {
        throw new AccountAuthError('state_invalid');
    }
    if (!timingSafeEqual(expected, actual)) throw new AccountAuthError('state_invalid');

    let payload;
    try {
        payload = JSON.parse(decoder.decode(b64urlDecode(encoded)));
    } catch {
        throw new AccountAuthError('state_invalid');
    }
    if (payload.provider !== provider || payload.exp < Math.floor(Date.now() / 1000)) {
        throw new AccountAuthError('state_expired');
    }
    payload.returnTo = sanitizeReturnTo(payload.returnTo);
    return payload;
}

function cleanProfile(profile) {
    const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
    return {
        provider: profile.provider,
        subject: String(profile.subject),
        login: text(profile.login, 160),
        displayName: text(profile.displayName, 160) || `${profile.provider} 用户`,
        avatarUrl: text(profile.avatarUrl, 2000)
    };
}

function rowToUser(row, providers = []) {
    return {
        id: row.id,
        displayName: row.display_name,
        providers
    };
}

async function getIdentity(db, provider, subject) {
    return db.prepare(
        `SELECT i.*, u.display_name AS user_display_name
         FROM auth_identities i JOIN users u ON u.id = i.user_id
         WHERE i.provider = ? AND i.provider_subject = ?`
    ).bind(provider, subject).first();
}

async function getUserProviderIdentity(db, userId, provider) {
    return db.prepare(
        'SELECT * FROM auth_identities WHERE user_id = ? AND provider = ?'
    ).bind(userId, provider).first();
}

async function updateKnownIdentity(db, identity, profile, now) {
    await db.batch([
        db.prepare(
            `UPDATE auth_identities SET provider_login = ?, display_name = ?, avatar_url = ?,
             updated_at = ? WHERE provider = ? AND provider_subject = ?`
        ).bind(
            profile.login, profile.displayName, profile.avatarUrl, now,
            profile.provider, profile.subject
        ),
        db.prepare(
            `UPDATE users SET display_name = ?, avatar_url = ?, updated_at = ?, last_login_at = ?
             WHERE id = ?`
        ).bind(profile.displayName, profile.avatarUrl, now, now, identity.user_id)
    ]);
    return identity.user_id;
}

async function resolveIdentity(db, rawProfile, linkUserId = null) {
    const profile = cleanProfile(rawProfile);
    const now = Date.now();
    const existing = await getIdentity(db, profile.provider, profile.subject);

    if (linkUserId) {
        if (existing && existing.user_id !== linkUserId) {
            throw new AccountAuthError('identity_in_use');
        }
        const linked = await getUserProviderIdentity(db, linkUserId, profile.provider);
        if (linked && linked.provider_subject !== profile.subject) {
            throw new AccountAuthError('provider_already_linked');
        }
        if (!existing) {
            await db.prepare(
                `INSERT INTO auth_identities
                 (provider, provider_subject, user_id, provider_login, display_name, avatar_url,
                  created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
                profile.provider, profile.subject, linkUserId, profile.login,
                profile.displayName, profile.avatarUrl, now, now
            ).run();
        } else {
            await db.prepare(
                `UPDATE auth_identities SET provider_login = ?, display_name = ?, avatar_url = ?,
                 updated_at = ? WHERE provider = ? AND provider_subject = ?`
            ).bind(
                profile.login, profile.displayName, profile.avatarUrl, now,
                profile.provider, profile.subject
            ).run();
        }
        await db.prepare(
            'UPDATE users SET updated_at = ?, last_login_at = ? WHERE id = ?'
        ).bind(now, now, linkUserId).run();
        return linkUserId;
    }

    if (existing) return updateKnownIdentity(db, existing, profile, now);

    const userId = `user_${crypto.randomUUID()}`;
    try {
        await db.batch([
            db.prepare(
                `INSERT INTO users
                 (id, display_name, avatar_url, created_at, updated_at, last_login_at)
                 VALUES (?, ?, ?, ?, ?, ?)`
            ).bind(userId, profile.displayName, profile.avatarUrl, now, now, now),
            db.prepare(
                `INSERT INTO auth_identities
                 (provider, provider_subject, user_id, provider_login, display_name, avatar_url,
                  created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
                profile.provider, profile.subject, userId, profile.login,
                profile.displayName, profile.avatarUrl, now, now
            )
        ]);
        return userId;
    } catch (err) {
        // 两个回调并发落同一平台账号时，唯一约束只允许一个获胜。
        const raced = await getIdentity(db, profile.provider, profile.subject);
        if (raced) return updateKnownIdentity(db, raced, profile, now);
        throw err;
    }
}

async function createSession(db, userId) {
    const token = randomToken(32);
    const tokenHash = b64urlEncode(await sha256(token));
    const now = Date.now();
    await db.prepare(
        `INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`
    ).bind(tokenHash, userId, now, now + SESSION_TTL_MS, now).run();
    return token;
}

async function readSession(request, db) {
    const token = readCookie(request, USER_COOKIE);
    if (!token) return null;
    const tokenHash = b64urlEncode(await sha256(token));
    const now = Date.now();
    const row = await db.prepare(
        `SELECT s.token_hash, s.expires_at, s.last_seen_at,
                u.id, u.display_name, u.avatar_url
         FROM user_sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`
    ).bind(tokenHash).first();
    if (!row) return null;
    if (row.expires_at <= now) {
        await db.prepare('DELETE FROM user_sessions WHERE token_hash = ?').bind(tokenHash).run();
        return null;
    }

    const identities = await db.prepare(
        'SELECT provider FROM auth_identities WHERE user_id = ? ORDER BY provider'
    ).bind(row.id).all();
    return {
        tokenHash,
        user: rowToUser(row, (identities.results || []).map((item) => item.provider)),
        lastSeenAt: row.last_seen_at
    };
}

async function touchSession(db, session) {
    if (!session || Date.now() - session.lastSeenAt < 60 * 60 * 1000) return;
    await db.prepare(
        'UPDATE user_sessions SET last_seen_at = ? WHERE token_hash = ?'
    ).bind(Date.now(), session.tokenHash).run();
}

async function startGitHub(request, env, session) {
    if (!env.SESSION_SECRET || !env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
        return error(503, 'GitHub 登录尚未配置');
    }
    const url = new URL(request.url);
    const link = url.searchParams.get('link') === '1';
    if (link && !session) return error(401, '请先登录再绑定账号');

    const verifier = randomToken(32);
    const challenge = b64urlEncode(await sha256(verifier));
    const state = await createState(
        env, 'github', url.searchParams.get('returnTo'),
        link ? session.user.id : null,
        { verifier }
    );
    const callback = `${publicOrigin(request, env)}/api/account/callback/github`;
    const authorize = new URL('https://github.com/login/oauth/authorize');
    authorize.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
    authorize.searchParams.set('redirect_uri', callback);
    authorize.searchParams.set('scope', 'read:user');
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    return redirect(authorize.toString(), [oauthCookie('github', state)]);
}

async function githubProfile(request, env, state) {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    if (!code) throw new AccountAuthError('provider_denied');

    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            client_id: env.GITHUB_CLIENT_ID,
            client_secret: env.GITHUB_CLIENT_SECRET,
            code,
            redirect_uri: `${publicOrigin(request, env)}/api/account/callback/github`,
            code_verifier: state.verifier
        })
    });
    const tokenData = await tokenResponse.json().catch(() => null);
    if (!tokenResponse.ok || !tokenData?.access_token) {
        throw new AccountAuthError('provider_exchange_failed');
    }

    const profileResponse = await fetch('https://api.github.com/user', {
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${tokenData.access_token}`,
            'User-Agent': 'krkr2-web'
        }
    });
    const profile = await profileResponse.json().catch(() => null);
    if (!profileResponse.ok || profile?.id === undefined) {
        throw new AccountAuthError('provider_profile_failed');
    }
    return {
        provider: 'github',
        subject: profile.id,
        login: profile.login || '',
        displayName: profile.name || profile.login || 'GitHub 用户',
        avatarUrl: profile.avatar_url || ''
    };
}

async function startSteam(request, env, session) {
    if (!env.SESSION_SECRET) return error(503, '玩家登录尚未配置');
    const url = new URL(request.url);
    const link = url.searchParams.get('link') === '1';
    if (link && !session) return error(401, '请先登录再绑定账号');

    const state = await createState(
        env, 'steam', url.searchParams.get('returnTo'), link ? session.user.id : null
    );
    const origin = publicOrigin(request, env);
    const returnTo = new URL('/api/account/callback/steam', origin);
    returnTo.searchParams.set('state', state);

    const authorize = new URL('https://steamcommunity.com/openid/login');
    authorize.searchParams.set('openid.ns', 'http://specs.openid.net/auth/2.0');
    authorize.searchParams.set('openid.mode', 'checkid_setup');
    authorize.searchParams.set('openid.return_to', returnTo.toString());
    authorize.searchParams.set('openid.realm', origin);
    authorize.searchParams.set('openid.identity', 'http://specs.openid.net/auth/2.0/identifier_select');
    authorize.searchParams.set('openid.claimed_id', 'http://specs.openid.net/auth/2.0/identifier_select');
    return redirect(authorize.toString(), [oauthCookie('steam', state)]);
}

async function steamProfile(request, env) {
    const callback = new URL(request.url);
    const verification = new URLSearchParams();
    for (const [key, value] of callback.searchParams) {
        if (key.startsWith('openid.')) verification.set(key, value);
    }
    verification.set('openid.mode', 'check_authentication');

    const response = await fetch('https://steamcommunity.com/openid/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: verification
    });
    const result = await response.text();
    if (!response.ok || !/(?:^|\n)is_valid:true(?:\n|$)/.test(result)) {
        throw new AccountAuthError('provider_verification_failed');
    }

    const claimed = callback.searchParams.get('openid.claimed_id') || '';
    const match = claimed.match(/^https?:\/\/steamcommunity\.com\/openid\/id\/(\d+)$/);
    if (!match) throw new AccountAuthError('provider_profile_failed');
    const steamId = match[1];

    let player = null;
    if (env.STEAM_WEB_API_KEY) {
        const profileUrl = new URL('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/');
        profileUrl.searchParams.set('key', env.STEAM_WEB_API_KEY);
        profileUrl.searchParams.set('steamids', steamId);
        try {
            const profileResponse = await fetch(profileUrl);
            const profileData = await profileResponse.json();
            player = profileData?.response?.players?.[0] || null;
        } catch {
            // Web API key 只用来补昵称/头像；失败不能影响已经验证成功的 OpenID 登录。
        }
    }
    return {
        provider: 'steam',
        subject: steamId,
        login: steamId,
        displayName: player?.personaname || `Steam 用户 ${steamId.slice(-6)}`,
        avatarUrl: player?.avatarmedium || ''
    };
}

async function finishCallback(request, env, provider) {
    let state = null;
    try {
        const url = new URL(request.url);
        state = await verifyState(request, env, provider, url.searchParams.get('state'));
        const profile = provider === 'github'
            ? await githubProfile(request, env, state)
            : await steamProfile(request, env);
        const userId = await resolveIdentity(env.DB, profile, state.linkUserId);
        const token = await createSession(env.DB, userId);
        return redirect(
            redirectResult(request, env, state.returnTo),
            [clearOAuthCookie(provider), userCookie(token)]
        );
    } catch (err) {
        console.error(`[account] ${provider} callback failed:`, err?.stack || err);
        const code = err instanceof AccountAuthError ? err.code : 'login_failed';
        return redirect(
            redirectResult(request, env, state?.returnTo || '/', code),
            [clearOAuthCookie(provider)]
        );
    }
}

async function handleMe(request, env, ctx) {
    const session = await readSession(request, env.DB);
    if (session) ctx.waitUntil(touchSession(env.DB, session));
    return json({
        user: session?.user || null,
        availableProviders: {
            steam: !!env.SESSION_SECRET,
            github: !!(env.SESSION_SECRET && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET)
        }
    });
}

async function handleLogout(request, env) {
    const session = await readSession(request, env.DB);
    if (session) {
        await env.DB.prepare('DELETE FROM user_sessions WHERE token_hash = ?')
            .bind(session.tokenHash).run();
    }
    return json({ ok: true }, { headers: { 'Set-Cookie': clearUserCookie() } });
}

export async function handleAccount(request, env, ctx, segments) {
    const [action, provider] = segments;
    const method = request.method;

    if (action === 'me' && method === 'GET') return handleMe(request, env, ctx);
    if (action === 'logout' && method === 'POST') return handleLogout(request, env);

    if (action === 'login' && method === 'GET') {
        const session = await readSession(request, env.DB);
        if (provider === 'github') return startGitHub(request, env, session);
        if (provider === 'steam') return startSteam(request, env, session);
        return error(404, 'Unknown login provider');
    }

    if (action === 'callback' && method === 'GET') {
        if (provider === 'github' || provider === 'steam') {
            return finishCallback(request, env, provider);
        }
        return error(404, 'Unknown login provider');
    }

    return error(404, 'Unknown account endpoint');
}
