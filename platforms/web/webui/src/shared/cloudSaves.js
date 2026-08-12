// 手动云存档同步状态机。存储后端可为站点 R2 或用户自己的 WebDAV。

import { createWebDavBackend, getWebDavConfig } from './webdav.js';
import { getSetting } from './settings.js';

const DEVICE_ID_KEY = 'krkr2-save-device-id';
const DEVICE_NAME_KEY = 'krkr2-save-device-name';
const MAX_RESTORE_BYTES = 128 * 1024 * 1024;

function IDB() {
    if (!window.KrKr2IDB) throw new Error('当前浏览器无法读取本地存档');
    return window.KrKr2IDB;
}

function bytesToHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(data) {
    const input = data instanceof Uint8Array ? data : new Uint8Array(data);
    return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', input)));
}

async function responseError(response) {
    let data = null;
    try { data = await response.json(); } catch {}
    const err = new Error(data?.error || `HTTP ${response.status}`);
    err.status = response.status;
    err.data = data;
    throw err;
}

async function fetchJson(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', ...options });
    if (!response.ok) return responseError(response);
    return response.json();
}

export function getDevice() {
    let id;
    let name;
    try {
        id = localStorage.getItem(DEVICE_ID_KEY);
        if (!/^[A-Za-z0-9_-]{8,100}$/.test(id || '')) {
            id = crypto.randomUUID();
            localStorage.setItem(DEVICE_ID_KEY, id);
        }
        name = localStorage.getItem(DEVICE_NAME_KEY) || '';
    } catch {
        id = crypto.randomUUID();
    }
    return { id, name: name.trim() || '当前设备' };
}

export function setDeviceName(value) {
    const name = String(value || '').trim().slice(0, 80) || '当前设备';
    try { localStorage.setItem(DEVICE_NAME_KEY, name); } catch {}
    return getDevice();
}

export function spaceIdForGame(gameId) {
    return 'game_' + gameId;
}

export async function contentHash(files) {
    const lines = [];
    const sorted = [...files].sort((a, b) => String(a.path).localeCompare(String(b.path)));
    for (const file of sorted) {
        const data = new Uint8Array(file.data);
        lines.push(`${file.path}\u0000${data.byteLength}\u0000${await sha256Hex(data)}`);
    }
    return sha256Hex(new TextEncoder().encode(lines.join('\n')));
}

async function buildArchive(files) {
    if (!window.JSZip) throw new Error('ZIP 组件尚未加载');
    const zip = new JSZip();
    const fixedDate = new Date('1980-01-01T00:00:00Z');
    for (const file of files) {
        zip.file(String(file.path).replace(/^\/+/, ''), file.data, { date: fixedDate });
    }
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    return { bytes, sha256: await sha256Hex(bytes) };
}

function targetMeta(meta, targetKey) {
    if (meta?.targets?.[targetKey]) return meta.targets[targetKey];
    if (targetKey === 'site') {
        return {
            baseRevision: meta?.baseRevision || null,
            contentHash: meta?.contentHash || null,
            lastSyncedAt: meta?.lastSyncedAt || null
        };
    }
    return { baseRevision: null, contentHash: null, lastSyncedAt: null };
}

function syncMetaForTarget(meta, targetKey) {
    const target = targetMeta(meta, targetKey);
    return {
        ...meta,
        baseRevision: target.baseRevision || null,
        contentHash: target.contentHash || null,
        lastSyncedAt: target.lastSyncedAt || null,
        dirty: !!meta?.dirty || (!!meta?.currentContentHash &&
            meta.currentContentHash !== target.contentHash)
    };
}

export function classifySync(snapshot, remote, targetKey = 'site') {
    const meta = syncMetaForTarget(snapshot.meta || {}, targetKey);
    if (!remote) return snapshot.files.length || meta.dirty ? 'upload' : 'empty';
    const localHash = snapshot.meta?.currentContentHash || (!meta.dirty ? meta.contentHash : null);
    if (localHash && localHash === remote.contentHash) return 'same-content';
    if (!meta.baseRevision) return snapshot.files.length || meta.dirty ? 'conflict' : 'download';
    if (meta.baseRevision === remote.id) return meta.dirty ? 'upload' : 'synced';
    return meta.dirty ? 'conflict' : 'download';
}

