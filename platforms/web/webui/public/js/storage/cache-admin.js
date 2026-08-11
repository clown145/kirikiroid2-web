/*
 * 缓存管理入口 —— 画廊页与播放页共用的 window.KrKr2Cache。
 *
 * 独立于 vlfs.js：画廊页要做分游戏清理和用量展示，但它不加载引擎，
 * 也就没有 VLFS 实例。这里只依赖 OPFS 本身。
 *
 * 一个游戏的缓存分布在两处，清理必须同时覆盖：
 *   krkr2-cache/<游戏目录>/  连续资源文件（cache-store.js 写）
 *   vlfs-tmp/zip-cache-<fp>/  ZIP deflate 条目的解压产物（vlfs.js 写）
 * 后者的 state 结构是与 vlfs.js 的约定，改那边记得同步改这里。
 */
(function () {
    'use strict';

    // 与 vlfs.js 顶部同名常量保持一致
    var VLFS_TMP_DIR = 'vlfs-tmp';
    var ZIP_CACHE_STATE_FILE = 'zip-cache-state.json';
    var ZIP_CACHE_SCHEMA_VERSION = 2;

    async function opfsRoot() {
        try {
            return await navigator.storage.getDirectory();
        } catch (e) {
            return null;
        }
    }

    async function store() {
        if (!window.KrKr2CacheStore) return null;
        return await window.KrKr2CacheStore.activeStore();
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

    async function zipCacheDir() {
        var root = await opfsRoot();
        if (!root) return null;
        try {
            return await root.getDirectoryHandle(VLFS_TMP_DIR);
        } catch (e) {
            return null;   // 从未跑过 ZIP 源
        }
    }

    async function loadZipState(dir) {
        var state = await readJson(dir, ZIP_CACHE_STATE_FILE);
        if (!state || state.version !== ZIP_CACHE_SCHEMA_VERSION ||
            !state.caches || typeof state.caches !== 'object') return null;
        return state;
    }

    /** 递归统计一个目录的字节数。 */
    async function dirBytes(dir) {
        var total = 0;
        try {
            for await (var pair of dir.entries()) {
                var handle = pair[1];
                if (handle.kind === 'file') {
                    try { total += (await handle.getFile()).size; } catch (e) {}
                } else {
                    total += await dirBytes(handle);
                }
            }
        } catch (e) {}
        return total;
    }

    /** 删除某游戏的 ZIP 解压产物槽位。 */
    async function removeZipCacheFor(gameKey) {
        var dir = await zipCacheDir();
        if (!dir) return 0;
        var state = await loadZipState(dir);
        if (!state) return 0;

        var freed = 0, changed = false;
        for (var fp in state.caches) {
            if (!Object.prototype.hasOwnProperty.call(state.caches, fp)) continue;
            if (state.caches[fp].gameKey !== gameKey) continue;
            var name = state.caches[fp].dirName;
            try {
                var sub = await dir.getDirectoryHandle(name);
                freed += await dirBytes(sub);
            } catch (e) {}
            try { await dir.removeEntry(name, { recursive: true }); } catch (e) {}
            delete state.caches[fp];
            changed = true;
        }
        if (changed) {
            try { await writeJson(dir, ZIP_CACHE_STATE_FILE, state); } catch (e) {}
        }
        return freed;
    }

    /** ZIP 解压产物的总占用。遍历目录，仅在展示用量时调用。 */
    async function zipCacheBytes() {
        var dir = await zipCacheDir();
        if (!dir) return 0;
        var state = await loadZipState(dir);
        if (!state) return 0;
        var total = 0;
        for (var fp in state.caches) {
            if (!Object.prototype.hasOwnProperty.call(state.caches, fp)) continue;
            try {
                total += await dirBytes(
                    await dir.getDirectoryHandle(state.caches[fp].dirName));
            } catch (e) {}
        }
        return total;
    }

    // --- 下载管理（单例） -------------------------------------------
    //
    // 一次只跑一个下载：并行下两个游戏只会让两个都变慢，且抢光连接。
    // 画廊页与播放页各自持有自己的实例 —— MPA 下它们是两个 Document，
    // 本来就不共享状态，跳转即中断也正是既定行为（进度留在 OPFS，
    // 下次从连续前缀继续，不会从头再来）。
    var active = null;        // {gameKey, title, downloader, cache}

    function sourceTypeForUrl(url) {
        var value = String(url || '').trim().toLowerCase();
        var path = value.split(/[?#]/)[0];
        return path.endsWith('.json') ? 'json-url' : 'single-url';
    }

    async function prepareManifestDownload(info) {
        var loaded = await window.KrKr2SourceProbe.loadManifest({
            gameKey: info.gameKey,
            title: info.title,
            url: info.url
        });
        var sources = [];
        var preparedItems = [];
        var seen = new Set();

        for (var i = 0; i < loaded.manifest.length; i++) {
            var prepared = await window.KrKr2SourceProbe.prepareManifestItem(
                loaded.manifest[i], info.url, loaded.probe);
            if (!prepared) continue;
            if (seen.has(prepared.resourceKey)) {
                throw new Error('JSON 清单包含重复路径：' + prepared.path);
            }
            seen.add(prepared.resourceKey);
            if (!(prepared.size > 0)) throw new Error('无法确定资源大小：' + prepared.path);
            preparedItems.push(prepared);
        }

        await window.KrKr2SourceProbe.retainGameResources(
            info.gameKey,
            [window.KrKr2SourceProbe.MANIFEST_RESOURCE_KEY].concat(
                preparedItems.map(function (item) { return item.resourceKey; })));

        for (var pi = 0; pi < preparedItems.length; pi++) {
            var prepared = preparedItems[pi];
            var cache = await window.KrKr2SourceProbe.openGameCache({
                gameKey: info.gameKey,
                title: info.title,
                url: prepared.url,
                probe: prepared.probe,
                resourceKey: prepared.resourceKey,
                resourcePath: prepared.path
            });
            if (!cache) throw new Error('无法创建资源缓存：' + prepared.path);
            sources.push({
                url: prepared.url,
                size: prepared.size,
                cache: cache,
                path: prepared.path,
                ranges: prepared.probe.ranges
            });
        }

        return {
            sources: sources,
            fixedBytes: loaded.cache ? loaded.cache.availableBytes() : loaded.bytes,
            fixedSize: loaded.probe.size > 0 ? loaded.probe.size : 0,
            cache: loaded.cache || (sources[0] && sources[0].cache) || null
        };
    }

    async function startDownload(info) {
        await stopDownload();
        if (!window.KrKr2SourceProbe || !window.KrKr2Downloader) {
            throw new Error('下载器未加载');
        }

        var type = info.type || sourceTypeForUrl(info.url);
        var prepared;
        if (type === 'json-url') {
            prepared = await prepareManifestDownload(info);
        } else {
            var probe = await window.KrKr2SourceProbe.probe(info.url);
            if (!(probe.size > 0)) throw new Error('无法确定资源大小，无法下载');
            var cache = await window.KrKr2SourceProbe.openGameCache({
                gameKey: info.gameKey, title: info.title,
                url: info.url, probe: probe
            });
            if (!cache) throw new Error('缓存不可用，无法预下载');
            prepared = {
                sources: [{
                    url: info.url, size: probe.size, cache: cache,
                    ranges: probe.ranges
                }],
                fixedBytes: 0,
                fixedSize: 0,
                cache: cache
            };
        }

        var dl = window.KrKr2Downloader.create({
            url: info.url,
            sources: prepared.sources,
            fixedBytes: prepared.fixedBytes,
            fixedSize: prepared.fixedSize,
            mode: info.mode || 'full',
            onProgress: info.onProgress,
            onDone: function (s) {
                if (info.onDone) info.onDone(s);
            },
            onError: info.onError
        });
        active = {
            gameKey: info.gameKey, title: info.title || '',
            downloader: dl, cache: prepared.cache
        };
        dl.start();
        return dl;
    }

    /*
     * 对当前正在游玩的源开启边玩边下。
     *
     * 复用 VLFS 已挂载的 GameCache，而不是自己再 open 一次：CacheStore.open
     * 会 retire 同一 gameKey/resourceKey 的旧实例，那正是读路径正在用的
     * 对象，重开会让尚未提交的连续前缀凭空消失。
     */
    function startPlayDownload(handlers) {
        if (!window.VLFS || typeof window.VLFS.activeCaches !== 'function') return null;
        var sources = window.VLFS.activeCaches().filter(function (source) {
            return source && source.cache && source.url && source.size > 0;
        });
        if (!sources.length) return null;
        var incomplete = sources.some(function (source) {
            return !source.cache.isComplete(source.size);
        });
        if (!incomplete) return null;   // 已经全在本地了

        stopDownload();
        var dl = window.KrKr2Downloader.create({
            url: sources[0].url,
            sources: sources,
            mode: 'play',
            onProgress: handlers && handlers.onProgress,
            onDone: handlers && handlers.onDone,
            onError: handlers && handlers.onError
        });
        active = {
            gameKey: sources[0].cache.gameKey, title: '',
            downloader: dl, cache: sources[0].cache
        };
        dl.start();
        return dl;
    }

    function stopDownload(opts) {
        if (!active) return Promise.resolve();
        var current = active;
        active = null;
        try { return current.downloader.stop(opts) || Promise.resolve(); }
        catch (e) { return Promise.resolve(); }
    }

    function downloadState() {
        if (!active) return null;
        var s = active.downloader.state();
        s.gameKey = active.gameKey;
        s.title = active.title;
        return s;
    }

    var KrKr2Cache = {
        /** 已缓存的游戏列表，最近游玩在前。 */
        async list() {
            var s = await store();
            return s ? await s.list() : [];
        },

        /**
         * 用量汇总。zipBytes 需要遍历目录，故与 list() 分开，
         * 只在缓存管理界面调用。
         */
        async usage() {
            var s = await store();
            var base = s ? await s.usage() : { bytes: 0, limit: 0, games: 0 };
            base.zipBytes = await zipCacheBytes();
            base.totalBytes = base.bytes + base.zipBytes;
            return base;
        },

        /** 清理单个游戏的全部缓存（连续资源文件 + ZIP 解压产物）。 */
        async remove(gameKey) {
            // 正在下载它就先停，且丢弃未落盘的那批 —— 保存它没有意义，
            // 数据下一步就要被删
            if (active && active.gameKey === gameKey) {
                await stopDownload({ discard: true });
            }
            var s = await store();
            if (s) await s.remove(gameKey);
            await removeZipCacheFor(gameKey);
        },

        async removeAll() {
            await stopDownload({ discard: true });
            var s = await store();
            if (s) await s.removeAll();
            var dir = await zipCacheDir();
            if (!dir) return;
            var state = await loadZipState(dir);
            if (!state) return;
            for (var fp in state.caches) {
                if (!Object.prototype.hasOwnProperty.call(state.caches, fp)) continue;
                try {
                    await dir.removeEntry(state.caches[fp].dirName, { recursive: true });
                } catch (e) {}
            }
            try {
                await writeJson(dir, ZIP_CACHE_STATE_FILE,
                    { version: ZIP_CACHE_SCHEMA_VERSION, caches: {} });
            } catch (e) {}
        },

        /** 申请持久化存储，降低 OPFS 被系统清除的概率。 */
        async requestPersist() {
            if (!window.KrKr2CacheStore) return false;
            return await window.KrKr2CacheStore.requestPersist();
        },

        /**
         * 当前存储位置。
         * kind 'folder' = 用户绑定的磁盘目录（永久，浏览器不会清）；
         * kind 'opfs'   = 浏览器内部存储（存储压力下可能被清除）。
         */
        async storageInfo() {
            var F = window.KrKr2Folder;
            var info = {
                kind: 'opfs',
                name: '',
                supported: !!(F && F.supported()),
                bound: false,
                needsPermission: false
            };
            if (!info.supported) return info;
            info.bound = await F.hasBinding();
            var handle = await F.tryRestore();
            if (handle) {
                info.kind = 'folder';
                info.name = handle.name;
            } else if (info.bound) {
                // 绑过但权限过期：要用户点一下才能恢复，不能静默弹窗
                info.needsPermission = true;
                info.name = await F.name();
            }
            return info;
        },

        /** 绑定文件夹。必须在用户手势里调用。 */
        async bindFolder() {
            if (!window.KrKr2Folder) throw new Error('不支持选择文件夹');
            // 活跃响应已经绑定旧后端的 GameCache；先停止并提交连续前缀，
            // 下一次下载再从新后端开始，避免一个响应跨两个目录写。
            await stopDownload();
            var handle = await window.KrKr2Folder.request();
            return handle ? handle.name : '';
        },

        async unbindFolder() {
            await stopDownload();
            await window.KrKr2Folder?.unbind();
        },

        /**
         * 启动预下载。同一时刻只跑一个，调用它会先停掉上一个。
         * mode 'full'（画廊页）或 'play'（边玩边下）。并发数只控制 JSON
         * 多资源间的并行度；每个资源始终只有一个连续 GET。
         */
        download: startDownload,
        startPlayDownload: startPlayDownload,
        stopDownload: stopDownload,
        downloadState: downloadState,

        pauseDownload() { if (active) active.downloader.pause(); },
        resumeDownload() { if (active) active.downloader.resume(); },

        /** 当前会话正在使用的缓存状态（播放页专用，需要 VLFS）。 */
        active() {
            if (!window.VLFS || typeof window.VLFS.stats !== 'function') return null;
            try {
                return window.VLFS.stats().cache;
            } catch (e) {
                return null;
            }
        }
    };

    window.KrKr2Cache = KrKr2Cache;
})();
