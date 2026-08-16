// 玩家账号认证：GitHub OAuth + PKCE、Steam OpenID 2.0、可撤销 D1 session。
//
// 管理员后台继续使用 auth.js 的密码与独立 cookie；两套权限边界不得混用。

import { json, error } from './headers.js';
import { hashPassword, verifyPassword } from './auth.js';

const USER_COOKIE = '__Host-krkr2_user';
const OAUTH_COOKIE_PREFIX = '__Host-krkr2_oauth_';
const LOCAL_GRANT_COOKIE = '__Host-krkr2_local_grant';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_TTL_SECONDS = 10 * 60;
const OAUTH_STATE_SIGNATURE_CONTEXT = 'oauth-state:v1:';
const LOCAL_GRANT_TTL_MS = 10 * 60 * 1000;
const LOCAL_LOGIN_RATE_WINDOW_SECONDS = 15 * 60;
const LOCAL_LOGIN_ACCOUNT_MAX_ATTEMPTS = 5;
const LOCAL_LOGIN_IP_MAX_ATTEMPTS = 20;
const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 32;
const PASSWORD_MAX_LENGTH = 128;
const STEAM_OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';
const OPENID2_NAMESPACE = 'http://specs.openid.net/auth/2.0';
const OPENID2_IDENTIFIER_SELECT = `${OPENID2_NAMESPACE}/identifier_select`;
const STEAM_REQUIRED_SIGNED_FIELDS = [
    'op_endpoint', 'return_to', 'response_nonce', 'assoc_handle', 'claimed_id', 'identity'
];
// 不存在的登录名也走一次同成本 PBKDF2，避免用响应时间枚举本站登录名。
const DUMMY_PASSWORD_HASH =
    'pbkdf2$100000$rqo4S8TlmSw6d+nrE8yy1A==$b+xmKbP8Vst9pxsWkGMhzSqR39JF4ovqEEY3a3qQ23w=';

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

function localGrantCookie(token, maxAge = Math.floor(LOCAL_GRANT_TTL_MS / 1000)) {
    return `${LOCAL_GRANT_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function clearLocalGrantCookie() {
    return localGrantCookie('', 0);
}

function jsonWithCookies(data, cookies, status = 200) {
    const response = json(data, { status });
    const headers = new Headers(response.headers);
    for (const cookie of cookies) headers.append('Set-Cookie', cookie);
    return new Response(response.body, { status: response.status, headers });
}

function accountError(status, code, message, headers = {}) {
    return json({ error: message, code }, { status, headers });
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

function sameOriginMutation(request) {
    return request.headers.get('Origin') === new URL(request.url).origin;
}

function redirect(location, cookies = []) {
    const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
    for (const cookie of cookies) headers.append('Set-Cookie', cookie);
    return new Response(null, { status: 302, headers });
}

function redirectResult(request, env, returnTo, errorCode = '', grantPurpose = '') {
    const target = new URL(sanitizeReturnTo(returnTo), publicOrigin(request, env));
    if (errorCode) target.searchParams.set('authError', errorCode);
    else target.searchParams.set('authSuccess', '1');
    if (grantPurpose) {
        target.searchParams.set('localGrant', '1');
        target.searchParams.set('localGrantPurpose', grantPurpose);
    }
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
    const signature = await hmac(
        `${OAUTH_STATE_SIGNATURE_CONTEXT}${encoded}`, env.SESSION_SECRET
    );
    return `${encoded}.${b64urlEncode(signature)}`;
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
    const expected = await hmac(
        `${OAUTH_STATE_SIGNATURE_CONTEXT}${encoded}`, env.SESSION_SECRET
    );

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
        avatarUrl: row.avatar_url || '',
        hidePlaytime: !!row.hide_playtime,
        providers
    };
}

function normalizeUsername(value) {
    if (typeof value !== 'string') return null;
    const username = value.trim().normalize('NFKC');
    const length = Array.from(username).length;
    if (length < USERNAME_MIN_LENGTH || length > USERNAME_MAX_LENGTH) return null;
    if (!/^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u.test(username)) return null;
    return { username, normalized: username.toLowerCase() };
}

function validPassword(value) {
    return typeof value === 'string' &&
        value.length > 0 && value.length <= PASSWORD_MAX_LENGTH;
}

async function getLocalCredential(db, userId) {
    return db.prepare(
        `SELECT user_id, username, username_normalized, password_hash, created_at, updated_at
         FROM local_credentials WHERE user_id = ?`
    ).bind(userId).first();
}

function localLoginSummary(credential, shouldPrompt = false) {
    return {
        configured: !!credential,
        username: credential?.username || '',
        shouldPrompt: !credential && !!shouldPrompt
    };
}

async function getLocalLoginForUser(db, userId) {
    const row = await db.prepare(
        `SELECT u.local_login_prompted_at, c.user_id, c.username
         FROM users u LEFT JOIN local_credentials c ON c.user_id = u.id
         WHERE u.id = ?`
    ).bind(userId).first();
    if (!row) return localLoginSummary(null);
    const credential = row.user_id ? row : null;
    return localLoginSummary(credential, row.local_login_prompted_at === null);
}

async function createLocalGrant(db, userId, purpose, provider, sessionTokenHash = null) {
    const token = randomToken(32);
    const tokenHash = b64urlEncode(await sha256(token));
    const now = Date.now();
    await db.batch([
        db.prepare('DELETE FROM local_auth_grants WHERE user_id = ? OR expires_at <= ?')
            .bind(userId, now),
        db.prepare(
            `INSERT INTO local_auth_grants
             (token_hash, user_id, purpose, provider, session_token_hash, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(
            tokenHash, userId, purpose, provider, sessionTokenHash,
            now, now + LOCAL_GRANT_TTL_MS
        )
    ]);
    return token;
}