function createSiteBackend() {
    return {
        kind: 'site',
        targetKey: 'site',
        label: '站点云存档',
        requiresAccount: true,
        list: () => fetchJson('/api/saves'),
        async history(gameId) {
            const data = await fetchJson(`/api/saves/${encodeURIComponent(gameId)}/history`);
            return data.revisions || [];
        },
        async upload(game, archive, metadata, baseRevision) {
            const headers = {
                'Content-Type': 'application/zip',
                'X-KrKr2-Content-Hash': metadata.contentHash,
                'X-KrKr2-Archive-Sha256': archive.sha256,
                'X-KrKr2-File-Count': String(metadata.fileCount),
                'X-KrKr2-Device-Id': metadata.device.id,
                'X-KrKr2-Device-Name': encodeURIComponent(metadata.device.name)
            };
            if (baseRevision) headers['X-KrKr2-Base-Revision'] = baseRevision;
            const response = await fetch(`/api/saves/${encodeURIComponent(game.id)}/revisions`, {
                method: 'POST', credentials: 'same-origin', headers, body: archive.bytes
            });
            if (!response.ok) return responseError(response);
            return (await response.json()).revision;
        },
        archive(gameId, revision) {
            return fetch(
                `/api/saves/${encodeURIComponent(gameId)}/revisions/${encodeURIComponent(revision.id)}/archive`,
                { credentials: 'same-origin' }
            ).then((response) => response.ok ? response : responseError(response));
        },
        async restore(game, revisionId, device) {
            const result = await fetchJson(`/api/saves/${encodeURIComponent(game.id)}/restore`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ revisionId, deviceId: device.id, deviceName: device.name })
            });
            return result.revision;
        }
    };
}

export function getSyncBackend() {
    if (getSetting('saveSyncProvider') === 'webdav') {
        const config = getWebDavConfig();
        if (!config) throw new Error('请先在设置中配置 WebDAV');
        return createWebDavBackend(config);
    }
    return createSiteBackend();
}

export function getSyncProviderStatus() {
    if (getSetting('saveSyncProvider') !== 'webdav') {
        return { kind: 'site', label: '站点云存档', configured: true, requiresAccount: true };
    }
    const config = getWebDavConfig();
    return {
        kind: 'webdav',
        label: config?.name || 'WebDAV',
        configured: !!config?.url && !!config?.password,
        requiresAccount: false
    };
}

export async function listCloudSaves(games = []) {
    return getSyncBackend().list(games);
}

export async function listSaveHistory(gameId) {
    return getSyncBackend().history(gameId);
}

async function archiveFiles(response, expectedSha256 = '') {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESTORE_BYTES) throw new Error('云端存档过大，已停止恢复');
    if (expectedSha256 && await sha256Hex(bytes) !== expectedSha256) {
        throw new Error('云端存档校验失败，文件可能已损坏');
    }
    const zip = await JSZip.loadAsync(bytes);
    const entries = [];
    zip.forEach((path, entry) => {
        if (entry.dir) return;
        const clean = path.replace(/^\/+/, '');
        if (!clean || clean.split('/').includes('..') || /\u0000/.test(clean)) {
            throw new Error('云端存档包含无效路径');
        }
        entries.push({ path: '/' + clean, entry });
    });
    if (entries.length > 10000) throw new Error('云端存档文件数量异常');
    const files = [];
    let total = 0;
    for (const item of entries) {
        const data = await item.entry.async('uint8array');
        total += data.byteLength;
        if (total > MAX_RESTORE_BYTES) throw new Error('云端存档解压后过大，已停止恢复');
        files.push({ path: item.path, data });
    }
    return files;
}

async function markSynced(spaceId, backend, revision) {
    await IDB().setSyncTarget(spaceId, backend.targetKey, {
        baseRevision: revision.id,
        contentHash: revision.contentHash,
        lastSyncedAt: Date.now()
    });
}

async function uploadSnapshot(backend, game, snapshot, baseRevision) {
    const hash = await contentHash(snapshot.files);
    const archive = await buildArchive(snapshot.files);
    const revision = await backend.upload(game, archive, {
        contentHash: hash,
        fileCount: snapshot.files.length,
        device: getDevice()
    }, baseRevision);
    await markSynced(spaceIdForGame(game.id), backend, revision);
    return revision;
}

