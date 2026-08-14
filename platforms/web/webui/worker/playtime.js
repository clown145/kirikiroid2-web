// 游玩时长追踪与排行榜处理器。
//
// 1. /api/playtime/heartbeat: 周期性/退出时上报时长增量，防刷与原子累加
// 2. /api/playtime/me: 当前登录玩家在各游戏的游玩记录与总时长
// 3. /api/playtime/privacy: 更新玩家是否在排行榜中匿名/隐藏时长
// 4. /api/leaderboard/game/:id: 单游戏排行榜（全服数据、Top 玩家、当前玩家排名）
// 5. /api/leaderboard/global: 全站综合榜单（玩家总时长榜、热门作品榜）

import { json, error } from './headers.js';
import { getAccountSession } from './user-auth.js';

function decodeSegment(value) {
    try { return decodeURIComponent(value || ''); }
    catch { return ''; }
}

function cleanGameId(value) {
    const id = decodeSegment(value);
    return id && id.length <= 160 && !/[\u0000-\u001f/]/.test(id) ? id.trim() : '';
}

/** 限制单次心跳增量在 1 ~ 120 秒之间 */
function cleanDeltaSeconds(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    const s = Math.trunc(n);
    if (s < 1) return 0;
    if (s > 120) return 120;
    return s;
}

// --- 时长上报与个人数据 ----------------------------------------------

export async function handlePlaytime(request, env, ctx, segments) {
    const [action, ...rest] = segments;
    const method = request.method;

    if (action === 'heartbeat' && method === 'POST') {
        return handleHeartbeat(request, env);
    }

    if (action === 'me') {
        if (method === 'GET') return handleGetMyPlaytime(request, env);
        if (method === 'DELETE' || method === 'POST') return handleClearMyPlaytime(request, env);
    }

    if (action === 'clear' && method === 'POST') {
        return handleClearMyPlaytime(request, env);
    }

    if (action === 'privacy' && (method === 'POST' || method === 'PATCH')) {
        return handleUpdatePrivacy(request, env);
    }

    return error(404, 'Unknown playtime endpoint');
}

async function handleHeartbeat(request, env) {
    const session = await getAccountSession(request, env);
    let body;
    try {
        body = await request.json();
    } catch {
        return error(400, 'Invalid JSON');
    }

    const gameId = cleanGameId(body?.gameId);
    const deltaSeconds = cleanDeltaSeconds(body?.deltaSeconds);

    if (!gameId || deltaSeconds <= 0) {
        return error(400, 'Invalid gameId or deltaSeconds');
    }

    // 未登录玩家：正常应答但不持久化到 D1（前端本地自存）
    if (!session) {
        return json({ ok: true, saved: false, guest: true });
    }

    const userId = session.user.id;
    const now = Date.now();
    const db = env.DB;

    // 读取已有记录进行防刷与会话判定
    const existing = await db.prepare(
        `SELECT total_seconds, session_count, first_played_at, last_played_at, last_heartbeat_at
         FROM user_game_playtimes WHERE user_id = ? AND game_id = ?`
    ).bind(userId, gameId).first();

    let actualDelta = deltaSeconds;

    if (existing) {
        // 防刷校验：若距离上次心跳时间过短，上报的时长不能超过真实经过的墙钟时间
        if (existing.last_heartbeat_at > 0) {
            const elapsed = Math.floor((now - existing.last_heartbeat_at) / 1000);
            if (elapsed > 0 && elapsed < actualDelta - 5) {
                actualDelta = Math.max(1, elapsed);
            }
        }

        // 超过 30 分钟未活跃则计为新的一次启动会话
        const isNewSession = (now - existing.last_played_at) > 30 * 60 * 1000;
        const sessionInc = isNewSession ? 1 : 0;
        const newTotal = existing.total_seconds + actualDelta;

        await db.prepare(
            `UPDATE user_game_playtimes
             SET total_seconds = total_seconds + ?,
                 session_count = session_count + ?,
                 last_played_at = ?,
                 last_heartbeat_at = ?
             WHERE user_id = ? AND game_id = ?`
        ).bind(actualDelta, sessionInc, now, now, userId, gameId).run();

        return json({ ok: true, saved: true, totalSeconds: newTotal });
    } else {
        // 首次游玩该作品
        await db.prepare(
            `INSERT INTO user_game_playtimes
             (user_id, game_id, total_seconds, session_count, first_played_at, last_played_at, last_heartbeat_at)
             VALUES (?, ?, ?, 1, ?, ?, ?)`
        ).bind(userId, gameId, actualDelta, now, now, now).run();

        return json({ ok: true, saved: true, totalSeconds: actualDelta });
    }
}