async function readLocalGrant(request, db) {
    const token = readCookie(request, LOCAL_GRANT_COOKIE);
    if (!token) return null;
    const tokenHash = b64urlEncode(await sha256(token));
    const row = await db.prepare(
        `SELECT token_hash, user_id, purpose, provider, session_token_hash, expires_at
         FROM local_auth_grants WHERE token_hash = ?`
    ).bind(tokenHash).first();
    if (!row || row.expires_at <= Date.now()) return null;
    return row;
}

async function consumeLocalGrant(db, tokenHash) {
    const result = await db.prepare(
        `DELETE FROM local_auth_grants
         WHERE token_hash = ? AND expires_at > ?
         RETURNING user_id, purpose, provider, session_token_hash`
    ).bind(tokenHash, Date.now()).first();
    return result || null;
}

async function discardLocalGrant(request, db) {
    const grant = await readLocalGrant(request, db);
    if (grant) await consumeLocalGrant(db, grant.token_hash);
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

async function linkIdentityWithSession(db, rawProfile, userId, sessionTokenHash) {
    const profile = cleanProfile(rawProfile);
    const now = Date.now();
    const existing = await getIdentity(db, profile.provider, profile.subject);
    if (existing && existing.user_id !== userId) {
        throw new AccountAuthError('identity_in_use');
    }
    const linked = await getUserProviderIdentity(db, userId, profile.provider);
    if (linked && linked.provider_subject !== profile.subject) {
        throw new AccountAuthError('provider_already_linked');
    }

    const validSession =
        `EXISTS (SELECT 1 FROM user_sessions s
                 WHERE s.token_hash = ? AND s.user_id = ? AND s.expires_at > ?)`;
    const mutation = existing
        ? db.prepare(
            `UPDATE auth_identities SET
               provider_login = ?, display_name = ?, avatar_url = ?, updated_at = ?
             WHERE provider = ? AND provider_subject = ? AND user_id = ?
               AND ${validSession}`
        ).bind(
            profile.login, profile.displayName, profile.avatarUrl, now,
            profile.provider, profile.subject, userId,
            sessionTokenHash, userId, now
        )
        : db.prepare(
            `INSERT INTO auth_identities
             (provider, provider_subject, user_id, provider_login, display_name, avatar_url,
              created_at, updated_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?
             WHERE ${validSession}
             ON CONFLICT DO NOTHING`
        ).bind(
            profile.provider, profile.subject, userId, profile.login,
            profile.displayName, profile.avatarUrl, now, now,
            sessionTokenHash, userId, now
        );
    const results = await db.batch([
        mutation,
        db.prepare(
            `UPDATE users SET updated_at = ?, last_login_at = ?
             WHERE id = ? AND ${validSession}
               AND EXISTS (
                 SELECT 1 FROM auth_identities i
                 WHERE i.provider = ? AND i.provider_subject = ? AND i.user_id = ?
               )`
        ).bind(
            now, now, userId,
            sessionTokenHash, userId, now,
            profile.provider, profile.subject, userId
        )
    ]);
    if (results[0].meta?.changes === 1) return userId;

    const session = await db.prepare(
        `SELECT token_hash FROM user_sessions
         WHERE token_hash = ? AND user_id = ? AND expires_at > ?`
    ).bind(sessionTokenHash, userId, Date.now()).first();
    if (!session) throw new AccountAuthError('link_session_expired');
    const racedIdentity = await getIdentity(db, profile.provider, profile.subject);
    if (racedIdentity && racedIdentity.user_id !== userId) {
        throw new AccountAuthError('identity_in_use');
    }
    const racedProvider = await getUserProviderIdentity(db, userId, profile.provider);
    if (racedProvider && racedProvider.provider_subject !== profile.subject) {
        throw new AccountAuthError('provider_already_linked');
    }
    if (racedIdentity?.user_id === userId &&
        racedProvider?.provider_subject === profile.subject) {
        return userId;
    }
    throw new AccountAuthError('link_failed');
}

async function resolveIdentity(db, rawProfile) {
    const profile = cleanProfile(rawProfile);
    const now = Date.now();
    const existing = await getIdentity(db, profile.provider, profile.subject);

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
                u.id, u.display_name, u.avatar_url, u.hide_playtime
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

/** 供账号私有 API 复用；返回已验证且未过期的玩家 session。 */
export function getAccountSession(request, env) {
    return readSession(request, env.DB);
}

async function touchSession(db, session) {
    if (!session || Date.now() - session.lastSeenAt < 60 * 60 * 1000) return;
    await db.prepare(
        'UPDATE user_sessions SET last_seen_at = ? WHERE token_hash = ?'
    ).bind(Date.now(), session.tokenHash).run();
}

function oauthPurpose(url) {
    if (url.searchParams.get('link') === '1') return 'link';
    const purpose = url.searchParams.get('purpose') || 'login';
    return ['login', 'reauth', 'reset'].includes(purpose) ? purpose : null;
}

async function oauthSessionBinding(env, tokenHash) {
    return b64urlEncode(await hmac(`oauth-session:${tokenHash}`, env.SESSION_SECRET));
}

async function verifyLinkSession(request, env, state) {
    const session = await readSession(request, env.DB);
    if (!session || session.user.id !== state.linkUserId || !state.sessionBinding) {
        throw new AccountAuthError('link_session_expired');
    }
    const expected = await oauthSessionBinding(env, session.tokenHash);
    if (!timingSafeEqual(encoder.encode(expected), encoder.encode(state.sessionBinding))) {
        throw new AccountAuthError('link_session_expired');
    }
    return session;
}

async function startGitHub(request, env, session) {
    if (!env.SESSION_SECRET || !env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
        return error(503, 'GitHub 登录尚未配置');
    }
    const url = new URL(request.url);
    const purpose = oauthPurpose(url);
    if (!purpose) return accountError(400, 'invalid_purpose', '无效的认证用途');
    if ((purpose === 'link' || purpose === 'reauth') && !session) {
        return accountError(401, 'not_logged_in', '请先登录');
    }

    const verifier = randomToken(32);
    const challenge = b64urlEncode(await sha256(verifier));
    const state = await createState(
        env, 'github', url.searchParams.get('returnTo'),
        purpose === 'link' ? session.user.id : null,
        {
            verifier,
            purpose,
            targetUserId: purpose === 'reauth' ? session.user.id : null,
            sessionBinding: purpose === 'link'
                ? await oauthSessionBinding(env, session.tokenHash)
                : null
        }
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
    const purpose = oauthPurpose(url);
    if (!purpose) return accountError(400, 'invalid_purpose', '无效的认证用途');
    if ((purpose === 'link' || purpose === 'reauth') && !session) {
        return accountError(401, 'not_logged_in', '请先登录');
    }

    const state = await createState(
        env, 'steam', url.searchParams.get('returnTo'),
        purpose === 'link' ? session.user.id : null,
        {
            purpose,
            targetUserId: purpose === 'reauth' ? session.user.id : null,
            sessionBinding: purpose === 'link'
                ? await oauthSessionBinding(env, session.tokenHash)
                : null
        }
    );
    const origin = publicOrigin(request, env);
    const returnTo = new URL('/api/account/callback/steam', origin);
    returnTo.searchParams.set('state', state);

    const authorize = new URL(STEAM_OPENID_ENDPOINT);
    authorize.searchParams.set('openid.ns', OPENID2_NAMESPACE);
    authorize.searchParams.set('openid.mode', 'checkid_setup');
    authorize.searchParams.set('openid.return_to', returnTo.toString());
    authorize.searchParams.set('openid.realm', origin);
    authorize.searchParams.set('openid.identity', OPENID2_IDENTIFIER_SELECT);
    authorize.searchParams.set('openid.claimed_id', OPENID2_IDENTIFIER_SELECT);
    return redirect(authorize.toString(), [oauthCookie('steam', state)]);
}

function returnUrlMatchesRequest(returnTo, callback) {
    if (returnTo.protocol !== callback.protocol || returnTo.host !== callback.host ||
        returnTo.pathname !== callback.pathname) {
        return false;
    }

    const matchedCounts = new Map();
    for (const [key, value] of returnTo.searchParams) {
        const occurrence = matchedCounts.get(key) || 0;
        if (callback.searchParams.getAll(key)[occurrence] !== value) return false;
        matchedCounts.set(key, occurrence + 1);
    }
    return true;
}

/** OpenID 2.0 SS11 的本地断言检查；签名随后仍由 Steam 直接验证。 */
export function validateSteamAssertion(request, env) {
    const callback = new URL(request.url);
    const assertion = new Map();
    for (const [key, value] of callback.searchParams) {
        if (!key.startsWith('openid.')) continue;
        if (assertion.has(key)) throw new AccountAuthError('provider_assertion_invalid');
        assertion.set(key, value);
    }

    const required = [
        'openid.ns', 'openid.mode', 'openid.op_endpoint', 'openid.claimed_id',
        'openid.identity', 'openid.return_to', 'openid.response_nonce',
        'openid.assoc_handle', 'openid.signed', 'openid.sig'
    ];
    if (required.some((key) => !assertion.get(key))) {
        throw new AccountAuthError('provider_assertion_invalid');
    }
    if (assertion.get('openid.ns') !== OPENID2_NAMESPACE ||
        assertion.get('openid.mode') !== 'id_res' ||
        assertion.get('openid.op_endpoint') !== STEAM_OPENID_ENDPOINT) {
        throw new AccountAuthError('provider_assertion_invalid');
    }

    const stateValues = callback.searchParams.getAll('state');
    if (stateValues.length !== 1) throw new AccountAuthError('provider_assertion_invalid');
    const expectedReturnTo = new URL('/api/account/callback/steam', publicOrigin(request, env));
    expectedReturnTo.searchParams.set('state', stateValues[0]);

    let assertedReturnTo;
    try {
        assertedReturnTo = new URL(assertion.get('openid.return_to'));
    } catch {
        throw new AccountAuthError('provider_assertion_invalid');
    }
    if (assertedReturnTo.toString() !== expectedReturnTo.toString() ||
        !returnUrlMatchesRequest(assertedReturnTo, callback)) {
        throw new AccountAuthError('provider_assertion_invalid');
    }

    const signedFields = assertion.get('openid.signed').split(',');
    const signed = new Set(signedFields);
    if (signed.size !== signedFields.length ||
        STEAM_REQUIRED_SIGNED_FIELDS.some((field) => !signed.has(field))) {
        throw new AccountAuthError('provider_assertion_invalid');
    }

    const nonce = assertion.get('openid.response_nonce');
    if (nonce.length > 255 ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z[\x21-\x7e]*$/.test(nonce)) {
        throw new AccountAuthError('provider_assertion_invalid');
    }

    const claimed = assertion.get('openid.claimed_id');
    if (assertion.get('openid.identity') !== claimed) {
        throw new AccountAuthError('provider_assertion_invalid');
    }
    const match = claimed.match(/^https?:\/\/steamcommunity\.com\/openid\/id\/(\d+)$/);
    if (!match) throw new AccountAuthError('provider_profile_failed');

    return { callback, steamId: match[1] };
}

async function steamProfile(request, env) {
    const { callback, steamId } = validateSteamAssertion(request, env);
    const verification = new URLSearchParams();
    for (const [key, value] of callback.searchParams) {
        if (key.startsWith('openid.')) verification.set(key, value);
    }
    verification.set('openid.mode', 'check_authentication');

    const response = await fetch(STEAM_OPENID_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: verification
    });
    const result = await response.text();
    if (!response.ok || !/(?:^|\n)is_valid:true(?:\n|$)/.test(result)) {
        throw new AccountAuthError('provider_verification_failed');
    }

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
        const purpose = state.purpose || (state.linkUserId ? 'link' : 'login');
        const linkSession = purpose === 'link'
            ? await verifyLinkSession(request, env, state)
            : null;
        const profile = provider === 'github'
            ? await githubProfile(request, env, state)
            : await steamProfile(request, env);
        let userId;
        let sessionToken = null;
        let grantToken = null;
        let grantPurpose = '';

        if (purpose === 'reauth') {
            const session = await readSession(request, env.DB);
            if (!session || session.user.id !== state.targetUserId) {
                throw new AccountAuthError('reauth_session_expired');
            }
            const identity = await getIdentity(env.DB, profile.provider, String(profile.subject));
            if (!identity || identity.user_id !== state.targetUserId) {
                throw new AccountAuthError('identity_mismatch');
            }
            userId = await updateKnownIdentity(env.DB, identity, cleanProfile(profile), Date.now());
            grantPurpose = 'reauth';
            grantToken = await createLocalGrant(
                env.DB, userId, grantPurpose, provider, session.tokenHash
            );
        } else if (purpose === 'reset') {
            const identity = await getIdentity(env.DB, profile.provider, String(profile.subject));
            if (!identity) throw new AccountAuthError('identity_not_found');
            userId = await updateKnownIdentity(env.DB, identity, cleanProfile(profile), Date.now());
            grantPurpose = 'reset';
            grantToken = await createLocalGrant(env.DB, userId, grantPurpose, provider);
        } else if (purpose === 'link') {
            userId = await linkIdentityWithSession(
                env.DB, profile, state.linkUserId, linkSession.tokenHash
            );
        } else {
            userId = await resolveIdentity(env.DB, profile);
            sessionToken = await createSession(env.DB, userId);
            if (purpose === 'login') {
                const localLogin = await getLocalLoginForUser(env.DB, userId);
                if (localLogin.shouldPrompt) {
                    grantPurpose = 'setup';
                    const sessionTokenHash = b64urlEncode(await sha256(sessionToken));
                    grantToken = await createLocalGrant(
                        env.DB, userId, grantPurpose, provider, sessionTokenHash
                    );
                }
            }
        }

        const cookies = [clearOAuthCookie(provider)];
        if (sessionToken) cookies.push(userCookie(sessionToken));
        cookies.push(grantToken ? localGrantCookie(grantToken) : clearLocalGrantCookie());
        return redirect(
            redirectResult(request, env, state.returnTo, '', grantPurpose),
            cookies
        );
    } catch (err) {
        console.error(`[account] ${provider} callback failed:`, err?.stack || err);
        const code = err instanceof AccountAuthError ? err.code : 'login_failed';
        return redirect(
            redirectResult(request, env, state?.returnTo || '/', code),
            [clearOAuthCookie(provider), clearLocalGrantCookie()]
        );
    }
}

async function getAccountSnapshot(db, userId) {
    const row = await db.prepare(
        `SELECT id, display_name, avatar_url, hide_playtime
         FROM users WHERE id = ?`
    ).bind(userId).first();
    if (!row) return null;
    const identities = await db.prepare(
        'SELECT provider FROM auth_identities WHERE user_id = ? ORDER BY provider'
    ).bind(userId).all();
    return {
        user: rowToUser(row, (identities.results || []).map((item) => item.provider)),
        localLogin: await getLocalLoginForUser(db, userId)
    };
}

async function passwordRateKeys(request, accountIdentity) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const accountHash = b64urlEncode(await sha256(accountIdentity || '<invalid>'));
    return {
        ip: `local-auth:ip:${ip}`,
        account: `local-auth:account:${accountHash}`
    };
}

