// 前端 API 封装。所有请求走同源 /api，靠 cookie 携带 session。

async function request(path, options = {}) {
    const response = await fetch(path, {
        // 同源请求默认就带 cookie，显式写出以防将来改动
        credentials: 'same-origin',
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        ...options
    });

    let data = null;
    try {
        data = await response.json();
    } catch {
        // 204 或非 JSON 响应
    }

    if (!response.ok) {
        const err = new Error(data?.error || `HTTP ${response.status}`);
        err.status = response.status;
        throw err;
    }
    return data;
}

const body = (data) => ({ body: JSON.stringify(data) });

export const api = {
    // --- 公开 ---
    listGames: () => request('/api/games').then((d) => d.games || []),
    getGame: (id) => request(`/api/games/${encodeURIComponent(id)}`).then((d) => d.game),

    // --- 玩家账号（与管理员认证完全独立） ---
    getAccount: () => request('/api/account/me'),
    logoutAccount: () => request('/api/account/logout', { method: 'POST' }),
    loginLocalAccount: (username, password) =>
        request('/api/account/local/login', { method: 'POST', ...body({ username, password }) }),
    dismissLocalLoginPrompt: () =>
        request('/api/account/local/prompt', { method: 'POST', ...body({ dismissed: true }) }),
    saveLocalCredentials: (credentials) =>
        request('/api/account/local/credentials', { method: 'POST', ...body(credentials) }),

    // --- 认证 ---
    login: (password) => request('/api/auth/login', { method: 'POST', ...body({ password }) }),
    logout: () => request('/api/auth/logout', { method: 'POST' }),

    /** 探测登录态。401 返回 false 而不抛，调用方据此决定渲染登录框还是后台。 */
    async checkAuth() {
        try {
            await request('/api/admin/me');
            return true;
        } catch (err) {
            if (err.status === 401) return false;
            throw err;
        }
    },

    // --- 游玩时长与排行榜 ---
    sendPlaytimeHeartbeat: (gameId, deltaSeconds) =>
        request('/api/playtime/heartbeat', { method: 'POST', ...body({ gameId, deltaSeconds }) }),
    getMyPlaytimes: () => request('/api/playtime/me'),
    clearMyPlaytimes: () => request('/api/playtime/me', { method: 'DELETE' }),
    updatePlaytimePrivacy: (hidePlaytime) =>
        request('/api/playtime/privacy', { method: 'POST', ...body({ hidePlaytime }) }),
    getGameLeaderboard: (gameId) =>
        request(`/api/leaderboard/game/${encodeURIComponent(gameId)}`),
    getGlobalLeaderboard: (type = 'users') =>
        request(`/api/leaderboard/global/${encodeURIComponent(type)}`),

    // --- 后台 ---
    adminListGames: () => request('/api/admin/games').then((d) => d.games || []),
    createGame: (game) => request('/api/admin/games', { method: 'POST', ...body(game) }).then((d) => d.game),
    updateGame: (id, fields) =>
        request(`/api/admin/games/${encodeURIComponent(id)}`, { method: 'PATCH', ...body(fields) })
            .then((d) => d.game),
    deleteGame: (id) =>
        request(`/api/admin/games/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    reorderGames: (ids) => request('/api/admin/reorder', { method: 'POST', ...body({ ids }) }),
    importGames: (games) => request('/api/admin/import', { method: 'POST', ...body({ games }) })
};

/** 返回同源登录/绑定入口。OAuth 完成后回到当前 Document 的原路径。 */
export function accountLoginUrl(provider, { returnTo = '/', link = false, purpose = '' } = {}) {
    const params = new URLSearchParams({ returnTo });
    if (link) params.set('link', '1');
    if (purpose) params.set('purpose', purpose);
    return `/api/account/login/${encodeURIComponent(provider)}?${params}`;
}

/**
 * 封面地址。
 *
 * 一律走 /api/cover/<id> 而不是直接用 coverUrl：COEP require-corp 下，
 * 第三方图床不发 Cross-Origin-Resource-Policy 头，<img> 会直接加载失败。
 * Worker 侧按 id 从 D1 取真实地址回源并补上该头。
 */
export function coverSrc(game) {
    if (!game?.coverUrl) return null;
    return `/api/cover/${encodeURIComponent(game.id)}`;
}
