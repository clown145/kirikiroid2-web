/*
 * 游戏资源的连续前缀缓存。
 *
 * 每个游戏只有一个可读目录；JSON 清单里的 name 直接成为该目录下的
 * 相对路径。单个 ZIP/XP3 则使用 URL 中的原始文件名。完整下载与边玩边下
 * 都顺序追加同一份文件，只持久化 downloadedBytes，不维护任意 RangeSet。
 *
 * 游戏提前读取尚未下载到的位置时，VLFS 临时发 Range 请求并直接返回，
 * 不把随机区间写进文件。这样首次完整下载每个资源只需一个 GET，续传也
 * 只需一个从 downloadedBytes 到结尾的 GET。
 */
(function () {
    'use strict';

    var SCHEMA_VERSION = 2;
    var OPFS_ROOT_DIR = 'krkr2-cache';
    var INDEX_FILE = '.krkr2-cache.json';
    var LEGACY_INDEX_FILE = 'index.json';
    var COMMIT_BATCH_BYTES = 16 * 1024 * 1024;
    var QUOTA_FRACTION = 0.5;
    var QUOTA_CAP_BYTES = 20 * 1024 * 1024 * 1024;
    var SINGLE_RESOURCE_ID = '@source';
    var FOLDER_BLOCKED_EXTENSIONS = new Set([
        'bat', 'cmd', 'com', 'cpl', 'dll', 'drv', 'exe', 'lnk', 'msi', 'msp',
        'pif', 'ps1', 'reg', 'scr', 'sys', 'vb', 'vbe', 'vbs', 'ws', 'wsc',
        'wsf', 'wsh'
    ]);

    function folderPermissionError() {
        var error = new Error('已绑定的游戏下载文件夹需要重新授权');
        error.code = 'folder-permission-required';
        return error;
    }

    function fnv1a(s) {
        var h = 0x811c9dc5;
        for (var i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = (h * 0x01000193) >>> 0;
        }
        return h.toString(36);
    }

    function trimCodePoints(value, max) {
        return Array.from(value).slice(0, max).join('');
    }

    function safePathSegment(value, fallback) {
        var s = String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
        s = s.replace(/[. ]+$/g, '').trim();
        if (!s || s === '.' || s === '..') s = fallback || '_';
        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)) s = '_' + s;
        return trimCodePoints(s, 100);
    }

    function safeGameDirName(title, gameKey) {
        var readable = safePathSegment(title || gameKey, 'game');
        return trimCodePoints(readable, 72) + '-' + fnv1a(String(gameKey));
    }

    function legacyDirName(key) {
        var base = String(key).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40);
        return (base || 'game') + '-' + fnv1a(String(key));
    }

    function safeFileName(name) {
        return safePathSegment(name, 'data.bin');
    }

    function safeResourcePath(path) {
        var parts = String(path || '').replace(/\\/g, '/').split('/');
        var out = [];
        for (var i = 0; i < parts.length; i++) {
            if (!parts[i] || parts[i] === '.') continue;
            if (parts[i] === '..') {
                if (out.length) out.pop();
                continue;
            }
            out.push(safePathSegment(parts[i], '_'));
        }
        return out.join('/') || 'data.bin';
    }

    function folderBlocksPath(path) {
        var name = path.substring(path.lastIndexOf('/') + 1);
        var dot = name.lastIndexOf('.');
        if (dot < 0) return false;
        return FOLDER_BLOCKED_EXTENSIONS.has(name.substring(dot + 1).toLowerCase());
    }

    /*
     * Chromium 在 Windows 上禁止网站向用户目录创建 .dll/.exe 等可执行文件。
     * 这些资源仍以 manifest 原路径注册给 VLFS；只有实体文件落到内部保留区。
     */
    function folderStoragePath(path) {
        var name = path.substring(path.lastIndexOf('/') + 1);
        return '.krkr2-cache/files/' + safePathSegment(name, 'resource') + '-' +
            fnv1a(path.toLowerCase()) + '.bin';
    }

    function resourceId(resourceKey) {
        return resourceKey || SINGLE_RESOURCE_ID;
    }

    function liveKey(gameKey, id) {
        return JSON.stringify([String(gameKey), id]);
    }

    async function readJson(dir, name) {
        try {
            var h = await dir.getFileHandle(name);
            return JSON.parse(await (await h.getFile()).text());
        } catch (e) {
            return null;
        }
    }

    async function writeJson(dir, name, value) {
        var h = await dir.getFileHandle(name, { create: true });
        var w = await h.createWritable();
        await w.write(new Blob([JSON.stringify(value)]));
        await w.close();
    }

    async function removeEntrySafe(dir, name) {
        try {
            await dir.removeEntry(name, { recursive: true });
            return true;
        } catch (e) {
            return false;
        }
    }

    async function directoryForPath(root, path, create) {
        var parts = path.split('/');
        var dir = root;
        for (var i = 0; i < parts.length - 1; i++) {
            dir = await dir.getDirectoryHandle(parts[i], { create: !!create });
        }
        return { dir: dir, name: parts[parts.length - 1] };
    }

    async function fileHandleForPath(root, path, create) {
        var target = await directoryForPath(root, path, create);
        return await target.dir.getFileHandle(target.name, { create: !!create });
    }

    async function removeFilePath(root, path) {
        try {
            var target = await directoryForPath(root, path, false);
            await target.dir.removeEntry(target.name);
        } catch (e) {}
    }

    async function truncateFile(handle) {
        var w = await handle.createWritable();
        await w.close();
    }

    function GameCache(store, gameKey, id, gameDir, fileHandle, record) {
        this.store = store;
        this.gameKey = gameKey;
        this.resourceKey = id === SINGLE_RESOURCE_ID ? '' : id;
        this.resourceId = id;
        this.size = record.size;
        this.name = record.path;
        this.path = record.path;
        this.url = record.url;
        this.fingerprint = record.fingerprint;

        this._gameDir = gameDir;
        this._fileHandle = fileHandle;
        this._file = null;
        this._record = record;
        this._committed = Math.max(0, Math.min(record.downloadedBytes || 0, record.size));
        this._pending = [];
        this._pendingBytes = 0;
        this._flushing = [];
        this._flushingBytes = 0;
        this._flushChain = Promise.resolve();
        this._retiring = false;
        this._closed = false;
    }

    GameCache.prototype._refreshFile = async function () {
        try { this._file = await this._fileHandle.getFile(); }
        catch (e) { this._file = null; }
    };

    GameCache.prototype._memorySegments = function () {
        return this._flushing.length ? this._flushing.concat(this._pending) : this._pending;
    };

    GameCache.prototype.read = async function (pos, len) {
        if (len <= 0) return new Uint8Array(0);
        if (pos < 0 || pos + len > this.availableBytes()) return null;

        var out = new Uint8Array(len);
        var diskEnd = Math.min(pos + len, this._committed);
        if (pos < diskEnd) {
            if (!this._file) return null;
            try {
                var disk = await this._file.slice(pos, diskEnd).arrayBuffer();
                if (disk.byteLength !== diskEnd - pos) return null;
                out.set(new Uint8Array(disk), 0);
            } catch (e) {
                return null;
            }
        }

        var covered = Math.max(pos, this._committed);
        var segments = this._memorySegments();
        for (var i = 0; i < segments.length && covered < pos + len; i++) {
            var segment = segments[i];
            var start = Math.max(covered, segment.pos);
            var end = Math.min(pos + len, segment.pos + segment.bytes.length);
            if (start >= end) continue;
            out.set(segment.bytes.subarray(start - segment.pos, end - segment.pos), start - pos);
            covered = end;
        }
        return covered >= pos + len ? out : null;
    };

    /** 只接受紧接当前连续前缀的数据。随机按需读不得调用本方法。 */
    GameCache.prototype.append = function (pos, bytes) {
        if (this._retiring || this._closed || !bytes || !bytes.length) return false;
        var expected = this.availableBytes();
        if (pos !== expected) return false;
        var end = Math.min(pos + bytes.length, this.size);
        if (end <= pos) return true;
        var value = bytes.length === end - pos ? bytes : bytes.subarray(0, end - pos);
        this._pending.push({ pos: pos, bytes: value });
        this._pendingBytes += value.length;
        return true;
    };

    GameCache.prototype.shouldFlush = function () {
        return this._pendingBytes >= COMMIT_BATCH_BYTES;
    };

    GameCache.prototype.flush = function () {
        var self = this;
        var next = this._flushChain.catch(function () {}).then(function () {
            return self._doFlush();
        });
        this._flushChain = next.catch(function () {});
        return next;
    };

    GameCache.prototype._doFlush = async function () {
        if (!this._pending.length) return;
        var batch = this._pending;
        var batchBytes = this._pendingBytes;
        this._pending = [];
        this._pendingBytes = 0;
        this._flushing = batch;
        this._flushingBytes = batchBytes;

        var writer = null;
        try {
            writer = await this._fileHandle.createWritable({ keepExistingData: true });
            for (var i = 0; i < batch.length; i++) {
                await writer.write({
                    type: 'write', position: batch[i].pos, data: batch[i].bytes
                });
            }
            await writer.close();
            writer = null;
            await this._refreshFile();
        } catch (e) {
            if (writer) { try { await writer.abort(); } catch (ignored) {} }
            this._pending = batch.concat(this._pending);
            this._pendingBytes += batchBytes;
            this._flushing = [];
            this._flushingBytes = 0;
            if (this.store.kind === 'folder' && window.KrKr2Folder &&
                !await window.KrKr2Folder.tryRestore()) {
                throw folderPermissionError();
            }
            throw e;
        }

        this._committed += batchBytes;
        this._flushing = [];
        this._flushingBytes = 0;
        this._record.downloadedBytes = this._committed;
        try {
            await this.store._noteBytes(this.gameKey, this.resourceId, this._committed);
        } catch (e) {
            if (this.store.kind === 'folder' && window.KrKr2Folder &&
                !await window.KrKr2Folder.tryRestore()) {
                throw folderPermissionError();
            }
            throw e;
        }
    };

    /** 用一个完整响应替换当前前缀，供小型 JSON manifest 使用。 */
    GameCache.prototype.replace = async function (bytes) {
        await this.reset();
        if (bytes && bytes.length) {
            if (!this.append(0, bytes)) throw new Error('cache append rejected');
            await this.flush();
        }
    };

    GameCache.prototype.reset = async function () {
        try { await this._flushChain; } catch (e) {}
        this._pending = [];
        this._pendingBytes = 0;
        this._flushing = [];
        this._flushingBytes = 0;
        await truncateFile(this._fileHandle);
        await this._refreshFile();
        this._committed = 0;
        this._record.downloadedBytes = 0;
        await this.store._noteBytes(this.gameKey, this.resourceId, 0);
    };

    GameCache.prototype.availableBytes = function () {
        return this._committed + this._flushingBytes + this._pendingBytes;
    };

    GameCache.prototype.bytes = function () { return this._committed; };

    GameCache.prototype.isComplete = function (size) {
        return size > 0 && this.availableBytes() >= size;
    };

    GameCache.prototype.complete = function () {
        return this.size > 0 && this._committed >= this.size;
    };

    GameCache.prototype.segmentCount = function () {
        return this.availableBytes() > 0 ? 1 : 0;
    };

    GameCache.prototype.close = async function () {
        this._retiring = true;
        try { await this.flush(); } catch (e) {}
        this._closed = true;
    };

    GameCache.prototype.discard = function () {
        this._retiring = true;
        this._closed = true;
        this._pending = [];
        this._pendingBytes = 0;
        this._flushing = [];
        this._flushingBytes = 0;
        this._file = null;
    };

    function CacheStore(root, kind) {
        this.root = root;
        this.kind = kind;
        this._index = null;
        this._indexChain = Promise.resolve();
        this._live = new Map();
    }

    CacheStore.prototype._retire = async function (gameKey, id, discardPending) {
        var key = liveKey(gameKey, id);
        var live = this._live.get(key);
        if (!live) return;
        live._retiring = true;
        if (discardPending) {
            try { await live._flushChain; } catch (e) {}
        } else {
            try { await live.flush(); } catch (e) {}
        }
        live.discard();
        this._live.delete(key);
    };

    CacheStore.prototype._loadIndex = async function () {
        if (this._index) return this._index;
        var idx = await readJson(this.root, INDEX_FILE);
        var legacy = null;
        if (!idx) legacy = await readJson(this.root, LEGACY_INDEX_FILE);
        var legacyValid = legacy && legacy.version === 1 && legacy.games &&
            typeof legacy.games === 'object';
        if (legacyValid) {
            var legacyKeys = Object.keys(legacy.games);
            if (!legacyKeys.length) legacyValid = false;
            for (var vi = 0; vi < legacyKeys.length; vi++) {
                var legacyRecord = legacy.games[legacyKeys[vi]];
                if (!legacyRecord || legacyRecord.dir !== legacyDirName(legacyKeys[vi]) ||
                    typeof legacyRecord.size !== 'number') {
                    legacyValid = false;
                    break;
                }
            }
        }
        if (legacyValid) {
            // v1 的文件可能包含任意稀疏洞，不能冒充连续前缀；只删除索引明确
            // 归属缓存的目录，不碰用户选择目录里的其他内容。
            var legacyDirs = new Set();
            for (var oldKey in legacy.games) {
                if (!Object.prototype.hasOwnProperty.call(legacy.games, oldKey)) continue;
                if (legacy.games[oldKey].dir) legacyDirs.add(legacy.games[oldKey].dir);
            }
            for (var dirName of legacyDirs) await removeEntrySafe(this.root, dirName);
            await removeEntrySafe(this.root, LEGACY_INDEX_FILE);
        }
        if (!idx || idx.version !== SCHEMA_VERSION || typeof idx.games !== 'object') {
            idx = { version: SCHEMA_VERSION, games: {} };
            try { await writeJson(this.root, INDEX_FILE, idx); } catch (e) {}
        }
        this._index = idx;
        return idx;
    };

    CacheStore.prototype._saveIndex = function () {
        var self = this;
        var next = this._indexChain.catch(function () {}).then(async function () {
            if (!self._index) return;
            try { await writeJson(self.root, INDEX_FILE, self._index); }
            catch (e) { console.warn('[cache] 索引写入失败：', e); }
        });
        this._indexChain = next.catch(function () {});
        return next;
    };

    CacheStore.prototype._noteBytes = async function (gameKey, id, bytes) {
        var idx = await this._loadIndex();
        var game = idx.games[gameKey];
        if (!game || !game.resources || !game.resources[id]) return;
        game.resources[id].downloadedBytes = bytes;
        await this._saveIndex();
    };

    CacheStore.prototype.touch = async function (gameKey) {
        var idx = await this._loadIndex();
        if (!idx.games[gameKey]) return;
        idx.games[gameKey].lastPlayed = Date.now();
        await this._saveIndex();
    };

    CacheStore.prototype.retainResources = async function (gameKey, resourceKeys) {
        var idx = await this._loadIndex();
        var game = idx.games[gameKey];
        if (!game || !game.resources) return;
        var keep = new Set((resourceKeys || []).map(resourceId));
        var gameDir;
        try { gameDir = await this.root.getDirectoryHandle(game.dir); }
        catch (e) { gameDir = null; }
        var ids = Object.keys(game.resources);
        var changed = false;
        for (var i = 0; i < ids.length; i++) {
            var id = ids[i];
            if (keep.has(id)) continue;
            await this._retire(gameKey, id, true);
            if (gameDir) {
                await removeFilePath(gameDir,
                    game.resources[id].storagePath || game.resources[id].path);
            }
            delete game.resources[id];
            changed = true;
        }
        if (changed) await this._saveIndex();
    };

    CacheStore.prototype.open = async function (gameKey, info) {
        var id = resourceId(info.resourceKey || '');
        if (id === SINGLE_RESOURCE_ID) await this.retainResources(gameKey, ['']);
        await this._retire(gameKey, id, false);

        var idx = await this._loadIndex();
        var game = idx.games[gameKey];
        if (!game) {
            game = {
                gameKey: gameKey,
                dir: safeGameDirName(info.title || gameKey, gameKey),
                title: info.title || gameKey,
                url: info.url || '',
                lastPlayed: Date.now(),
                resources: {}
            };
            idx.games[gameKey] = game;
        }
        if (!game.resources || typeof game.resources !== 'object') game.resources = {};
        if (info.title) game.title = info.title;
        game.url = info.url || game.url || '';
        game.lastPlayed = Date.now();

        var path = safeResourcePath(info.resourcePath || info.name);
        for (var otherId in game.resources) {
            if (!Object.prototype.hasOwnProperty.call(game.resources, otherId) ||
                otherId === id) continue;
            if (String(game.resources[otherId].path || '').toLowerCase() ===
                path.toLowerCase()) {
                throw new Error('缓存资源路径冲突：' + path);
            }
        }
        var record = game.resources[id];
        var oldStoragePath = record && safeResourcePath(record.storagePath || record.path);
        var storagePath = this.kind === 'folder' && folderBlocksPath(path)
            ? folderStoragePath(path)
            : path;
        var stale = !record || record.fingerprint !== info.fingerprint ||
            record.size !== info.size || record.path !== path ||
            oldStoragePath !== storagePath;

        var gameDir;
        try { gameDir = await this.root.getDirectoryHandle(game.dir, { create: true }); }
        catch (e) {
            throw new Error('无法创建游戏目录：' + (e && e.message || e));
        }

        if (record && oldStoragePath !== storagePath) {
            await removeFilePath(gameDir, oldStoragePath);
        }
        var fileHandle;
        try {
            fileHandle = await fileHandleForPath(gameDir, storagePath, true);
            if (stale) await truncateFile(fileHandle);
        } catch (firstError) {
            var fallbackPath = folderStoragePath(path);
            if (this.kind !== 'folder' || storagePath === fallbackPath) {
                throw new Error('无法创建资源路径 ' + path + '：' +
                    (firstError && firstError.message || firstError));
            }

            // Chrome 的受限扩展名列表会变化；未预知的拒绝也自动落到保留区。
            storagePath = fallbackPath;
            stale = true;
            if (oldStoragePath && oldStoragePath !== storagePath) {
                await removeFilePath(gameDir, oldStoragePath);
            }
            try {
                fileHandle = await fileHandleForPath(gameDir, storagePath, true);
                await truncateFile(fileHandle);
            } catch (fallbackError) {
                throw new Error('无法创建资源路径 ' + path + '：' +
                    (fallbackError && fallbackError.message || fallbackError));
            }
        }

        if (stale) {
            if (record) console.log('[cache] 源已变化，重置连续下载：' + gameKey + '/' + path);
            record = {
                resourceKey: info.resourceKey || '',
                path: path,
                storagePath: storagePath,
                url: info.url,
                size: info.size,
                fingerprint: info.fingerprint,
                downloadedBytes: 0
            };
            game.resources[id] = record;
        } else {
            record.url = info.url;
            record.storagePath = storagePath;
        }

        var cache = new GameCache(this, gameKey, id, gameDir, fileHandle, record);
        await cache._refreshFile();
        if (!cache._file || cache._file.size < cache._committed) {
            cache._committed = cache._file ? Math.min(cache._file.size, info.size) : 0;
            record.downloadedBytes = cache._committed;
        }

        this._live.set(liveKey(gameKey, id), cache);
        await this._saveIndex();
        return cache;
    };

    CacheStore.prototype.limit = async function () {
        if (this.kind === 'folder') return Infinity;
        var quota = 0;
        try { quota = (await navigator.storage.estimate()).quota || 0; } catch (e) {}
        if (!quota) return QUOTA_CAP_BYTES;
        return Math.min(QUOTA_CAP_BYTES, Math.floor(quota * QUOTA_FRACTION));
    };

    CacheStore.prototype.list = async function () {
        var idx = await this._loadIndex();
        var out = [];
        for (var key in idx.games) {
            if (!Object.prototype.hasOwnProperty.call(idx.games, key)) continue;
            var game = idx.games[key];
            var row = {
                gameKey: key,
                title: game.title || key,
                url: game.url || '',
                size: 0,
                bytes: 0,
                lastPlayed: game.lastPlayed || 0,
                complete: true,
                resources: 0
            };
            var resources = game.resources || {};
            for (var id in resources) {
                if (!Object.prototype.hasOwnProperty.call(resources, id)) continue;
                var rec = resources[id];
                row.size += rec.size || 0;
                row.bytes += rec.downloadedBytes || 0;
                row.complete = row.complete && rec.size > 0 &&
                    (rec.downloadedBytes || 0) >= rec.size;
                row.resources++;
            }
            if (!row.resources) row.complete = false;
            out.push(row);
        }
        out.sort(function (a, b) { return b.lastPlayed - a.lastPlayed; });
        return out;
    };

    CacheStore.prototype.usage = async function () {
        var list = await this.list();
        var total = 0;
        for (var i = 0; i < list.length; i++) total += list[i].bytes;
        return { bytes: total, limit: await this.limit(), games: list.length };
    };

    CacheStore.prototype.remove = async function (gameKey) {
        var idx = await this._loadIndex();
        var game = idx.games[gameKey];
        if (!game) return;
        var ids = Object.keys(game.resources || {});
        for (var i = 0; i < ids.length; i++) await this._retire(gameKey, ids[i], true);
        await removeEntrySafe(this.root, game.dir);
        delete idx.games[gameKey];
        await this._saveIndex();
    };

    CacheStore.prototype.removeAll = async function () {
        var idx = await this._loadIndex();
        var games = Object.keys(idx.games);
        for (var i = 0; i < games.length; i++) await this.remove(games[i]);
        this._index = { version: SCHEMA_VERSION, games: {} };
        await this._saveIndex();
    };

    CacheStore.prototype.enforceQuota = async function (exceptKey) {
        var limit = await this.limit();
        if (!isFinite(limit)) return [];
        var list = await this.list();
        var total = 0;
        for (var i = 0; i < list.length; i++) total += list[i].bytes;
        if (total <= limit) return [];
        list.sort(function (a, b) { return a.lastPlayed - b.lastPlayed; });
        var evicted = [];
        for (var j = 0; j < list.length && total > limit; j++) {
            if (list[j].gameKey === exceptKey) continue;
            total -= list[j].bytes;
            await this.remove(list[j].gameKey);
            evicted.push(list[j].gameKey);
        }
        if (evicted.length) console.log('[cache] 超出上限，已淘汰：' + evicted.join(', '));
        return evicted;
    };

    var opfsStore = null;
    var folderStore = null;
    var folderRoot = null;

    async function openOpfs() {
        if (opfsStore) return opfsStore;
        try {
            var root = await navigator.storage.getDirectory();
            var dir = await root.getDirectoryHandle(OPFS_ROOT_DIR, { create: true });
            opfsStore = new CacheStore(dir, 'opfs');
            return opfsStore;
        } catch (e) {
            console.warn('[cache] OPFS 不可用：', e);
            return null;
        }
    }

    async function openFolder(handle) {
        if (!handle) return null;
        if (folderStore && folderRoot === handle) return folderStore;
        folderStore = new CacheStore(handle, 'folder');
        folderRoot = handle;
        return folderStore;
    }

    async function activeStore() {
        if (window.KrKr2Folder && window.KrKr2Folder.supported()) {
            try {
                var handle = await window.KrKr2Folder.tryRestore();
                if (handle) return await openFolder(handle);
                if (await window.KrKr2Folder.hasBinding()) {
                    throw folderPermissionError();
                }
            } catch (e) {
                if (e && e.code === 'folder-permission-required') throw e;
            }
        }
        return await openOpfs();
    }

    async function requestPersist() {
        try {
            if (!navigator.storage || !navigator.storage.persist) return false;
            if (await navigator.storage.persisted()) return true;
            return await navigator.storage.persist();
        } catch (e) {
            return false;
        }
    }

    window.KrKr2CacheStore = {
        openOpfs: openOpfs,
        openFolder: openFolder,
        activeStore: activeStore,
        requestPersist: requestPersist,
        safeDirName: function (key) { return safeGameDirName(key, key); },
        safeGameDirName: safeGameDirName,
        safeResourcePath: safeResourcePath,
        folderPermissionError: folderPermissionError,
        COMMIT_BATCH_BYTES: COMMIT_BATCH_BYTES
    };
})();
