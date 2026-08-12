// 玩家云存档：R2 私有快照 + D1 不可变版本链。

import { json, error } from './headers.js';
import { getAccountSession } from './user-auth.js';

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ACCOUNT_BYTES = 512 * 1024 * 1024;
const KEEP_REVISIONS = 20;

function decodeSegment(value) {
    try { return decodeURIComponent(value || ''); }
    catch { return ''; }
}

function cleanGameId(value) {
    const id = decodeSegment(value);
    return id && id.length <= 160 && !/[\u0000-\u001f/]/.test(id) ? id : '';
}

function cleanRevision(value) {
    const id = decodeSegment(value);
    return /^[0-9a-f-]{36}$/i.test(id) ? id : '';
}

function cleanDeviceId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(value) ? value : '';
}

function cleanDeviceName(value) {
    if (typeof value !== 'string') return '当前设备';
    try { value = decodeURIComponent(value); } catch {}
    return value.trim().slice(0, 80) || '当前设备';
}

function revisionJson(row) {
    if (!row) return null;
    return {
        id: row.id,
        gameId: row.game_id,
        parentRevisionId: row.parent_revision_id || null,
        contentHash: row.content_hash,
        archiveSha256: row.archive_sha256,
        byteSize: row.byte_size,
        fileCount: row.file_count,
        deviceId: row.device_id,
        deviceName: row.device_name,
        createdAt: row.created_at
    };
}

async function currentHead(db, userId, gameId) {
    return db.prepare(
        `SELECT r.* FROM save_heads h
         JOIN save_revisions r ON r.id = h.revision_id
         WHERE h.user_id = ? AND h.game_id = ?`
    ).bind(userId, gameId).first();
}

async function gameExists(db, gameId) {
    return !!(await db.prepare('SELECT id FROM games WHERE id = ?').bind(gameId).first());
}

function conflict(head) {
    return json({
        error: '云端存档已在其他设备更新',
        conflict: true,
        head: revisionJson(head)
    }, { status: 409 });
}

function sameOriginMutation(request) {
    const origin = request.headers.get('Origin');
    return origin === new URL(request.url).origin;
}

async function listSaves(env, userId) {
    const [heads, usage] = await env.DB.batch([
        env.DB.prepare(
            `SELECT r.* FROM save_heads h
             JOIN save_revisions r ON r.id = h.revision_id
             WHERE h.user_id = ? ORDER BY h.updated_at DESC`
        ).bind(userId),
        env.DB.prepare(
            'SELECT COALESCE(SUM(byte_size), 0) AS bytes FROM save_revisions WHERE user_id = ?'
        ).bind(userId)
    ]);
    return json({
        saves: (heads.results || []).map(revisionJson),
        usage: { bytes: Number(usage.results?.[0]?.bytes || 0), limit: MAX_ACCOUNT_BYTES }
    });
}

async function listHistory(env, userId, gameId) {
    const rows = await env.DB.prepare(
        `SELECT * FROM save_revisions
         WHERE user_id = ? AND game_id = ?
         ORDER BY created_at DESC LIMIT ?`
    ).bind(userId, gameId, KEEP_REVISIONS).all();
    return json({ revisions: (rows.results || []).map(revisionJson) });
}

async function removeRevisionObjectIfUnused(env, objectKey) {
    const remaining = await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM save_revisions WHERE object_key = ?'
    ).bind(objectKey).first();
    if (!Number(remaining?.count || 0)) await env.SAVES.delete(objectKey);
}

async function pruneHistory(env, userId, gameId) {
    const old = await env.DB.prepare(
        `SELECT id, object_key FROM save_revisions
         WHERE user_id = ? AND game_id = ?
         ORDER BY created_at DESC LIMIT -1 OFFSET ?`
    ).bind(userId, gameId, KEEP_REVISIONS).all();
    if (!old.results?.length) return;
    await env.DB.batch(old.results.map((row) =>
        env.DB.prepare('DELETE FROM save_revisions WHERE id = ? AND user_id = ?')
            .bind(row.id, userId)
    ));
    for (const row of old.results) await removeRevisionObjectIfUnused(env, row.object_key);
}

