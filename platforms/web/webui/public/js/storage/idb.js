// IndexedDB 存档空间持久化。
//
// 每个存档空间是独立数据库（krkr2-space-<name>）。v2 在 files 之外增加
// meta store：游戏写文件与 dirty 标记在同一事务提交，云同步只在用户手动触发。

(function () {
    var IDB_PREFIX = 'krkr2-space-';
    var DB_VERSION = 2;
    var SYNC_META_KEY = 'sync';
    var currentIdb = null;
    var currentSpaceId = null;
    var pendingWrites = new Set();

    function defaultSyncMeta() {
        return {
            dirty: false,
            baseRevision: null,
            contentHash: null,
            modifiedAt: null,
            lastSyncedAt: null,
            currentContentHash: null,
            targets: {}
        };
    }

    function normalizeSyncMeta(stored) {
        var meta = Object.assign(defaultSyncMeta(), stored || {});
        meta.targets = Object.assign({}, meta.targets || {});
        // v2 只支持站点云存档。保留旧字段，并把它视为 site 目标的初始基线。
        if (!meta.targets.site && (meta.baseRevision || meta.contentHash || meta.lastSyncedAt)) {
            meta.targets.site = {
                baseRevision: meta.baseRevision || null,
                contentHash: meta.contentHash || null,
                lastSyncedAt: meta.lastSyncedAt || null
            };
        }
        if (!meta.currentContentHash && !meta.dirty && meta.contentHash) {
            meta.currentContentHash = meta.contentHash;
        }
        return meta;
    }

    function upgradeDatabase(db) {
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    }

    function openDatabase(spaceId) {
        return new Promise(function (resolve, reject) {
            var req = indexedDB.open(IDB_PREFIX + spaceId, DB_VERSION);
            req.onupgradeneeded = function (e) { upgradeDatabase(e.target.result); };
            req.onsuccess = function (e) { resolve(e.target.result); };
            req.onerror = function () { reject(req.error); };
        });
    }

    async function idbOpen(spaceId) {
        if (currentIdb && currentSpaceId === spaceId) return currentIdb;
        if (currentIdb) currentIdb.close();
        currentIdb = await openDatabase(spaceId);
        currentSpaceId = spaceId;
        return currentIdb;
    }

    function transactionDone(tx) {
        return new Promise(function (resolve, reject) {
            tx.oncomplete = function () { resolve(); };
            tx.onerror = function () { reject(tx.error || new Error('IndexedDB transaction failed')); };
            tx.onabort = function () { reject(tx.error || new Error('IndexedDB transaction aborted')); };
        });
    }

    function trackWrite(promise) {
        pendingWrites.add(promise);
        promise.catch(function (e) {
            console.warn('[IDB] write failed:', e);
        }).finally(function () {
            pendingWrites.delete(promise);
        });
        return promise;
    }

    async function idbWhenIdle() {
        while (pendingWrites.size) {
            await Promise.allSettled(Array.from(pendingWrites));
        }
    }

    function idbSaveFile(path, data) {
        if (!currentIdb) return Promise.resolve();
        try {
            var copy = new Uint8Array(data);
            var tx = currentIdb.transaction(['files', 'meta'], 'readwrite');
            tx.objectStore('files').put(copy, path);
            var metaStore = tx.objectStore('meta');
            var req = metaStore.get(SYNC_META_KEY);
            req.onsuccess = function () {
                metaStore.put(Object.assign(normalizeSyncMeta(req.result), {
                    dirty: true,
                    currentContentHash: null,
                    modifiedAt: Date.now()
                }), SYNC_META_KEY);
            };
            return trackWrite(transactionDone(tx));
        } catch (e) {
            console.warn('[IDB] save failed:', path, e);
            return Promise.resolve();
        }
    }

    function readAllFromDatabase(db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction('files', 'readonly');
            var results = [];
            var cursorReq = tx.objectStore('files').openCursor();
            cursorReq.onsuccess = function (e) {
                var cursor = e.target.result;
                if (cursor) {
                    results.push({ path: cursor.key, data: new Uint8Array(cursor.value) });
                    cursor.continue();
                } else {
                    results.sort(function (a, b) { return String(a.path).localeCompare(String(b.path)); });
                    resolve(results);
                }
            };
            cursorReq.onerror = function () { reject(cursorReq.error); };
        });
    }

    function readMetaFromDatabase(db) {
        return new Promise(function (resolve) {
            var tx = db.transaction(['files', 'meta'], 'readonly');
            var metaReq = tx.objectStore('meta').get(SYNC_META_KEY);
            var countReq = tx.objectStore('files').count();
            tx.oncomplete = function () {
                var stored = metaReq.result;
                resolve(Object.assign(normalizeSyncMeta(stored), {
                    // v1 数据没有 meta；只要已有文件，就应视为从未上传的本地变化。
                    dirty: stored ? !!stored.dirty : (countReq.result || 0) > 0
                }));
            };
            tx.onerror = function () { resolve(defaultSyncMeta()); };
        });
    }

    async function withSpace(spaceId, callback) {
        await idbWhenIdle();
        if (currentIdb && currentSpaceId === spaceId) return callback(currentIdb);
        var db = await openDatabase(spaceId);
        try { return await callback(db); }
        finally { db.close(); }
    }

    function idbLoadAll() {
        if (!currentIdb) return Promise.resolve([]);
        return idbWhenIdle().then(function () { return readAllFromDatabase(currentIdb); });
    }

    function idbSnapshot(spaceId) {
        return withSpace(spaceId, async function (db) {
            return {
                files: await readAllFromDatabase(db),
                meta: await readMetaFromDatabase(db)
            };
        });
    }

    function idbGetSyncMeta(spaceId) {
        return withSpace(spaceId, function (db) { return readMetaFromDatabase(db); });
    }

    function idbSetSyncMeta(spaceId, patch) {
        return withSpace(spaceId, async function (db) {
            var current = await readMetaFromDatabase(db);
            var next = Object.assign({}, current, patch || {});
            if (patch && ('baseRevision' in patch || 'contentHash' in patch ||
                'lastSyncedAt' in patch)) {
                var targets = Object.assign({}, current.targets || {});
                targets.site = Object.assign({}, targets.site || {}, {
                    baseRevision: patch.baseRevision || null,
                    contentHash: patch.contentHash || null,
                    lastSyncedAt: patch.lastSyncedAt || null
                });
                next.targets = targets;
                if (patch.dirty === false && patch.contentHash) {
                    next.currentContentHash = patch.contentHash;
                }
            }
            var tx = db.transaction('meta', 'readwrite');
            tx.objectStore('meta').put(next, SYNC_META_KEY);
            await transactionDone(tx);
            return next;
        });
    }

    function idbSetSyncTarget(spaceId, targetKey, patch) {
        return withSpace(spaceId, async function (db) {
            var current = await readMetaFromDatabase(db);
            var targets = Object.assign({}, current.targets || {});
            targets[targetKey] = Object.assign({}, targets[targetKey] || {}, patch || {});
            var next = Object.assign({}, current, {
                dirty: false,
                currentContentHash: patch?.contentHash || current.currentContentHash || null,
                targets: targets
            });
            if (targetKey === 'site') {
                next.baseRevision = patch?.baseRevision || null;
                next.contentHash = patch?.contentHash || null;
                next.lastSyncedAt = patch?.lastSyncedAt || null;
            }
            var tx = db.transaction('meta', 'readwrite');
            tx.objectStore('meta').put(next, SYNC_META_KEY);
            await transactionDone(tx);
            return next;
        });
    }

    function idbReplaceFiles(spaceId, files, syncMeta) {
        return withSpace(spaceId, async function (db) {
            var current = await readMetaFromDatabase(db);
            var targets = Object.assign({}, current.targets || {});
            if (syncMeta && ('baseRevision' in syncMeta || 'contentHash' in syncMeta ||
                'lastSyncedAt' in syncMeta)) {
                targets.site = {
                    baseRevision: syncMeta.baseRevision || null,
                    contentHash: syncMeta.contentHash || null,
                    lastSyncedAt: syncMeta.lastSyncedAt || null
                };
            }
            var tx = db.transaction(['files', 'meta'], 'readwrite');
            var store = tx.objectStore('files');
            store.clear();
            for (var i = 0; i < files.length; i++) {
                store.put(new Uint8Array(files[i].data), files[i].path);
            }
            tx.objectStore('meta').put(Object.assign({}, current, syncMeta || {}, {
                dirty: !!syncMeta?.dirty,
                currentContentHash: syncMeta?.dirty ? null : (syncMeta?.contentHash || null),
                modifiedAt: Date.now(),
                lastSyncedAt: syncMeta?.dirty ? null : (syncMeta?.lastSyncedAt || Date.now()),
                targets: targets
            }), SYNC_META_KEY);
            await transactionDone(tx);
        });
    }

    function idbReplaceFilesForTarget(spaceId, files, targetKey, targetMeta) {
        return withSpace(spaceId, async function (db) {
            var current = await readMetaFromDatabase(db);
            var targets = Object.assign({}, current.targets || {});
            targets[targetKey] = Object.assign({}, targets[targetKey] || {}, targetMeta || {});
            var tx = db.transaction(['files', 'meta'], 'readwrite');
            var store = tx.objectStore('files');
            store.clear();
            for (var i = 0; i < files.length; i++) {
                store.put(new Uint8Array(files[i].data), files[i].path);
            }
            tx.objectStore('meta').put(Object.assign({}, current, {
                dirty: false,
                currentContentHash: targetMeta?.contentHash || null,
                modifiedAt: Date.now(),
                targets: targets,
                baseRevision: targetKey === 'site'
                    ? (targetMeta?.baseRevision || null) : current.baseRevision,
                contentHash: targetKey === 'site'
                    ? (targetMeta?.contentHash || null) : current.contentHash,
                lastSyncedAt: targetKey === 'site'
                    ? (targetMeta?.lastSyncedAt || null) : current.lastSyncedAt
            }), SYNC_META_KEY);
            await transactionDone(tx);
        });
    }

    function idbListSpaces() {
        if (indexedDB.databases) {
            return indexedDB.databases().then(function (dbs) {
                return dbs
                    .filter(function (d) { return d.name && d.name.startsWith(IDB_PREFIX); })
                    .map(function (d) { return d.name.substring(IDB_PREFIX.length); });
            });
        }
        var saved = localStorage.getItem('krkr2-spaces');
        return Promise.resolve(saved ? JSON.parse(saved) : []);
    }

    function idbRegisterSpace(name) {
        try {
            var saved = JSON.parse(localStorage.getItem('krkr2-spaces') || '[]');
            if (saved.indexOf(name) < 0) {
                saved.push(name);
                localStorage.setItem('krkr2-spaces', JSON.stringify(saved));
            }
        } catch (e) {}
    }

    function idbUnregisterSpace(name) {
        try {
            var saved = JSON.parse(localStorage.getItem('krkr2-spaces') || '[]');
            saved = saved.filter(function (s) { return s !== name; });
            localStorage.setItem('krkr2-spaces', JSON.stringify(saved));
        } catch (e) {}
    }

    function idbDeleteSpace(spaceId) {
        return new Promise(function (resolve) {
            if (currentIdb && currentSpaceId === spaceId) {
                currentIdb.close();
                currentIdb = null;
                currentSpaceId = null;
            }
            var req = indexedDB.deleteDatabase(IDB_PREFIX + spaceId);
            req.onsuccess = function () { idbUnregisterSpace(spaceId); resolve(); };
            req.onerror = function () { resolve(); };
            req.onblocked = function () { resolve(); };
        });
    }

    function idbGetSpaceInfo(spaceId) {
        return withSpace(spaceId, async function (db) {
            var files = await readAllFromDatabase(db);
            var meta = await readMetaFromDatabase(db);
            return {
                count: files.length,
                size: files.reduce(function (sum, file) { return sum + file.data.byteLength; }, 0),
                dirty: meta.dirty,
                baseRevision: meta.baseRevision,
                contentHash: meta.contentHash,
                lastSyncedAt: meta.lastSyncedAt,
                currentContentHash: meta.currentContentHash,
                targets: meta.targets
            };
        }).catch(function () {
            return { count: 0, size: 0, dirty: false, baseRevision: null,
                contentHash: null, lastSyncedAt: null };
        });
    }

    async function idbRestoreSaves() {
        var files = await idbLoadAll();
        if (files.length === 0) return;
        await window.KrKr2FS.waitForFS();
        for (var i = 0; i < files.length; i++) {
            window.KrKr2FS.writeFileToFS(files[i].path, files[i].data);
            VLFS.registerOverlayFile(files[i].path, new Uint8Array(files[i].data));
        }
        console.log('[IDB] Restored ' + files.length + ' save file(s)');
    }

    async function idbExportZip(spaceId) {
        var snapshot = await idbSnapshot(spaceId);
        var zip = new JSZip();
        for (var i = 0; i < snapshot.files.length; i++) {
            zip.file(snapshot.files[i].path.replace(/^\//, ''), snapshot.files[i].data);
        }
        var blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = spaceId + '-saves.zip';
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 0);
    }

    async function idbImportZip(file) {
        var zip = await JSZip.loadAsync(file);
        var spaceName = file.name.replace(/\.zip$/i, '').replace(/-saves$/, '');
        var entries = [];
        zip.forEach(function (p, e) {
            if (!e.dir) entries.push({ path: '/' + p.replace(/^\/+/, ''), entry: e });
        });
        var files = [];
        for (var i = 0; i < entries.length; i++) {
            files.push({ path: entries[i].path, data: await entries[i].entry.async('uint8array') });
        }
        await idbReplaceFiles(spaceName, files, { dirty: true, baseRevision: null });
        idbRegisterSpace(spaceName);
        return spaceName;
    }

    window.KrKr2IDB = {
        open: idbOpen,
        saveFile: idbSaveFile,
        loadAll: idbLoadAll,
        snapshot: idbSnapshot,
        getSyncMeta: idbGetSyncMeta,
        setSyncMeta: idbSetSyncMeta,
        setSyncTarget: idbSetSyncTarget,
        replaceFiles: idbReplaceFiles,
        replaceFilesForTarget: idbReplaceFilesForTarget,
        whenIdle: idbWhenIdle,
        listSpaces: idbListSpaces,
        registerSpace: idbRegisterSpace,
        unregisterSpace: idbUnregisterSpace,
        deleteSpace: idbDeleteSpace,
        getSpaceInfo: idbGetSpaceInfo,
        restoreSaves: idbRestoreSaves,
        exportZip: idbExportZip,
        importZip: idbImportZip
    };
})();