async function reservePasswordAttempt(db, request, accountIdentity) {
    const keys = await passwordRateKeys(request, accountIdentity);
    const now = Date.now();
    const expiresAt = now + LOCAL_LOGIN_RATE_WINDOW_SECONDS * 1000;
    const reserve = (key) => db.prepare(
        `INSERT INTO local_auth_rate_limits
         (bucket_key, attempts, window_started_at, expires_at)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(bucket_key) DO UPDATE SET attempts = attempts + 1
         RETURNING attempts, expires_at`
    ).bind(key, now, expiresAt);
    const [, ipResult, accountResult] = await db.batch([
        db.prepare('DELETE FROM local_auth_rate_limits WHERE expires_at <= ?').bind(now),
        reserve(keys.ip),
        reserve(keys.account)
    ]);
    const ipAttempts = Number(ipResult.results?.[0]?.attempts || 0);
    const accountAttempts = Number(accountResult.results?.[0]?.attempts || 0);
    return {
        keys,
        attempts: { ip: ipAttempts, account: accountAttempts },
        allowed: ipAttempts <= LOCAL_LOGIN_IP_MAX_ATTEMPTS &&
            accountAttempts <= LOCAL_LOGIN_ACCOUNT_MAX_ATTEMPTS
    };
}

async function releaseSuccessfulPasswordAttempt(db, rate) {
    const release = (key, reservedAttempts) => db.prepare(
        `UPDATE local_auth_rate_limits SET attempts = attempts - 1
         WHERE bucket_key = ? AND attempts = ?`
    ).bind(key, reservedAttempts);
    await db.batch([
        release(rate.keys.account, rate.attempts.account),
        release(rate.keys.ip, rate.attempts.ip),
        db.prepare(
            'DELETE FROM local_auth_rate_limits WHERE bucket_key = ? AND attempts <= 0'
        ).bind(rate.keys.account),
        db.prepare(
            'DELETE FROM local_auth_rate_limits WHERE bucket_key = ? AND attempts <= 0'
        ).bind(rate.keys.ip)
    ]);
}

