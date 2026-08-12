// 手动云存档同步状态机。游戏运行期间只标记 dirty，本模块只由用户点击触发。

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

export function classifySync(snapshot, remote) {
    const meta = snapshot.meta || {};
    if (!remote) return snapshot.files.length || meta.dirty ? 'upload' : 'empty';
    if (!meta.dirty && meta.contentHash && meta.contentHash === remote.contentHash) return 'same-content';
    if (!meta.baseRevision) return snapshot.files.length || meta.dirty ? 'conflict' : 'download';
    if (meta.baseRevision === remote.id) return meta.dirty ? 'upload' : 'synced';
    return meta.dirty ? 'conflict' : 'download';
}

export async function listCloudSaves() {
    return fetchJson('/api/saves');
}

export async function listSaveHistory(gameId) {
    const data = await fetchJson(`/api/saves/${encodeURIComponent(gameId)}/history`);
    return data.revisions || [];
}

async function uploadSnapshot(game, snapshot, baseRevision) {
    const hash = await contentHash(snapshot.files);
    const archive = await buildArchive(snapshot.files);
    const device = getDevice();
    const headers = {
        'Content-Type': 'application/zip',
        'X-KrKr2-Content-Hash': hash,
        'X-KrKr2-Archive-Sha256': archive.sha256,
        'X-KrKr2-File-Count': String(snapshot.files.length),
        'X-KrKr2-Device-Id': device.id,
        'X-KrKr2-Device-Name': encodeURIComponent(device.name)
    };
    if (baseRevision) headers['X-KrKr2-Base-Revision'] = baseRevision;
    const response = await fetch(`/api/saves/${encodeURIComponent(game.id)}/revisions`, {
        method: 'POST',
        credentials: 'same-origin',
        headers,
        body: archive.bytes
    });
    if (!response.ok) return responseError(response);
    const result = await response.json();
    await IDB().setSyncMeta(spaceIdForGame(game.id), {
        dirty: false,
        baseRevision: result.revision.id,
        contentHash: result.revision.contentHash,
        lastSyncedAt: Date.now()
    });
    return result.revision;
}

async function archiveFiles(response) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESTORE_BYTES) throw new Error('云端存档过大，已停止恢复');
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

async function fetchArchive(gameId, revisionId) {
    const response = await fetch(
        `/api/saves/${encodeURIComponent(gameId)}/revisions/${encodeURIComponent(revisionId)}/archive`,
        { credentials: 'same-origin' }
    );
    if (!response.ok) return responseError(response);
    return response;
}

async function applyRemote(game, revision) {
    const files = await archiveFiles(await fetchArchive(game.id, revision.id));
    await IDB().replaceFiles(spaceIdForGame(game.id), files, {
        baseRevision: revision.id,
        contentHash: revision.contentHash,
        lastSyncedAt: Date.now()
    });
    IDB().registerSpace(spaceIdForGame(game.id));
    return revision;
}

export async function inspectGameSave(game, remote = null) {
    const spaceId = spaceIdForGame(game.id);
    const snapshot = await IDB().snapshot(spaceId);
    return { game, spaceId, snapshot, remote, action: classifySync(snapshot, remote) };
}

export async function syncGame(game, remote = null) {
    const state = await inspectGameSave(game, remote);
    if (state.action === 'empty' || state.action === 'synced') {
        return { ...state, result: 'unchanged' };
    }
    if (state.action === 'same-content') {
        await IDB().setSyncMeta(state.spaceId, {
            dirty: false,
            baseRevision: remote.id,
            contentHash: remote.contentHash,
            lastSyncedAt: Date.now()
        });
        return { ...state, result: 'unchanged' };
    }
    if (state.action === 'download') {
        await applyRemote(game, remote);
        return { ...state, result: 'downloaded', revision: remote };
    }
    if (state.action === 'upload') {
        try {
            const revision = await uploadSnapshot(game, state.snapshot, remote?.id || null);
            return { ...state, result: 'uploaded', revision };
        } catch (err) {
            if (err.status === 409 && err.data?.head) {
                return { ...state, action: 'conflict', result: 'conflict', remote: err.data.head };
            }
            throw err;
        }
    }
    return { ...state, result: 'conflict' };
}

export async function syncAllGames(games, onProgress) {
    const cloud = await listCloudSaves();
    const heads = new Map((cloud.saves || []).map((revision) => [revision.gameId, revision]));
    const spaces = new Set(await IDB().listSpaces());
    const candidates = games.filter((game) =>
        spaces.has(spaceIdForGame(game.id)) || heads.has(game.id));
    const results = [];
    for (let i = 0; i < candidates.length; i++) {
        const game = candidates[i];
        onProgress?.({ index: i, total: candidates.length, game });
        results.push(await syncGame(game, heads.get(game.id) || null));
    }
    return { results, usage: cloud.usage };
}

export async function resolveConflictWithLocal(conflictState) {
    const snapshot = await IDB().snapshot(spaceIdForGame(conflictState.game.id));
    return uploadSnapshot(conflictState.game, snapshot, conflictState.remote?.id || null);
}

export async function resolveConflictWithCloud(conflictState) {
    return applyRemote(conflictState.game, conflictState.remote);
}

export async function downloadBoth(conflictState) {
    await IDB().exportZip(spaceIdForGame(conflictState.game.id));
    const response = await fetchArchive(conflictState.game.id, conflictState.remote.id);
    const blob = await response.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${conflictState.game.id}-cloud-${conflictState.remote.id.slice(0, 8)}.zip`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

export async function restoreHistoricalRevision(game, revisionId) {
    const device = getDevice();
    const result = await fetchJson(`/api/saves/${encodeURIComponent(game.id)}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revisionId, deviceId: device.id, deviceName: device.name })
    });
    await applyRemote(game, result.revision);
    return result.revision;
}

export async function localSaveSummary(games) {
    const spaces = new Set(await IDB().listSpaces());
    const rows = [];
    for (const game of games) {
        const spaceId = spaceIdForGame(game.id);
        if (!spaces.has(spaceId)) continue;
        const info = await IDB().getSpaceInfo(spaceId);
        rows.push({ game, ...info });
    }
    return rows;
}