async function applyRemote(backend, game, revision) {
    const files = await archiveFiles(
        await backend.archive(game.id, revision),
        revision.archiveSha256 || ''
    );
    await IDB().replaceFilesForTarget(spaceIdForGame(game.id), files, backend.targetKey, {
        baseRevision: revision.id,
        contentHash: revision.contentHash,
        lastSyncedAt: Date.now()
    });
    IDB().registerSpace(spaceIdForGame(game.id));
    return revision;
}

export async function inspectGameSave(game, remote = null, backend = getSyncBackend()) {
    const spaceId = spaceIdForGame(game.id);
    const snapshot = await IDB().snapshot(spaceId);
    return { game, spaceId, snapshot, remote, backend, action: classifySync(snapshot, remote, backend.targetKey) };
}

export async function syncGame(game, remote = null, backend = getSyncBackend()) {
    const state = await inspectGameSave(game, remote, backend);
    if (state.action === 'empty' || state.action === 'synced') {
        return { ...state, result: 'unchanged' };
    }
    if (state.action === 'same-content') {
        await markSynced(state.spaceId, backend, remote);
        return { ...state, result: 'unchanged' };
    }
    if (state.action === 'download') {
        await applyRemote(backend, game, remote);
        return { ...state, result: 'downloaded', revision: remote };
    }
    if (state.action === 'upload') {
        try {
            const meta = syncMetaForTarget(state.snapshot.meta, backend.targetKey);
            const revision = await uploadSnapshot(backend, game, state.snapshot,
                meta.baseRevision || remote?.id || null);
            return { ...state, result: 'uploaded', revision };
        } catch (err) {
            if (err.status === 409) {
                return { ...state, action: 'conflict', result: 'conflict', remote: err.data?.head || err.head || remote };
            }
            throw err;
        }
    }
    return { ...state, result: 'conflict' };
}

export async function syncAllGames(games, onProgress, backend = getSyncBackend()) {
    const cloud = await backend.list(games);
    const heads = new Map((cloud.saves || []).map((revision) => [revision.gameId, revision]));
    const spaces = new Set(await IDB().listSpaces());
    const candidates = games.filter((game) =>
        spaces.has(spaceIdForGame(game.id)) || heads.has(game.id));
    const results = [];
    for (let i = 0; i < candidates.length; i++) {
        const game = candidates[i];
        onProgress?.({ index: i, total: candidates.length, game });
        results.push(await syncGame(game, heads.get(game.id) || null, backend));
    }
    return { results, usage: cloud.usage };
}

export async function resolveConflictWithLocal(conflictState) {
    const backend = conflictState.backend || getSyncBackend();
    const snapshot = await IDB().snapshot(spaceIdForGame(conflictState.game.id));
    return uploadSnapshot(backend, conflictState.game, snapshot, conflictState.remote?.id || null);
}

export async function resolveConflictWithCloud(conflictState) {
    const backend = conflictState.backend || getSyncBackend();
    return applyRemote(backend, conflictState.game, conflictState.remote);
}

export async function downloadBoth(conflictState) {
    const backend = conflictState.backend || getSyncBackend();
    await IDB().exportZip(spaceIdForGame(conflictState.game.id));
    const response = await backend.archive(conflictState.game.id, conflictState.remote);
    const blob = await response.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${conflictState.game.id}-cloud-${conflictState.remote.id.slice(0, 8)}.zip`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

export async function restoreHistoricalRevision(game, revisionId, backend = getSyncBackend()) {
    const revision = await backend.restore(game, revisionId, getDevice());
    await applyRemote(backend, game, revision);
    return revision;
}

export async function localSaveSummary(games, backend) {
    if (backend === undefined) {
        try { backend = getSyncBackend(); } catch { backend = null; }
    }
    const targetKey = backend?.targetKey || null;
    const spaces = new Set(await IDB().listSpaces());
    const rows = [];
    for (const game of games) {
        const spaceId = spaceIdForGame(game.id);
        if (!spaces.has(spaceId)) continue;
        const info = await IDB().getSpaceInfo(spaceId);
        if (targetKey) {
            const target = targetMeta(info, targetKey);
            info.baseRevision = target.baseRevision || null;
            info.contentHash = target.contentHash || null;
            info.lastSyncedAt = target.lastSyncedAt || null;
            info.dirty = !!info.dirty || (!!info.currentContentHash &&
                info.currentContentHash !== target.contentHash);
        }
        rows.push({ game, ...info });
    }
    return rows;
}
