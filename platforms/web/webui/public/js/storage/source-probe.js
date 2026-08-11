/*
 * 远程数据源探测 —— 播放页（loaders/remote.js）与画廊页（完整下载）共用。
 *
 * 独立成文件是因为画廊页要发起完整下载，却不加载引擎与加载器：
 * 它需要同样的 Range 探测、指纹计算和缓存打开逻辑，两处各写一遍必然跑偏。
 */
(function () {
    'use strict';

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
                var sha = (head.headers.get('X-Content-SHA256') || '').trim().toLowerCase();
                if (/^[0-9a-f]{64}$/.test(sha)) fingerprint = 'sha256-' + sha;
                if (!fingerprint) {
                    // 只收强 ETag：W/ 前缀的弱验证器只保证「语义等价」，
                    // 字节可以不同，拿它当字节缓存的键会拼出混着两个版本
                    // 的文件。宁可退到 size 兜底。
                    var etag = (head.headers.get('ETag') || '').trim();
                    if (etag && etag.indexOf('W/') !== 0) {
                        fingerprint = 'etag-' + etag.replace(/"/g, '');
                    }
                }
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
     * 缓存指纹。源内容变了必须作废旧字节 —— 混用两个版本的区间会拼出
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
                title: info.title || ''
            });
            if (!cache) return null;
            // 淘汰放在打开之后、且排除当前游戏：否则刚建好的缓存可能被
            // 自己挤掉
            await store.enforceQuota(info.gameKey);
            return cache;
        } catch (e) {
            console.warn('[cache] 缓存不可用，降级为纯网络：', e);
            return null;
        }
    }

    window.KrKr2SourceProbe = {
        probe: probe,
        fileNameFromUrl: fileNameFromUrl,
        fingerprintOf: fingerprintOf,
        openGameCache: openGameCache
    };
})();