async function readJsonBody(request) {
    try {
        return await request.json();
    } catch {
        return null;
    }
}

async function handleLocalLogin(request, env) {
    const body = await readJsonBody(request);
    if (!body) return accountError(400, 'invalid_json', '请求格式不正确');
    const username = normalizeUsername(body.username);
    const password = typeof body.password === 'string' ? body.password : '';
    const rate = await reservePasswordAttempt(
        env.DB, request, `login:${username?.normalized || '<invalid>'}`
    );
    if (!rate.allowed) {
        return accountError(429, 'rate_limited', '尝试次数过多，请稍后再试', {
            'Retry-After': String(LOCAL_LOGIN_RATE_WINDOW_SECONDS)
        });
    }
    if (!username || !password || password.length > PASSWORD_MAX_LENGTH) {
        return accountError(401, 'invalid_credentials', '登录名或密码错误');
    }

    const credential = await env.DB.prepare(
        `SELECT user_id, password_hash FROM local_credentials
         WHERE username_normalized = ?`
    ).bind(username.normalized).first();
    const passwordMatches = await verifyPassword(
        password, credential?.password_hash || DUMMY_PASSWORD_HASH
    );
    if (!credential || !passwordMatches) {
        return accountError(401, 'invalid_credentials', '登录名或密码错误');
    }

    const token = randomToken(32);
    const tokenHash = b64urlEncode(await sha256(token));
    const now = Date.now();
    const inserted = await env.DB.prepare(
        `INSERT INTO user_sessions
         (token_hash, user_id, created_at, expires_at, last_seen_at)
         SELECT ?, user_id, ?, ?, ? FROM local_credentials
         WHERE user_id = ? AND password_hash = ?`
    ).bind(
        tokenHash, now, now + SESSION_TTL_MS, now,
        credential.user_id, credential.password_hash
    ).run();
    if (inserted.meta?.changes !== 1) {
        return accountError(401, 'invalid_credentials', '登录名或密码错误');
    }

    await releaseSuccessfulPasswordAttempt(env.DB, rate);
    await env.DB.prepare(
        'UPDATE users SET updated_at = ?, last_login_at = ? WHERE id = ?'
    ).bind(now, now, credential.user_id).run();
    await discardLocalGrant(request, env.DB);
    const snapshot = await getAccountSnapshot(env.DB, credential.user_id);
    return jsonWithCookies(
        { ok: true, ...snapshot },
        [userCookie(token), clearLocalGrantCookie()]
    );
}