async function handleGetMyPlaytime(request, env) {
    const session = await getAccountSession(request, env);
    if (!session) {
        return json({ playtimes: [], totalSeconds: 0, guest: true });
    }

    const rows = await env.DB.prepare(
        `SELECT p.game_id, p.total_seconds, p.session_count, p.first_played_at, p.last_played_at,
                g.title, g.cover_url
         FROM user_game_playtimes p
         LEFT JOIN games g ON g.id = p.game_id
         WHERE p.user_id = ?
         ORDER BY p.total_seconds DESC`
    ).bind(session.user.id).all();

    const list = (rows.results || []).map((row) => ({
        gameId: row.game_id,
        title: row.title || '未知作品',
        coverUrl: row.cover_url || '',
        totalSeconds: row.total_seconds,
        sessionCount: row.session_count,
        firstPlayedAt: row.first_played_at,
        lastPlayedAt: row.last_played_at
    }));

    const totalSeconds = list.reduce((sum, item) => sum + item.totalSeconds, 0);

    return json({
        playtimes: list,
        totalSeconds,
        hidePlaytime: !!session.user.hidePlaytime
    });
}

async function handleUpdatePrivacy(request, env) {
    const session = await getAccountSession(request, env);
    if (!session) return error(401, '请先登录');

    let body;
    try {
        body = await request.json();
    } catch {
        return error(400, 'Invalid JSON');
    }

    const hidePlaytime = body?.hidePlaytime ? 1 : 0;
    const now = Date.now();

    await env.DB.prepare(
        'UPDATE users SET hide_playtime = ?, updated_at = ? WHERE id = ?'
    ).bind(hidePlaytime, now, session.user.id).run();

    return json({ ok: true, hidePlaytime: !!hidePlaytime });
}

async function handleClearMyPlaytime(request, env) {
    const session = await getAccountSession(request, env);
    if (!session) return error(401, '请先登录');

    const userId = session.user.id;
    const db = env.DB;

    await db.prepare('DELETE FROM user_game_playtimes WHERE user_id = ?').bind(userId).run();

    return json({ ok: true, cleared: true });
}

// --- 排行榜 ----------------------------------------------------------

export async function handleLeaderboard(request, env, ctx, segments) {
    const [scope, target] = segments;
    const method = request.method;

    if (method !== 'GET') return error(405, 'Method not allowed');

    if (scope === 'game' && target) {
        return handleGameLeaderboard(request, env, ctx, target);
    }

    if (scope === 'global' || scope === 'hot') {
        const tab = target || (scope === 'hot' ? 'games' : 'users');
        return handleGlobalLeaderboard(request, env, ctx, tab);
    }

    return error(404, 'Unknown leaderboard endpoint');
}

async function handleGameLeaderboard(request, env, ctx, rawGameId) {
    const gameId = cleanGameId(rawGameId);
    if (!gameId) return error(400, 'Invalid gameId');

    const session = await getAccountSession(request, env);
    const viewerId = session?.user?.id || null;
    const db = env.DB;

    // 1. 社区全服统计
    const statsRow = await db.prepare(
        `SELECT COUNT(DISTINCT user_id) AS player_count,
                COALESCE(SUM(total_seconds), 0) AS total_seconds
         FROM user_game_playtimes
         WHERE game_id = ?`
    ).bind(gameId).first();

    const playerCount = statsRow?.player_count || 0;
    const totalSeconds = statsRow?.total_seconds || 0;

    // 2. Top 20 玩家列表
    const topRows = await db.prepare(
        `SELECT p.user_id, p.total_seconds, p.first_played_at, p.last_played_at,
                u.display_name, u.avatar_url, u.hide_playtime
         FROM user_game_playtimes p
         JOIN users u ON u.id = p.user_id
         WHERE p.game_id = ?
         ORDER BY p.total_seconds DESC
         LIMIT 20`
    ).bind(gameId).all();

    const userIds = (topRows.results || []).map((r) => r.user_id);
    let identityMap = new Map();

    if (userIds.length > 0) {
        const placeholders = userIds.map(() => '?').join(',');
        const identities = await db.prepare(
            `SELECT user_id, provider FROM auth_identities WHERE user_id IN (${placeholders})`
        ).bind(...userIds).all();

        for (const item of (identities.results || [])) {
            if (!identityMap.has(item.user_id)) identityMap.set(item.user_id, []);
            identityMap.get(item.user_id).push(item.provider);
        }
    }

    const leaderboard = (topRows.results || []).map((row, index) => {
        const isMe = viewerId && row.user_id === viewerId;
        const isHidden = !!row.hide_playtime;
        const providers = identityMap.get(row.user_id) || [];

        return {
            rank: index + 1,
            userId: isMe ? row.user_id : (isHidden ? '' : row.user_id),
            displayName: isHidden && !isMe ? '匿名玩家' : row.display_name,
            avatarUrl: isHidden && !isMe ? '' : (row.avatar_url || ''),
            providers: isHidden && !isMe ? [] : providers,
            totalSeconds: row.total_seconds,
            firstPlayedAt: row.first_played_at,
            lastPlayedAt: row.last_played_at,
            isMe: !!isMe,
            isAnonymous: isHidden
        };
    });

    // 3. 当前登录玩家的个人排名（若未进入前 20）
    let myRank = null;
    if (viewerId) {
        const myRow = await db.prepare(
            `SELECT total_seconds, first_played_at, last_played_at
             FROM user_game_playtimes
             WHERE user_id = ? AND game_id = ?`
        ).bind(viewerId, gameId).first();

        if (myRow) {
            const higherCountRow = await db.prepare(
                `SELECT COUNT(*) AS cnt
                 FROM user_game_playtimes
                 WHERE game_id = ? AND total_seconds > ?`
            ).bind(gameId, myRow.total_seconds).first();

            myRank = {
                rank: (higherCountRow?.cnt || 0) + 1,
                totalSeconds: myRow.total_seconds,
                firstPlayedAt: myRow.first_played_at,
                lastPlayedAt: myRow.last_played_at,
                inTopList: leaderboard.some((item) => item.isMe)
            };
        }
    }

    return json({
        gameId,
        stats: {
            playerCount,
            totalSeconds
        },
        leaderboard,
        myRank
    });
}

