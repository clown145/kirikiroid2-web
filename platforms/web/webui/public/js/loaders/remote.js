// --- VLFS 加载器：注册元数据即可玩，无全量下载/解压/复制 ---
// 远端来源（?xp3= / ?game= / 画廊配置的 URL）。

(function () {
    var L = window.KrKr2Loaders;

    function report(hooks, pct, text) {
        if (typeof hooks.onProgress === 'function') hooks.onProgress(pct, text);
    }

    // 流式下载为 Blob，带进度且 JS 堆峰值有界：每 64MB 块段合并为
    // 段 Blob（Blob 拼接引用而非复制），下载中堆驻留 ≤64MB。
    async function fetchBlobWithProgress(url, onProgress) {
        var resp = await fetch(url);
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + resp.statusText);
        var total = parseInt(resp.headers.get('Content-Length') || '0', 10);
        if (!resp.body) return await resp.blob();
        var reader = resp.body.getReader();
        var segments = [], chunks = [], chunkBytes = 0, loaded = 0;
        var SEGMENT = 64 * 1024 * 1024;
        while (true) {
            var r = await reader.read();
            if (r.done) break;
            chunks.push(r.value);
            chunkBytes += r.value.length;
            loaded += r.value.length;
            if (onProgress) onProgress(loaded, total);
            if (chunkBytes >= SEGMENT) {
                segments.push(new Blob(chunks));
                chunks = [];
                chunkBytes = 0;
            }
        }
        if (chunks.length) segments.push(new Blob(chunks));
        return new Blob(segments);
    }

    // Range 探测、指纹与缓存打开都在 js/storage/source-probe.js —— 画廊页
    // 发起完整下载时要用同一套逻辑，但它不加载引擎和这些加载器。
    var probeRemoteRange = function (url) {
        return window.KrKr2SourceProbe.probe(url);
    };

    function openGameCache(src, url, probe) {
        return window.KrKr2SourceProbe.openGameCache({
            gameKey: src.gameKey,
            title: src.title,
            url: url,
            probe: probe
        });
    }

    // ?xp3=：优先 HTTP Range 懒加载；服务器不支持时整包 Blob（仍 off-heap）
    L.handlers['xp3-url'] = async function (src, hooks) {
        report(hooks, 0, 'Probing game data...');
        await window.KrKr2VLFS.ready;

        var probe = await probeRemoteRange(src.url);
        var cache = probe.size > 0 ? await openGameCache(src, src.url, probe) : null;

        if (cache && cache.complete()) {
            VLFS.registerRemote('/data.xp3', src.url, probe.size, true, cache);
            console.log('[vlfs] local cached xp3: ' + probe.size + ' bytes');
        } else if (probe.ranges && probe.size > 0) {
            VLFS.registerRemote('/data.xp3', src.url, probe.size, true, cache);
            console.log('[vlfs] remote xp3 (Range lazy-load): ' + src.url + ', ' + probe.size + ' bytes');
        } else {
            report(hooks, 0, 'Downloading game data...');
            var blob = await fetchBlobWithProgress(src.url, function (loaded, total) {
                if (total > 0) {
                    var pct = Math.round(loaded / total * 100);
                    report(hooks, pct, 'Downloading... ' + pct + '%');
                } else {
                    report(hooks, null, 'Downloading... ' + (loaded / 1048576).toFixed(1) + ' MB');
                }
            });
            VLFS.registerBlobFile('/data.xp3', blob);
            console.log('[vlfs] remote xp3 (whole blob fallback): ' + blob.size + ' bytes');
        }

        // 单文件挂在固定路径，引擎自己找得到，不需要 startupXp3Path
        return { startupXp3Path: null };
    };

    // ?game=：优先通过 HTTP Range 只读 ZIP 中央目录和实际文件区间；服务器
    // 不支持 Range 时才退回整包 Blob。这样 ASan 的大 Wasm 内存与大游戏 ZIP
    // 不会同时常驻 Chromium renderer，文件树和条目读取语义保持不变。
    L.handlers['zip-url'] = async function (src, hooks) {
        report(hooks, 0, 'Probing game archive...');
        await window.KrKr2VLFS.ready;

        var probe = await probeRemoteRange(src.url);
        var cache = probe.size > 0 ? await openGameCache(src, src.url, probe) : null;

        var reg;
        if (cache && cache.complete()) {
            report(hooks, 0, 'Reading cached archive...');
            reg = await VLFS.registerZipRemote(src.url, probe.size, {
                fingerprint: probe.fingerprint || undefined,
                cache: cache,
                gameKey: src.gameKey || null,
                onProgress: function (done, total, path) {
                    report(hooks, Math.round(done / total * 100),
                        'Extracting (' + done + '/' + total + ') ' + path.substring(1));
                }
            });
            console.log('[vlfs] local cached zip: ' + probe.size + ' bytes');
        } else if (probe.ranges && probe.size > 0) {
            report(hooks, 0, 'Reading archive index...');
            reg = await VLFS.registerZipRemote(src.url, probe.size, {
                fingerprint: probe.fingerprint || undefined,
                cache: cache,
                gameKey: src.gameKey || null,
                onProgress: function (done, total, path) {
                    report(hooks, Math.round(done / total * 100),
                        'Extracting (' + done + '/' + total + ') ' + path.substring(1));
                }
            });
            console.log('[vlfs] remote zip (Range): ' + src.url + ', ' + probe.size + ' bytes');
        } else {
            report(hooks, 0, 'Downloading game archive...');
            var blob = await fetchBlobWithProgress(src.url, function (loaded, total) {
                if (total > 0) {
                    var pct = Math.round(loaded / total * 100);
                    // 下载占进度条前 60%，解压占后 40%
                    report(hooks, pct * 0.6,
                        'Downloading... ' + pct + '% (' + (loaded / 1048576).toFixed(1) + ' MB)');
                } else {
                    report(hooks, null, 'Downloading... ' + (loaded / 1048576).toFixed(1) + ' MB');
                }
            });
            report(hooks, 60, 'Extracting archive...');
            reg = await VLFS.registerZipBlob(blob, {
                onProgress: function (done, total, path) {
                    report(hooks, 60 + Math.round(done / total * 40),
                        'Extracting (' + done + '/' + total + ') ' + path.substring(1));
                }
            });
            console.log('[vlfs] zip blob fallback: ' + blob.size + ' bytes');
        }
        console.log('[vlfs] zip registered: ' + reg.paths.length + ' entries, ' +
                    reg.xp3Paths.length + ' xp3');

        report(hooks, 100, 'Starting game...');
        return {
            startupXp3Path: await L.resolveStartupXp3(reg.xp3Paths, hooks, src.entry)
        };
    };
    // ?json=：JSON 清单模式加载散装文件
    L.handlers['json-url'] = async function (src, hooks) {
        report(hooks, 0, 'Fetching game manifest...');
        await window.KrKr2VLFS.ready;

        var loaded = await window.KrKr2SourceProbe.loadManifest({
            gameKey: src.gameKey,
            title: src.title,
            url: src.url
        });
        var manifest = loaded.manifest;
        var xp3Paths = [];
        var totalFiles = manifest.length;
        var preparedItems = [];
        var seen = new Set();

        for (var i = 0; i < totalFiles; i++) {
            var item = manifest[i];
            var prepared = await window.KrKr2SourceProbe.prepareManifestItem(
                item, src.url, loaded.probe);
            if (!prepared) continue;
            if (seen.has(prepared.resourceKey)) {
                throw new Error('Game manifest contains duplicate path: ' + prepared.path);
            }
            seen.add(prepared.resourceKey);
            preparedItems.push(prepared);
        }

        if (src.gameKey) {
            await window.KrKr2SourceProbe.retainGameResources(
                src.gameKey,
                [window.KrKr2SourceProbe.MANIFEST_RESOURCE_KEY].concat(
                    preparedItems.map(function (item) { return item.resourceKey; })));
        }

        for (var pi = 0; pi < preparedItems.length; pi++) {
            var prepared = preparedItems[pi];

            report(hooks, Math.round((pi / preparedItems.length) * 100),
                'Mounting ' + prepared.path.substring(1) + '...');

            if (prepared.size > 0) {
                var cache = null;
                if (src.gameKey) {
                    cache = await window.KrKr2SourceProbe.openGameCache({
                        gameKey: src.gameKey,
                        title: src.title,
                        url: prepared.url,
                        probe: prepared.probe,
                        resourceKey: prepared.resourceKey,
                        resourcePath: prepared.path
                    });
                }
                VLFS.registerRemote(prepared.path, prepared.url, prepared.size,
                    prepared.probe.ranges, cache);
                if (prepared.path.toLowerCase().endsWith('.xp3')) {
                    xp3Paths.push(prepared.path);
                }
            } else {
                console.warn('[vlfs] Skip mounting ' + prepared.path +
                    ': could not determine size');
            }
        }

        console.log('[vlfs] json manifest registered: ' + totalFiles + ' entries, ' + xp3Paths.length + ' xp3');
        report(hooks, 100, 'Starting game...');
        
        return {
            startupXp3Path: await L.resolveStartupXp3(xp3Paths, hooks, src.entry)
        };
    };

    L.fetchBlobWithProgress = fetchBlobWithProgress;
})();