async function handleLocalPrompt(request, env) {
    const session = await readSession(request, env.DB);
    if (!session) return accountError(401, 'not_logged_in', '请先登录');
    const body = await readJsonBody(request);
    if (!body) return accountError(400, 'invalid_json', '请求格式不正确');
    if (body.dismissed !== true) {
        return accountError(400, 'invalid_prompt_state', '无效的提示状态');
    }
    await env.DB.prepare(
        'UPDATE users SET local_login_prompted_at = ?, updated_at = ? WHERE id = ?'
    ).bind(Date.now(), Date.now(), session.user.id).run();
    const grant = await readLocalGrant(request, env.DB);
    if (grant) await consumeLocalGrant(env.DB, grant.token_hash);
    return jsonWithCookies(
        {
            ok: true,
            localLogin: await getLocalLoginForUser(env.DB, session.user.id)
        },
        [clearLocalGrantCookie()]
    );
}

function localGrantError(code, message, status = 401) {
    return jsonWithCookies(
        { error: message, code },
        [clearLocalGrantCookie()],
        status
    );
}

async function handleLocalCredentials(request, env) {
    const body = await readJsonBody(request);
    if (!body) return accountError(400, 'invalid_json', '请求格式不正确');
    if (!validPassword(body.password)) {
        return accountError(
            400, 'invalid_password',
            `密码不能为空，且不能超过 ${PASSWORD_MAX_LENGTH} 个字符`
        );
    }

    const session = await readSession(request, env.DB);
    let userId = null;
    let credential = null;
    let pendingGrant = null;
    let passwordRate = null;
    let currentPasswordVerified = false;

    if (body.grant === true) {
        pendingGrant = await readLocalGrant(request, env.DB);
        if (!pendingGrant) return localGrantError('grant_invalid', '验证已失效，请重新验证');
        userId = pendingGrant.user_id;
        credential = await getLocalCredential(env.DB, userId);

        const sessionBound = session &&
            session.user.id === userId &&
            session.tokenHash === pendingGrant.session_token_hash;
        if (pendingGrant.purpose === 'setup') {
            if (credential) {
                return localGrantError('grant_scope_invalid', '该验证不能用于修改现有密码');
            }
            if (!sessionBound) {
                return localGrantError('grant_session_invalid', '登录状态已变化，请重新验证');
            }
        } else if (pendingGrant.purpose === 'reauth') {
            if (!sessionBound) {
                return localGrantError('grant_session_invalid', '登录状态已变化，请重新验证');
            }
        } else if (pendingGrant.purpose === 'reset') {
            if (!credential) {
                return localGrantError(
                    'credential_not_configured', '该账号尚未设置密码登录', 409
                );
            }
            if (session && session.user.id !== userId) {
                return localGrantError('grant_user_mismatch', '验证账号与当前账号不一致', 403);
            }
        } else {
            return localGrantError('grant_scope_invalid', '无效的验证用途');
        }
    } else if (typeof body.currentPassword === 'string') {
        if (!session) return accountError(401, 'not_logged_in', '请先登录');
        userId = session.user.id;
        credential = await getLocalCredential(env.DB, userId);
        if (!credential) {
            return accountError(409, 'credential_not_configured', '请先通过已绑定账号验证');
        }
        passwordRate = await reservePasswordAttempt(
            env.DB, request, `current:${session.user.id}`
        );
        if (!passwordRate.allowed) {
            return accountError(429, 'rate_limited', '尝试次数过多，请稍后再试', {
                'Retry-After': String(LOCAL_LOGIN_RATE_WINDOW_SECONDS)
            });
        }
        if (body.currentPassword.length > PASSWORD_MAX_LENGTH ||
            !(await verifyPassword(body.currentPassword, credential.password_hash))) {
            return accountError(401, 'current_password_invalid', '当前密码错误');
        }
        currentPasswordVerified = true;
    } else {
        return accountError(401, 'reauth_required', '请验证当前密码或已绑定账号');
    }

    let username;
    if (body.username === undefined && credential) {
        username = {
            username: credential.username,
            normalized: credential.username_normalized
        };
    } else {
        username = normalizeUsername(body.username);
    }
    if (!username) {
        if (currentPasswordVerified) {
            await releaseSuccessfulPasswordAttempt(env.DB, passwordRate);
        }
        return accountError(
            400, 'invalid_username',
            `登录名须为 ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} 个字符，` +
            '以字母或数字开头，只能包含字母、数字、下划线、点和连字符'
        );
    }

    const occupied = await env.DB.prepare(
        `SELECT user_id FROM local_credentials
         WHERE username_normalized = ? AND user_id <> ?`
    ).bind(username.normalized, userId).first();
    if (occupied) {
        if (currentPasswordVerified) {
            await releaseSuccessfulPasswordAttempt(env.DB, passwordRate);
        }
        return accountError(409, 'username_taken', '该登录名已被使用');
    }

    const now = Date.now();
    const passwordHash = await hashPassword(body.password);
    const token = randomToken(32);
    const tokenHash = b64urlEncode(await sha256(token));
    let mutation;

    if (!pendingGrant) {
        mutation = env.DB.prepare(
            `UPDATE local_credentials SET
               username = ?, username_normalized = ?, password_hash = ?, updated_at = ?
             WHERE user_id = ? AND password_hash = ?
               AND EXISTS (
                 SELECT 1 FROM user_sessions s
                 WHERE s.token_hash = ? AND s.user_id = ? AND s.expires_at > ?
               )`
        ).bind(
            username.username, username.normalized, passwordHash, now,
            userId, credential.password_hash,
            session.tokenHash, userId, now
        );
    } else if (credential) {
        mutation = env.DB.prepare(
            `UPDATE local_credentials SET
               username = ?, username_normalized = ?, password_hash = ?, updated_at = ?
             WHERE user_id = ? AND password_hash = ?
               AND EXISTS (
                 SELECT 1 FROM local_auth_grants g
                 LEFT JOIN user_sessions s ON s.token_hash = g.session_token_hash
                 WHERE g.token_hash = ? AND g.user_id = ? AND g.purpose = ?
                   AND g.expires_at > ?
                   AND (
                     (g.purpose = 'reset' AND g.session_token_hash IS NULL) OR
                     (g.purpose = 'reauth' AND g.session_token_hash = ?
                       AND s.user_id = g.user_id AND s.expires_at > ?)
                   )
               )`
        ).bind(
            username.username, username.normalized, passwordHash, now,
            userId, credential.password_hash,
            pendingGrant.token_hash, userId, pendingGrant.purpose, now,
            session?.tokenHash || '', now
        );
    } else {
        mutation = env.DB.prepare(
            `INSERT INTO local_credentials
             (user_id, username, username_normalized, password_hash, created_at, updated_at)
             SELECT ?, ?, ?, ?, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM local_auth_grants g
               JOIN user_sessions s ON s.token_hash = g.session_token_hash
               WHERE g.token_hash = ? AND g.user_id = ? AND g.purpose = ?
                 AND g.purpose IN ('setup', 'reauth') AND g.expires_at > ?
                 AND g.session_token_hash = ?
                 AND s.user_id = g.user_id AND s.expires_at > ?
             )
             ON CONFLICT(user_id) DO NOTHING`
        ).bind(
            userId, username.username, username.normalized, passwordHash, now, now,
            pendingGrant.token_hash, userId, pendingGrant.purpose, now,
            session?.tokenHash || '', now
        );
    }

    const credentialGuard =
        `EXISTS (SELECT 1 FROM local_credentials c
                 WHERE c.user_id = ? AND c.password_hash = ? AND c.updated_at = ?)`;
    const statements = [
        mutation,
        env.DB.prepare(
            `UPDATE users SET local_login_prompted_at = COALESCE(local_login_prompted_at, ?),
             updated_at = ? WHERE id = ? AND ${credentialGuard}`
        ).bind(now, now, userId, userId, passwordHash, now),
        env.DB.prepare(
            `DELETE FROM local_auth_grants WHERE user_id = ? AND ${credentialGuard}`
        ).bind(userId, userId, passwordHash, now),
        env.DB.prepare(
            `DELETE FROM user_sessions WHERE user_id = ? AND ${credentialGuard}`
        ).bind(userId, userId, passwordHash, now),
        env.DB.prepare(
            `INSERT INTO user_sessions
             (token_hash, user_id, created_at, expires_at, last_seen_at)
             SELECT ?, user_id, ?, ?, ? FROM local_credentials
             WHERE user_id = ? AND password_hash = ? AND updated_at = ?`
        ).bind(
            tokenHash, now, now + SESSION_TTL_MS, now,
            userId, passwordHash, now
        )
    ];
    if (passwordRate) {
        statements.push(
            env.DB.prepare(
                `UPDATE local_auth_rate_limits SET attempts = attempts - 1
                 WHERE bucket_key = ? AND attempts = ? AND ${credentialGuard}`
            ).bind(
                passwordRate.keys.account, passwordRate.attempts.account,
                userId, passwordHash, now
            ),
            env.DB.prepare(
                `UPDATE local_auth_rate_limits SET attempts = attempts - 1
                 WHERE bucket_key = ? AND attempts = ? AND ${credentialGuard}`
            ).bind(
                passwordRate.keys.ip, passwordRate.attempts.ip,
                userId, passwordHash, now
            ),
            env.DB.prepare(
                `DELETE FROM local_auth_rate_limits
                 WHERE bucket_key = ? AND attempts <= 0`
            ).bind(passwordRate.keys.account),
            env.DB.prepare(
                `DELETE FROM local_auth_rate_limits
                 WHERE bucket_key = ? AND attempts <= 0`
            ).bind(passwordRate.keys.ip)
        );
    }

    let results;
    try {
        results = await env.DB.batch(statements);
    } catch (err) {
        if (currentPasswordVerified) {
            await releaseSuccessfulPasswordAttempt(env.DB, passwordRate);
        }
        if (String(err?.message || err).includes('UNIQUE constraint failed')) {
            return pendingGrant
                ? localGrantError('username_taken', '该登录名已被使用', 409)
                : accountError(409, 'username_taken', '该登录名已被使用');
        }
        throw err;
    }

    if (results[0].meta?.changes !== 1) {
        return pendingGrant
            ? localGrantError('grant_invalid', '验证已失效，请重新验证')
            : accountError(409, 'authorization_stale', '登录状态已变化，请重试');
    }

    const snapshot = await getAccountSnapshot(env.DB, userId);
    return jsonWithCookies(
        { ok: true, ...snapshot },
        [userCookie(token), clearLocalGrantCookie()]
    );
}