async function handleGlobalLeaderboard(request, env, ctx, tab) {
    const session = await getAccountSession(request, env);
    const viewerId = session?.user?.id || null;
    const db = env.DB;

    if (tab === 'games') {
        // 热门作品榜：按全站玩家累计总时长/玩家数排序
        const rows = await db.prepare(
            `SELECT p.game_id,
                    SUM(p.total_seconds) AS total_seconds,
                    COUNT(DISTINCT p.user_id) AS player_count,
                    g.title, g.cover_url, g.tags
             FROM user_game_playtimes p
             JOIN games g ON g.id = p.game_id AND g.published = 1
             GROUP BY p.game_id
             ORDER BY total_seconds DESC
             LIMIT 50`
        ).all();

        const games = (rows.results || []).map((row, index) => {
            let tags = [];
            try { tags = JSON.parse(row.tags || '[]'); } catch {}
            return {
                rank: index + 1,
                gameId: row.game_id,
                title: row.title,
                coverUrl: row.cover_url || '',
                tags,
                totalSeconds: row.total_seconds,
                playerCount: row.player_count
            };
        });

        return json({ type: 'games', list: games });
    }

    // 玩家总时长榜（全站肝帝榜）：按全站累计时长 Top 50
    const userRows = await db.prepare(
        `SELECT p.user_id,
                SUM(p.total_seconds) AS total_seconds,
                COUNT(DISTINCT p.game_id) AS game_count,
                MAX(p.last_played_at) AS last_played_at,
                u.display_name, u.avatar_url, u.hide_playtime
         FROM user_game_playtimes p
         JOIN users u ON u.id = p.user_id
         GROUP BY p.user_id
         ORDER BY total_seconds DESC
         LIMIT 50`
    ).all();

    const userIds = (userRows.results || []).map((r) => r.user_id);
    let identityMap = new Map();
    let topGameMap = new Map();

    if (userIds.length > 0) {
        const placeholders = userIds.map(() => '?').join(',');
        const [identities, playtimes] = await Promise.all([
            db.prepare(
                `SELECT user_id, provider FROM auth_identities WHERE user_id IN (${placeholders})`
            ).bind(...userIds).all(),
            db.prepare(
                `SELECT p.user_id, p.game_id, p.total_seconds, g.title
                 FROM user_game_playtimes p
                 LEFT JOIN games g ON g.id = p.game_id
                 WHERE p.user_id IN (${placeholders})
                 ORDER BY p.total_seconds DESC`
            ).bind(...userIds).all()
        ]);

        for (const item of (identities.results || [])) {
            if (!identityMap.has(item.user_id)) identityMap.set(item.user_id, []);
            identityMap.get(item.user_id).push(item.provider);
        }

        for (const item of (playtimes.results || [])) {
            if (!topGameMap.has(item.user_id) && item.title) {
                topGameMap.set(item.user_id, item.title);
            }
        }
    }

    const users = (userRows.results || []).map((row, index) => {
        const isMe = viewerId && row.user_id === viewerId;
        const isHidden = !!row.hide_playtime;
        const providers = identityMap.get(row.user_id) || [];
        const topGame = topGameMap.get(row.user_id) || '';

        return {
            rank: index + 1,
            userId: isMe ? row.user_id : (isHidden ? '' : row.user_id),
            displayName: isHidden && !isMe ? '匿名玩家' : row.display_name,
            avatarUrl: isHidden && !isMe ? '' : (row.avatar_url || ''),
            providers: isHidden && !isMe ? [] : providers,
            totalSeconds: row.total_seconds,
            gameCount: row.game_count,
            lastPlayedAt: row.last_played_at,
            topGame: isHidden && !isMe ? '' : topGame,
            isMe: !!isMe,
            isAnonymous: isHidden
        };
    });

    return json({ type: 'users', list: users });
}
