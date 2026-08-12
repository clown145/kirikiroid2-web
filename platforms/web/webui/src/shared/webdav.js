const CONFIG_KEY = 'krkr2-webdav-config';
const SESSION_PASSWORD_KEY = 'krkr2-webdav-password';
const MANIFEST_VERSION = 1;
const KEEP_REVISIONS = 20;

function storageGet(storage, key) {
    try { return storage.getItem(key); } catch { return null; }
}

function storageSet(storage, key, value) {
    try {
        if (value == null) storage.removeItem(key);
        else storage.setItem(key, value);
    } catch {}
}

function normalizeUrl(value) {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
        throw new Error('WebDAV 地址必须使用 HTTPS');
    }
    if (url.username || url.password) throw new Error('请不要把用户名或密码写在 WebDAV URL 中');
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/+$/, '');
}

function normalizeRoot(value) {
    const parts = String(value || 'Kirikiroid2').split('/').map((part) => part.trim()).filter(Boolean);
    if (!parts.length || parts.some((part) => part === '.' || part === '..')) {
        throw new Error('远端目录无效');
    }
    return parts.join('/');
}

function utf8Base64(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function configSignature(config) {
    return [config.url, config.username, config.root].join('\n');
}

export function getWebDavConfig() {
    let stored = null;
    try { stored = JSON.parse(storageGet(localStorage, CONFIG_KEY) || 'null'); } catch {}
    if (!stored || typeof stored !== 'object') return null;
    const password = stored.rememberPassword
        ? String(stored.password || '')
        : String(storageGet(sessionStorage, SESSION_PASSWORD_KEY) || '');
    return { ...stored, password };
}

export function saveWebDavConfig(input) {
    const current = getWebDavConfig();
    const next = {
        id: current?.id || crypto.randomUUID(),
        name: String(input.name || '').trim().slice(0, 80) || '我的 WebDAV',
        url: normalizeUrl(input.url),
        username: String(input.username || '').trim(),
        password: String(input.password || ''),
        root: normalizeRoot(input.root),
        rememberPassword: !!input.rememberPassword
    };
    if (current && configSignature(current) !== configSignature(next)) next.id = crypto.randomUUID();
    const persisted = { ...next };
    if (!persisted.rememberPassword) delete persisted.password;
    storageSet(localStorage, CONFIG_KEY, JSON.stringify(persisted));
    storageSet(sessionStorage, SESSION_PASSWORD_KEY,
        persisted.rememberPassword ? null : next.password);
    return next;
}

export function clearWebDavConfig() {
    storageSet(localStorage, CONFIG_KEY, null);
    storageSet(sessionStorage, SESSION_PASSWORD_KEY, null);
}

export function webDavTargetKey(config = getWebDavConfig()) {
    return config?.id ? `webdav:${config.id}` : 'webdav:unconfigured';
}

function validateConfig(config) {
    if (!config?.url) throw new Error('请先在设置中填写 WebDAV 地址');
    if (!config.password) throw new Error('当前会话没有 WebDAV 密码，请到设置中重新填写');
    return {
        ...config,
        url: normalizeUrl(config.url),
        root: normalizeRoot(config.root)
    };
}

function createClient(rawConfig) {
    const config = validateConfig(rawConfig);
    const auth = 'Basic ' + utf8Base64(`${config.username}:${config.password}`);
    const rootParts = config.root.split('/');

    function urlFor(parts = [], rootDepth = rootParts.length) {
        const segments = [...rootParts.slice(0, rootDepth), ...parts]
            .map((part) => encodeURIComponent(String(part)));
        return `${config.url}/${segments.join('/')}`;
    }

    async function request(parts, options = {}, allowed = [], rootDepth = rootParts.length) {
        let response;
        try {
            response = await fetch(urlFor(parts, rootDepth), {
                mode: 'cors',
                credentials: 'omit',
                ...options,
                headers: { Authorization: auth, ...(options.headers || {}) }
            });
        } catch (err) {
            throw new Error(`无法连接 WebDAV。请检查地址、网络和 CORS 设置：${err.message || err}`);
        }
        if (!response.ok && !allowed.includes(response.status)) {
            const err = new Error(response.status === 401 || response.status === 403
                ? 'WebDAV 认证失败，请检查用户名和密码'
                : `WebDAV 请求失败（HTTP ${response.status}）`);
            err.status = response.status;
            throw err;
        }
        return response;
    }

    async function ensureCollection(parts) {
        await request(parts, { method: 'MKCOL' }, [301, 405]);
    }

    async function ensureRoot() {
        for (let depth = 1; depth <= rootParts.length; depth++) {
            await request([], { method: 'MKCOL' }, [301, 405], depth);
        }
    }

    async function ensureGameDirectories(gameId) {
        await ensureRoot();
        await ensureCollection(['games']);
        await ensureCollection(['games', gameId]);
        await ensureCollection(['games', gameId, 'revisions']);
    }

    async function readManifest(gameId) {
        const response = await request(['games', gameId, 'manifest.json'], {
            method: 'GET',
            headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' }
        }, [404]);
        if (response.status === 404) return { manifest: null, etag: null };
        let manifest;
        try { manifest = await response.json(); }
        catch { throw new Error(`《${gameId}》的 WebDAV manifest.json 无法解析`); }
        if (manifest?.version !== MANIFEST_VERSION || manifest.gameId !== gameId ||
            !Array.isArray(manifest.revisions)) {
            throw new Error(`《${gameId}》的 WebDAV manifest.json 格式不受支持`);
        }
        const etag = response.headers.get('ETag');
        if (!etag) {
            throw new Error('WebDAV 未向浏览器暴露 ETag，无法安全处理多设备同步');
        }
        return { manifest, etag };
    }

    async function writeManifest(gameId, manifest, etag) {
        const headers = { 'Content-Type': 'application/json; charset=utf-8' };
        if (etag) headers['If-Match'] = etag;
        else headers['If-None-Match'] = '*';
        const response = await request(['games', gameId, 'manifest.json'], {
            method: 'PUT',
            headers,
            body: JSON.stringify(manifest, null, 2)
        }, [409, 412]);
        if (response.status === 409 || response.status === 412) {
            const err = new Error('WebDAV 存档已在其他设备更新');
            err.status = 409;
            throw err;
        }
    }

    return { config, request, ensureRoot, ensureCollection, ensureGameDirectories, readManifest, writeManifest };
}

function revisionJson(value, gameId) {
    if (!value || typeof value !== 'object' || !value.id || !value.archive) return null;
    return {
        id: String(value.id),
        gameId,
        parentRevisionId: value.parentRevisionId || null,
        contentHash: String(value.contentHash || ''),
        archiveSha256: String(value.archiveSha256 || ''),
        archive: String(value.archive),
        byteSize: Number(value.byteSize || 0),
        fileCount: Number(value.fileCount || 0),
        deviceId: String(value.deviceId || ''),
        deviceName: String(value.deviceName || '未知设备'),
        createdAt: Number(value.createdAt || 0)
    };
}

function revisionsFor(manifest, gameId) {
    return (manifest?.revisions || []).map((value) => revisionJson(value, gameId)).filter(Boolean);
}

export function createWebDavBackend(rawConfig) {
    const client = createClient(rawConfig);
    const targetKey = webDavTargetKey(client.config);

    async function list(games) {
        const saves = [];
        for (const game of games) {
            const { manifest } = await client.readManifest(game.id);
            const revisions = revisionsFor(manifest, game.id);
            const head = revisions.find((item) => item.id === manifest?.head) || null;
            if (head) saves.push(head);
        }
        return { saves, usage: null };
    }

    async function history(gameId) {
        const { manifest } = await client.readManifest(gameId);
        const revisions = revisionsFor(manifest, gameId);
        const head = revisions.find((item) => item.id === manifest?.head);
        return head ? [head, ...revisions.filter((item) => item.id !== head.id)] : revisions;
    }

    async function upload(game, archive, metadata, baseRevision) {
        await client.ensureGameDirectories(game.id);
        const current = await client.readManifest(game.id);
        const revisions = revisionsFor(current.manifest, game.id);
        const head = revisions.find((item) => item.id === current.manifest?.head) || null;
        if (head?.contentHash === metadata.contentHash) return head;
        if ((head?.id || null) !== (baseRevision || null)) {
            const err = new Error('WebDAV 存档已在其他设备更新');
            err.status = 409;
            err.head = head;
            throw err;
        }

        const id = crypto.randomUUID();
        const archiveName = `${id}.zip`;
        await client.request(['games', game.id, 'revisions', archiveName], {
            method: 'PUT',
            headers: { 'Content-Type': 'application/zip', 'If-None-Match': '*' },
            body: archive.bytes
        });
        const revision = {
            id,
            gameId: game.id,
            parentRevisionId: head?.id || null,
            contentHash: metadata.contentHash,
            archiveSha256: archive.sha256,
            archive: `revisions/${archiveName}`,
            byteSize: archive.bytes.byteLength,
            fileCount: metadata.fileCount,
            deviceId: metadata.device.id,
            deviceName: metadata.device.name,
            createdAt: Date.now()
        };
        const allRevisions = [revision, ...revisions];
        const keptRevisions = allRevisions.slice(0, KEEP_REVISIONS);
        const prunedRevisions = allRevisions.slice(KEEP_REVISIONS);
        const manifest = {
            version: MANIFEST_VERSION,
            gameId: game.id,
            head: id,
            revisions: keptRevisions
        };
        try {
            await client.writeManifest(game.id, manifest, current.etag);
        } catch (err) {
            if (err.status === 409) {
                await client.request(['games', game.id, 'revisions', archiveName],
                    { method: 'DELETE' }, [404]).catch(() => {});
                const latest = await client.readManifest(game.id);
                const latestRevisions = revisionsFor(latest.manifest, game.id);
                err.head = latestRevisions.find((item) => item.id === latest.manifest?.head) || null;
            }
            throw err;
        }
        for (const old of prunedRevisions) {
            if (!keptRevisions.some((item) => item.archive === old.archive)) {
                await client.request(['games', game.id, ...old.archive.split('/')],
                    { method: 'DELETE' }, [404]).catch(() => {});
            }
        }
        return revision;
    }

    async function archive(gameId, revision) {
        const path = String(revision.archive || '');
        if (!/^revisions\/[0-9a-f-]+\.zip$/i.test(path)) {
            throw new Error('WebDAV 存档归档路径无效');
        }
        return client.request(['games', gameId, ...path.split('/')], { method: 'GET' });
    }

    async function restore(game, revisionId, device) {
        await client.ensureGameDirectories(game.id);
        const current = await client.readManifest(game.id);
        const revisions = revisionsFor(current.manifest, game.id);
        const source = revisions.find((item) => item.id === revisionId);
        const head = revisions.find((item) => item.id === current.manifest?.head) || null;
        if (!source) throw new Error('WebDAV 中找不到这个历史版本');
        if (head?.id === source.id) return head;
        const restored = {
            ...source,
            id: crypto.randomUUID(),
            parentRevisionId: head?.id || null,
            deviceId: device.id,
            deviceName: device.name,
            createdAt: Date.now()
        };
        const manifest = {
            version: MANIFEST_VERSION,
            gameId: game.id,
            head: restored.id,
            revisions: [restored, ...revisions].slice(0, KEEP_REVISIONS)
        };
        await client.writeManifest(game.id, manifest, current.etag);
        return restored;
    }

    return {
        kind: 'webdav',
        targetKey,
        label: client.config.name,
        requiresAccount: false,
        list,
        history,
        upload,
        archive,
        restore
    };
}

export async function testWebDavConnection(config) {
    const client = createClient(config);
    await client.ensureRoot();
    const name = `.krkr2-test-${crypto.randomUUID()}.json`;
    await client.request([name], {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'If-None-Match': '*' },
        body: JSON.stringify({ createdAt: Date.now() })
    });
    const duplicate = await client.request([name], {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'If-None-Match': '*' },
        body: JSON.stringify({ duplicateAt: Date.now() })
    }, [409, 412]);
    if (duplicate.status !== 409 && duplicate.status !== 412) {
        await client.request([name], { method: 'DELETE' }).catch(() => {});
        throw new Error('连接成功，但 WebDAV 未执行 If-None-Match 条件写入');
    }
    const response = await client.request([name], { method: 'GET' });
    await response.arrayBuffer();
    const etag = response.headers.get('ETag');
    if (!etag) {
        await client.request([name], { method: 'DELETE' }).catch(() => {});
        throw new Error('连接成功，但服务端未通过 CORS 暴露 ETag 响应头');
    }
    await client.request([name], {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'If-Match': etag },
        body: JSON.stringify({ updatedAt: Date.now() })
    });
    const stale = await client.request([name], {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'If-Match': etag },
        body: JSON.stringify({ staleWriteAt: Date.now() })
    }, [409, 412]);
    if (stale.status !== 409 && stale.status !== 412) {
        await client.request([name], { method: 'DELETE' }).catch(() => {});
        throw new Error('连接成功，但 WebDAV 未执行 If-Match 条件写入，无法安全处理多设备同步');
    }
    await client.request([name], { method: 'DELETE' });
    return true;
}
