// 按游戏隔离的远程资源分片缓存。
//
// 这里只保存远程归档的原始字节与由 ZIP 解压得到的临时文件；存档仍由
// js/storage/idb.js 管理。删除本目录不会触碰任何 save space。
(function () {
    'use strict';

    var ROOT_DIR = 'krkr2-game-cache';
    var GAMES_DIR = 'games';
    var SCHEMA_VERSION = 1;
    var metadataQueue = Promise.resolve();
    var persistenceRequested = false;
    var activeCaches = new Set();

    function hasOpfs() {
        return typeof navigator !== 'undefined' && navigator.storage &&
            typeof navigator.storage.getDirectory === 'function';
    }

    function bytesToHex(bytes) {
        var out = '';
        for (var i = 0; i < bytes.length; i++)
            out += bytes[i].toString(16).padStart(2, '0');
        return out;
    }

    async function hashText(value) {
        var data = new TextEncoder().encode(String(value));
        var digest = await crypto.subtle.digest('SHA-256', data);
        return bytesToHex(new Uint8Array(digest));
    }

    async function readJson(dir, name) {
        try {
            var handle = await dir.getFileHandle(name);
            return JSON.parse(await (await handle.getFile()).text());
        } catch (e) {
            return null;
        }
    }

    async function writeJson(dir, name, value) {
        var handle = await dir.getFileHandle(name, { create: true });
        var writable = await handle.createWritable();
        try {
            await writable.write(JSON.stringify(value));
            await writable.close();
        } catch (e) {
            try { await writable.abort(); } catch (ignored) {}
            throw e;
        }
    }

    async function getGamesDir(create) {
        if (!hasOpfs()) return null;
        var root = await navigator.storage.getDirectory();
        var cacheRoot = await root.getDirectoryHandle(
            ROOT_DIR, { create: create !== false });
        return await cacheRoot.getDirectoryHandle(
            GAMES_DIR, { create: create !== false });
    }

    async function requestPersistence() {
        if (persistenceRequested || !navigator.storage) return;
        persistenceRequested = true;
        try {
            if (typeof navigator.storage.persist === 'function')
                await navigator.storage.persist();
        } catch (e) {
            console.warn('[game-cache] persistent storage request failed:', e);
        }
    }

    function serializeMetadata(action) {
        var result = metadataQueue.then(action, action);
        metadataQueue = result.catch(function () {});
        return result;
    }

    function flushSourceUsage(cache) {
        if (!cache) return Promise.resolve();
        if (cache.usageTimer) {
            clearTimeout(cache.usageTimer);
            cache.usageTimer = 0;
        }
        return serializeMetadata(async function () {
            var meta = await readJson(cache.gameDir, 'metadata.json');
            if (!meta || !meta.sources ||
                !meta.sources[cache.slotKey] ||
                meta.sources[cache.slotKey].sourceKey !== cache.sourceKey)
                return;
            var source = meta.sources[cache.slotKey];
            source.blockBytes = Math.max(0, cache.blockBytes);
            source.expandedBytes = Math.max(0, cache.expandedBytes);
            source.cachedBytes = source.blockBytes + source.expandedBytes;
            meta.updatedAt = Date.now();
            await writeJson(cache.gameDir, 'metadata.json', meta);
        });
    }

    function queueUsageFlush(cache, delay) {
        if (!cache || cache.usageTimer) return;
        cache.usageTimer = setTimeout(function () {
            cache.usageTimer = 0;
            flushSourceUsage(cache).catch(function (e) {
                console.warn('[game-cache] usage update failed:', e);
            });
        }, delay || 250);
    }

    async function openSourceUnlocked(gameId, descriptor) {
        if (!gameId || !descriptor || !descriptor.fingerprint)
            return null;
        gameId = String(gameId);

        await requestPersistence();
        var games = await getGamesDir(true);
        if (!games) return null;

        var gameKey = await hashText(gameId);
        var gameDir = await games.getDirectoryHandle(gameKey, { create: true });
        var sourcesDir = await gameDir.getDirectoryHandle(
            'sources', { create: true });
        var slot = descriptor.slot || descriptor.url || descriptor.path || 'source';
        var slotKey = await hashText(slot);
        var strongContentIdentity =
            String(descriptor.fingerprint).startsWith('sha256-');
        var identity = JSON.stringify({
            kind: descriptor.kind || 'remote',
            slot: slot,
            // 内容 SHA 足以跨签名 URL 复用；ETag/Last-Modified 只在各自 URL
            // 语境内有意义，必须把 URL 纳入 identity。
            url: strongContentIdentity ? '' : (descriptor.url || ''),
            size: Number(descriptor.size) || 0,
            fingerprint: descriptor.fingerprint
        });
        var sourceKey = await hashText(identity);

        var meta = await readJson(gameDir, 'metadata.json');
        if (!meta || meta.version !== SCHEMA_VERSION || meta.gameId !== gameId) {
            meta = {
                version: SCHEMA_VERSION,
                gameId: gameId,
                updatedAt: Date.now(),
                sources: {}
            };
        }
        if (!meta.sources || typeof meta.sources !== 'object')
            meta.sources = {};

        var previous = meta.sources[slotKey];
        if (previous && previous.sourceKey !== sourceKey) {
            try {
                await sourcesDir.removeEntry(previous.sourceKey, {
                    recursive: true
                });
                console.log('[game-cache] invalidated changed source:', slot);
            } catch (e) {
                console.warn('[game-cache] old source cleanup failed:', e);
            }
        }

        var sourceDir = await sourcesDir.getDirectoryHandle(
            sourceKey, { create: true });
        var blocksDir = await sourceDir.getDirectoryHandle(
            'blocks', { create: true });
        var expandedDir = await sourceDir.getDirectoryHandle(
            'expanded', { create: true });
        await writeJson(sourceDir, 'metadata.json', {
            version: SCHEMA_VERSION,
            identity: identity,
            descriptor: descriptor,
            updatedAt: Date.now()
        });

        meta.updatedAt = Date.now();
        var sameSource = previous && previous.sourceKey === sourceKey;
        meta.sources[slotKey] = {
            sourceKey: sourceKey,
            slot: slot,
            fingerprint: descriptor.fingerprint,
            size: Number(descriptor.size) || 0,
            blockBytes: sameSource ? Number(previous.blockBytes) || 0 : 0,
            expandedBytes: sameSource ? Number(previous.expandedBytes) || 0 : 0,
            cachedBytes: sameSource ? Number(previous.cachedBytes) || 0 : 0
        };
        await writeJson(gameDir, 'metadata.json', meta);

        var cache = {
            gameId: gameId,
            gameKey: gameKey,
            gameDir: gameDir,
            slotKey: slotKey,
            sourceKey: sourceKey,
            sourceDir: sourceDir,
            blocksDir: blocksDir,
            expandedDir: expandedDir,
            blockBytes: meta.sources[slotKey].blockBytes,
            expandedBytes: meta.sources[slotKey].expandedBytes,
            usageTimer: 0
        };
        activeCaches.add(cache);
        return cache;
    }

    async function readBlock(cache, index, expectedSize) {
        if (!cache) return null;
        var name = 'b' + index;
        try {
            var handle = await cache.blocksDir.getFileHandle(name);
            var file = await handle.getFile();
            if (file.size !== expectedSize) {
                try { await cache.blocksDir.removeEntry(name); } catch (ignored) {}
                cache.blockBytes = Math.max(0, cache.blockBytes - expectedSize);
                queueUsageFlush(cache, 250);
                return null;
            }
            return new Uint8Array(await file.arrayBuffer());
        } catch (e) {
            return null;
        }
    }

    async function writeBlock(cache, index, data) {
        if (!cache || !data || !data.length) return;
        var name = 'b' + index;
        var handle = await cache.blocksDir.getFileHandle(name, { create: true });
        var previousSize = 0;
        try { previousSize = (await handle.getFile()).size; } catch (ignored) {}
        var writable = await handle.createWritable();
        try {
            await writable.write(data);
            await writable.close();
            var file = await handle.getFile();
            if (file.size !== data.length)
                throw new Error('block size ' + file.size + ' != ' + data.length);
            cache.blockBytes += data.length - previousSize;
            queueUsageFlush(cache, 250);
        } catch (e) {
            try { await writable.abort(); } catch (ignored) {}
            try { await cache.blocksDir.removeEntry(name); } catch (ignored2) {}
            throw e;
        }
    }

    async function setExpandedBytes(cache, bytes) {
        if (!cache) return;
        cache.expandedBytes = Math.max(0, Number(bytes) || 0);
        await flushSourceUsage(cache);
    }

    async function getGameInfo(gameId) {
        gameId = gameId ? String(gameId) : '';
        var empty = { gameId: gameId, bytes: 0, sourceCount: 0, available: hasOpfs() };
        if (!gameId || !hasOpfs()) return empty;
        try {
            var games = await getGamesDir(false);
            var gameKey = await hashText(gameId);
            var gameDir = await games.getDirectoryHandle(gameKey);
            var meta = await readJson(gameDir, 'metadata.json');
            if (!meta || meta.gameId !== gameId) return empty;
            var sources = Object.values(meta.sources || {});
            var bytes = sources.reduce(function (sum, source) {
                return sum + (Number(source.cachedBytes) || 0);
            }, 0);
            return {
                gameId: gameId,
                bytes: bytes,
                sourceCount: sources.length,
                available: true,
                updatedAt: meta.updatedAt || 0
            };
        } catch (e) {
            return empty;
        }
    }

    async function deleteGame(gameId) {
        if (!gameId || !hasOpfs()) return false;
        gameId = String(gameId);
        try {
            var games = await getGamesDir(false);
            var gameKey = await hashText(gameId);
            await games.removeEntry(gameKey, { recursive: true });
            return true;
        } catch (e) {
            if (e && e.name === 'NotFoundError') return false;
            throw e;
        }
    }

    async function estimate() {
        if (!navigator.storage || typeof navigator.storage.estimate !== 'function')
            return { usage: 0, quota: 0 };
        return await navigator.storage.estimate();
    }

    window.KrKr2GameCache = {
        schemaVersion: SCHEMA_VERSION,
        openSource: function (gameId, descriptor) {
            return serializeMetadata(function () {
                return openSourceUnlocked(gameId, descriptor);
            });
        },
        readBlock: readBlock,
        writeBlock: writeBlock,
        setExpandedBytes: setExpandedBytes,
        getGameInfo: getGameInfo,
        deleteGame: deleteGame,
        estimate: estimate
    };

    if (typeof window !== 'undefined') {
        window.addEventListener('pagehide', function () {
            for (var cache of activeCaches)
                flushSourceUsage(cache).catch(function () {});
        });
    }
})();