async function handleMe(request, env, ctx) {
    const session = await readSession(request, env.DB);
    if (session) ctx.waitUntil(touchSession(env.DB, session));
    return json({
        user: session?.user || null,
        localLogin: session
            ? await getLocalLoginForUser(env.DB, session.user.id)
            : localLoginSummary(null),
        availableProviders: {
            steam: !!env.SESSION_SECRET,
            github: !!(env.SESSION_SECRET && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET)
        }
    });
}

async function handleLogout(request, env) {
    const session = await readSession(request, env.DB);
    await discardLocalGrant(request, env.DB);
    if (session) {
        await env.DB.prepare('DELETE FROM user_sessions WHERE token_hash = ?')
            .bind(session.tokenHash).run();
    }
    return jsonWithCookies(
        { ok: true },
        [clearUserCookie(), clearLocalGrantCookie()]
    );
}

export async function handleAccount(request, env, ctx, segments) {
    const [action, provider] = segments;
    const method = request.method;

    if (method === 'POST' && (action === 'logout' || action === 'local') &&
        !sameOriginMutation(request)) {
        return accountError(403, 'invalid_origin', '请求来源无效');
    }

    if (action === 'me' && method === 'GET') return handleMe(request, env, ctx);
    if (action === 'logout' && method === 'POST') return handleLogout(request, env);

    if (action === 'local' && method === 'POST') {
        if (provider === 'login') return handleLocalLogin(request, env);
        if (provider === 'prompt') return handleLocalPrompt(request, env);
        if (provider === 'credentials') return handleLocalCredentials(request, env);
        return error(404, 'Unknown local account endpoint');
    }

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
