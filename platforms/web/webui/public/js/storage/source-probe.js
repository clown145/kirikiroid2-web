/*
 * 远程数据源探测 —— 播放页（loaders/remote.js）与画廊页（完整下载）共用。
 *
 * 独立成文件是因为画廊页要发起完整下载，却不加载引擎与加载器：
 * 它需要同样的源探测、指纹计算和缓存打开逻辑，两处各写一遍必然跑偏。
 */
(function () {
    'use strict';

    var MANIFEST_RESOURCE_KEY = '@manifest';
    var MANIFEST_RESOURCE_PATH = '.krkr2-cache/manifest.json';

    function fingerprintFromHeaders(headers) {
        var sha = (headers.get('X-Content-SHA256') || '').trim().toLowerCase();
        if (/^[0-9a-f]{64}$/.test(sha)) return 'sha256-' + sha;
        var etag = (headers.get('ETag') || '').trim();
        if (etag && etag.indexOf('W/') !== 0) return 'etag-' + etag.replace(/"/g, '');
        return '';
    }

    /*
     * 探测服务器对 Range 的支持。
     * 优先 HEAD 查标头；无标头时用 1-byte Range 兜底 —— 跨域时 CORS 未
     * Expose 相关标头会让 HEAD 什么也读不到，据此误判成"不支持 Range"
     * 就会退化为整包下载。
     */
    async function probe(url) {
        var ranges = false, size = -1, fingerprint = '';
        try {
            var head = await fetch(url, { method: 'HEAD' });
            if (head.ok) {
                ranges = (head.headers.get('Accept-Ranges') || '').toLowerCase() === 'bytes';
                size = parseInt(head.headers.get('Content-Length') || '-1', 10);
                // 只收强 ETag：弱验证器不保证字节相同。
                fingerprint = fingerprintFromHeaders(head.headers);
            }
        } catch (e) {}

        if (!ranges || size <= 0) {
            try {
                var test = await fetch(url, { headers: { 'Range': 'bytes=0-0' } });
                if (test.status === 206) {
                    ranges = true;
                    var cr = test.headers.get('Content-Range');   // "bytes 0-0/123456"
                    if (cr) {
                        var m = cr.match(/\/(\d+)$/);
                        if (m) size = parseInt(m[1], 10);
                    }
                }
            } catch (e) {}
        }

        return { ranges: ranges, size: size, fingerprint: fingerprint };
    }

    function fileNameFromUrl(url) {
        var path = String(url).split(/[?#]/)[0];
        var name = path.substring(path.lastIndexOf('/') + 1);
        try { name = decodeURIComponent(name); } catch (e) {}
        return name || 'data.bin';
    }

    /*
     * 缓存指纹。源内容变了必须作废旧前缀，否则续传会把两个版本拼成
     * 一个谁也读不了的文件。
     *
     * 兜底只有 size：游戏更新后大小恰好不变才会误判，概率极低，且服务器
     * 提供 X-Content-SHA256 或强 ETag 时根本走不到这一步。
     */
    function fingerprintOf(probeResult) {
        return probeResult.fingerprint || ('size-' + probeResult.size);
    }

    /*
     * 打开该源的持久字节缓存。
     *
     * 没有 gameKey 就不缓存：?xp3= / ?game= 调试入口和 /play/local 属于
     * 这一类，它们没有稳定标识，进了缓存索引只会污染列表与配额。
     * 任何一步失败都只降级为纯网络读，不影响游戏启动。
     */
    async function openGameCache(info) {
        if (!info || !info.gameKey || !window.KrKr2CacheStore) return null;
        if (!(info.probe && info.probe.size > 0)) return null;
        try {
            var store = await window.KrKr2CacheStore.activeStore();
            if (!store) return null;
            var cache = await store.open(info.gameKey, {
                fingerprint: fingerprintOf(info.probe),
                size: info.probe.size,
                url: info.url,
                name: fileNameFromUrl(info.url),
                title: info.title || '',
                resourceKey: info.resourceKey || '',
                resourcePath: info.resourcePath ||
                    (info.resourceKey === MANIFEST_RESOURCE_KEY
                        ? MANIFEST_RESOURCE_PATH
                        : fileNameFromUrl(info.url))
            });
            if (!cache) return null;
            // 淘汰放在打开之后、且排除当前游戏：否则刚建好的缓存可能被
            // 自己挤掉
            await store.enforceQuota(info.gameKey);
            return cache;
        } catch (e) {
            console.warn('[cache] 缓存不可用，降级为纯网络：', e);
            if (info.required) throw e;
            return null;
        }
    }

    function normalizeResourcePath(name) {
        var path = String(name || '').replace(/\\/g, '/');
        var parts = path.split('/');
        var out = [];
        for (var i = 0; i < parts.length; i++) {
            var part = parts[i];
            if (!part || part === '.') continue;
            if (part === '..') { out.pop(); continue; }
            out.push(part);
        }
        return '/' + out.join('/');
    }

    function resourceKeyForPath(path) {
        // VLFS 文件查找不区分大小写，缓存身份必须使用相同规则。
        return 'file:' + normalizeResourcePath(path).toLowerCase();
    }

    function resolveResourceUrl(url, manifestUrl) {
        try { return new URL(String(url), manifestUrl).href; }
        catch (e) { return String(url || ''); }
    }

    function isManifestSelfReference(url, manifestUrl) {
        try {
            var base = typeof document !== 'undefined' ? document.baseURI : undefined;
            var manifest = new URL(String(manifestUrl), base);
            var resource = new URL(String(url), manifest);
            // 查询参数常用于签名或缓存破坏；同源同路径仍是同一个清单文件。
            return resource.origin === manifest.origin &&
                resource.pathname === manifest.pathname;
        } catch (e) {
            return false;
        }
    }

    /*
     * 读取 JSON 清单时也走同一份字节缓存。这样完整预下载后播放页只需一次
     * HEAD 校验，不会再把已经下载过的 manifest 本体重新 GET 一遍。
     */
    async function loadManifest(info) {
        var manifestProbe = await probe(info.url);
        var cache = null;
        var bytes = null;

        if (manifestProbe.size > 0) {
            cache = await openGameCache({
                gameKey: info.gameKey,
                title: info.title,
                url: info.url,
                probe: manifestProbe,
                resourceKey: MANIFEST_RESOURCE_KEY
            });
            if (cache && cache.isComplete(manifestProbe.size)) {
                bytes = await cache.read(0, manifestProbe.size);
            }
        }

        if (!bytes) {
            var response = await fetch(info.url);
            if (!response.ok) throw new Error('Failed to fetch manifest: ' + response.status);
            bytes = new Uint8Array(await response.arrayBuffer());

            var responseFingerprint = fingerprintFromHeaders(response.headers);
            if (manifestProbe.size !== bytes.length ||
                (!manifestProbe.fingerprint && responseFingerprint)) {
                manifestProbe = {
                    ranges: manifestProbe.ranges,
                    size: bytes.length,
                    fingerprint: responseFingerprint || manifestProbe.fingerprint
                };
                cache = await openGameCache({
                    gameKey: info.gameKey,
                    title: info.title,
                    url: info.url,
                    probe: manifestProbe,
                    resourceKey: MANIFEST_RESOURCE_KEY
                });
            }
            if (cache && bytes.length) {
                await cache.replace(bytes);
            }
        }

        var manifest;
        try {
            manifest = JSON.parse(new TextDecoder('utf-8').decode(bytes));
        } catch (e) {
            throw new Error('Invalid game manifest JSON: ' + e.message);
        }
        if (!Array.isArray(manifest)) throw new Error('Game manifest must be an array');
        return {
            manifest: manifest,
            probe: manifestProbe,
            cache: cache,
            bytes: bytes.length
        };
    }

    /*
     * 旧清单只有 name/url/size。它没有逐文件内容 hash 时，以“清单指纹 +
     * 文件大小”作兼容指纹；新清单可提供 sha256 或强 etag 消除同大小更新的
     * 歧义。ranges=false 可显式声明该资源不能断点续传；首次完整下载仍然
     * 只需一个普通 GET。
     */
    async function prepareManifestItem(item, manifestUrl, manifestProbe) {
        if (!item || !String(item.name || '').trim()) return null;
        var path = normalizeResourcePath(item.name);
        if (path === '/') throw new Error('Game manifest contains an empty resource path');
        var rawUrl = (item.url !== undefined && item.url !== null && String(item.url).trim() !== '')
            ? String(item.url).trim()
            : item.name.split('/').map(encodeURIComponent).join('/');
        var url = resolveResourceUrl(rawUrl, manifestUrl);
        if (isManifestSelfReference(url, manifestUrl)) {
            console.warn('[manifest] 忽略指向清单自身的资源：' + path);
            return null;
        }
        var size = Number(item.size);
        var itemProbe;

        var sha = String(item.sha256 || '').trim().toLowerCase();
        var etag = String(item.etag || '').trim();
        var suppliedFingerprint = '';
        if (/^[0-9a-f]{64}$/.test(sha)) suppliedFingerprint = 'sha256-' + sha;
        else if (etag && etag.indexOf('W/') !== 0) {
            suppliedFingerprint = 'etag-' + etag.replace(/"/g, '');
        }

        if (size > 0) {
            itemProbe = {
                ranges: item.ranges !== false,
                size: size,
                fingerprint: suppliedFingerprint ||
                    ('manifest-' + fingerprintOf(manifestProbe) + '-size-' + size)
            };
        } else {
            itemProbe = await probe(url);
            if (suppliedFingerprint) itemProbe.fingerprint = suppliedFingerprint;
        }

        return {
            path: path,
            url: url,
            size: itemProbe.size,
            probe: itemProbe,
            resourceKey: resourceKeyForPath(path)
        };
    }

    async function retainGameResources(gameKey, resourceKeys) {
        if (!gameKey || !window.KrKr2CacheStore) return;
        var store = await window.KrKr2CacheStore.activeStore();
        if (store) await store.retainResources(gameKey, resourceKeys);
    }

    window.KrKr2SourceProbe = {
        probe: probe,
        fileNameFromUrl: fileNameFromUrl,
        fingerprintOf: fingerprintOf,
        openGameCache: openGameCache,
        loadManifest: loadManifest,
        prepareManifestItem: prepareManifestItem,
        retainGameResources: retainGameResources,
        resourceKeyForPath: resourceKeyForPath,
        MANIFEST_RESOURCE_KEY: MANIFEST_RESOURCE_KEY
    };
})();