async function uploadRevision(request, env, ctx, userId, gameId) {
    if (!sameOriginMutation(request)) return error(403, 'Invalid origin');
    if (!(await gameExists(env.DB, gameId))) return error(404, 'Game not found');
    if (!request.body) return error(400, '缺少存档数据');

    const type = request.headers.get('Content-Type') || '';
    if (!type.startsWith('application/zip')) return error(415, '存档必须是 ZIP');

    const declaredSize = Number(request.headers.get('Content-Length') || 0);
    if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0) {
        return error(411, '存档上传必须提供 Content-Length');
    }
    if (declaredSize > MAX_ARCHIVE_BYTES) return error(413, '单个存档版本不能超过 64 MB');

    const baseRevision = request.headers.get('X-KrKr2-Base-Revision') || null;
    if (baseRevision && !cleanRevision(baseRevision)) return error(400, '无效的基线版本');
    const contentHash = request.headers.get('X-KrKr2-Content-Hash') || '';
    const archiveSha256 = request.headers.get('X-KrKr2-Archive-Sha256') || '';
    if (!/^[0-9a-f]{64}$/i.test(contentHash) || !/^[0-9a-f]{64}$/i.test(archiveSha256)) {
        return error(400, '缺少有效的存档摘要');
    }
    const fileCount = Number(request.headers.get('X-KrKr2-File-Count'));
    if (!Number.isInteger(fileCount) || fileCount < 0 || fileCount > 10000) {
        return error(400, '无效的文件数量');
    }
    const deviceId = cleanDeviceId(request.headers.get('X-KrKr2-Device-Id'));
    if (!deviceId) return error(400, '无效的设备标识');
    const deviceName = cleanDeviceName(request.headers.get('X-KrKr2-Device-Name'));

    const before = await currentHead(env.DB, userId, gameId);
    if (before?.content_hash === contentHash) {
        return json({ revision: revisionJson(before), unchanged: true });
    }
    if ((before?.id || null) !== baseRevision) return conflict(before);

    const usage = await env.DB.prepare(
        'SELECT COALESCE(SUM(byte_size), 0) AS bytes FROM save_revisions WHERE user_id = ?'
    ).bind(userId).first();
    if (Number(usage?.bytes || 0) + Math.max(0, declaredSize) > MAX_ACCOUNT_BYTES) {
        return error(413, '云存档空间已满');
    }

    const revisionId = crypto.randomUUID();
    const objectKey = `users/${userId}/games/${encodeURIComponent(gameId)}/${revisionId}.zip`;
    // 保留原始 request.body 的 known-length 属性，R2 才能流式接收而不缓冲到内存。
    // HTTP 层保证实际 body 与 Content-Length 一致；落盘后仍用 head() 再核对一次。
    try {
        await env.SAVES.put(objectKey, request.body, {
            sha256: archiveSha256,
            httpMetadata: { contentType: 'application/zip' },
            customMetadata: { userId, gameId, revisionId, contentHash }
        });
    } catch (err) {
        await env.SAVES.delete(objectKey).catch(() => {});
        if (/checksum|sha-?256|hash/i.test(String(err?.message || ''))) {
            return error(400, '存档摘要不匹配');
        }
        throw err;
    }

    const object = await env.SAVES.head(objectKey);
    const byteSize = Number(object?.size || declaredSize || 0);
    if (!object || byteSize !== declaredSize || byteSize > MAX_ARCHIVE_BYTES) {
        await env.SAVES.delete(objectKey);
        return error(413, '单个存档版本不能超过 64 MB');
    }
    if (Number(usage?.bytes || 0) + byteSize > MAX_ACCOUNT_BYTES) {
        await env.SAVES.delete(objectKey);
        return error(413, '云存档空间已满');
    }

    const now = Date.now();
    const results = await env.DB.batch([
        env.DB.prepare(
            `INSERT INTO save_revisions
             (id, user_id, game_id, parent_revision_id, object_key, content_hash,
              archive_sha256, byte_size, file_count, device_id, device_name, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
            revisionId, userId, gameId, baseRevision, objectKey, contentHash,
            archiveSha256, byteSize, fileCount, deviceId, deviceName, now
        ),
        env.DB.prepare(
            `INSERT INTO save_heads (user_id, game_id, revision_id, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id, game_id) DO UPDATE SET
               revision_id = excluded.revision_id, updated_at = excluded.updated_at
             WHERE save_heads.revision_id = ?`
        ).bind(userId, gameId, revisionId, now, baseRevision || ''),
        env.DB.prepare(
            `INSERT INTO save_devices (user_id, device_id, device_name, last_seen_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id, device_id) DO UPDATE SET
               device_name = excluded.device_name, last_seen_at = excluded.last_seen_at`
        ).bind(userId, deviceId, deviceName, now)
    ]);

    if (Number(results[1]?.meta?.changes || 0) !== 1) {
        await env.DB.prepare('DELETE FROM save_revisions WHERE id = ?').bind(revisionId).run();
        await env.SAVES.delete(objectKey);
        return conflict(await currentHead(env.DB, userId, gameId));
    }

    const revision = await env.DB.prepare('SELECT * FROM save_revisions WHERE id = ?')
        .bind(revisionId).first();
    ctx.waitUntil(pruneHistory(env, userId, gameId).catch((err) => {
        console.error('[saves] prune failed:', err?.stack || err);
    }));
    return json({ revision: revisionJson(revision) }, { status: 201 });
}

async function downloadRevision(env, userId, gameId, revisionId) {
    const row = await env.DB.prepare(
        'SELECT * FROM save_revisions WHERE id = ? AND user_id = ? AND game_id = ?'
    ).bind(revisionId, userId, gameId).first();
    if (!row) return error(404, 'Save revision not found');
    const object = await env.SAVES.get(row.object_key);
    if (!object) return error(404, 'Save archive not found');
    return new Response(object.body, {
        headers: {
            'Content-Type': 'application/zip',
            'Content-Length': String(row.byte_size),
            'Cache-Control': 'private, no-store',
            'X-KrKr2-Revision': row.id,
            'X-KrKr2-Content-Hash': row.content_hash
        }
    });
}

async function restoreRevision(request, env, ctx, userId, gameId) {
    if (!sameOriginMutation(request)) return error(403, 'Invalid origin');
    let body;
    try { body = await request.json(); }
    catch { return error(400, 'Invalid JSON'); }
    const sourceId = cleanRevision(body?.revisionId);
    const deviceId = cleanDeviceId(body?.deviceId);
    const deviceName = cleanDeviceName(body?.deviceName);
    if (!sourceId || !deviceId) return error(400, '无效的恢复参数');

    const source = await env.DB.prepare(
        'SELECT * FROM save_revisions WHERE id = ? AND user_id = ? AND game_id = ?'
    ).bind(sourceId, userId, gameId).first();
    if (!source) return error(404, 'Save revision not found');
    const head = await currentHead(env.DB, userId, gameId);
    if (!head) return error(409, '云端没有可恢复的当前版本');
    if (head.id === source.id) return json({ revision: revisionJson(head), unchanged: true });

    const revisionId = crypto.randomUUID();
    const now = Date.now();
    const results = await env.DB.batch([
        env.DB.prepare(
            `INSERT INTO save_revisions
             (id, user_id, game_id, parent_revision_id, object_key, content_hash,
              archive_sha256, byte_size, file_count, device_id, device_name, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
            revisionId, userId, gameId, head.id, source.object_key, source.content_hash,
            source.archive_sha256, source.byte_size, source.file_count, deviceId, deviceName, now
        ),
        env.DB.prepare(
            `UPDATE save_heads SET revision_id = ?, updated_at = ?
             WHERE user_id = ? AND game_id = ? AND revision_id = ?`
        ).bind(revisionId, now, userId, gameId, head.id),
        env.DB.prepare(
            `INSERT INTO save_devices (user_id, device_id, device_name, last_seen_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id, device_id) DO UPDATE SET
               device_name = excluded.device_name, last_seen_at = excluded.last_seen_at`
        ).bind(userId, deviceId, deviceName, now)
    ]);
    if (Number(results[1]?.meta?.changes || 0) !== 1) {
        await env.DB.prepare('DELETE FROM save_revisions WHERE id = ?').bind(revisionId).run();
        return conflict(await currentHead(env.DB, userId, gameId));
    }
    const revision = await env.DB.prepare('SELECT * FROM save_revisions WHERE id = ?')
        .bind(revisionId).first();
    ctx.waitUntil(pruneHistory(env, userId, gameId).catch((err) => {
        console.error('[saves] prune failed:', err?.stack || err);
    }));
    return json({ revision: revisionJson(revision) }, { status: 201 });
}

export async function handleSaves(request, env, ctx, segments) {
    if (!env.SAVES) return error(503, '云存档 R2 尚未绑定');
    const session = await getAccountSession(request, env);
    if (!session) return error(401, '请先登录');

    const method = request.method;
    if (!segments.length && method === 'GET') return listSaves(env, session.user.id);

    const gameId = cleanGameId(segments[0]);
    if (!gameId) return error(400, '无效的游戏标识');
    if (segments[1] === 'history' && method === 'GET') {
        return listHistory(env, session.user.id, gameId);
    }
    if (segments[1] === 'revisions' && !segments[2] && method === 'POST') {
        return uploadRevision(request, env, ctx, session.user.id, gameId);
    }
    if (segments[1] === 'revisions' && segments[2] && segments[3] === 'archive' && method === 'GET') {
        const revisionId = cleanRevision(segments[2]);
        if (!revisionId) return error(400, '无效的版本标识');
        return downloadRevision(env, session.user.id, gameId, revisionId);
    }
    if (segments[1] === 'restore' && method === 'POST') {
        return restoreRevision(request, env, ctx, session.user.id, gameId);
    }
    return error(404, 'Unknown save endpoint');
}
