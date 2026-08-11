/*
 * 游戏字节缓存的持久层。
 *
 * 每个游戏在缓存根目录下占一个子目录，内含：
 *   meta.json        {version, fingerprint, url, size, name, ranges}
 *   <原始文件名>      稀疏数据文件，offset 直接对应源文件 offset
 *
 * 稀疏文件而非分块文件，是因为下载到 100% 时它**就是**完整可用的原始
 * .zip/.xp3 —— folder 后端下用户能直接在文件管理器里拿走、备份，下次
 * 走本地文件路径加载，完全不经网络。
 *
 * 两个后端共用全部代码：OPFS 的 navigator.storage.getDirectory() 与
 * File System Access 的 showDirectoryPicker() 返回的都是
 * FileSystemDirectoryHandle，接口完全一致。差别只有两处 —— root 怎么拿，
 * 以及 folder 后端要先过权限检查、且不受浏览器配额约束。
 *
 * 提交顺序沿用 vlfs.js 里 ZIP OPFS 缓存的"完成标记最后提交"：先 close()
 * 数据写流，成功后才把区间并入 RangeSet 并写 meta.json。于是崩溃、取消
 * 或写失败都不会留下"声称有数据、实际是空洞"的元数据。
 *
 * 任何一步失败都只降级为不缓存，绝不影响游戏运行。
 */
(function () {
    'use strict';

    var SCHEMA_VERSION = 1;
    var OPFS_ROOT_DIR = 'krkr2-cache';
    var INDEX_FILE = 'index.json';
    var META_FILE = 'meta.json';

    // 攒够这么多字节就提交一批。太小则频繁开关写流（每次 close 都要落盘
    // 元数据），太大则崩溃时丢的进度多。
    var COMMIT_BATCH_BYTES = 16 * 1024 * 1024;
    // 数据零星时也别让它永远不落盘
    var COMMIT_IDLE_MS = 5000;

    // 上限取 min(浏览器配额 * 50%, 20GiB)。folder 后端不受此约束。
    var QUOTA_FRACTION = 0.5;
    var QUOTA_CAP_BYTES = 20 * 1024 * 1024 * 1024;

    var RangeSet = window.KrKr2RangeSet;

    // --- 工具 -------------------------------------------------------

    function fnv1a(s) {
        var h = 0x811c9dc5;
        for (var i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = (h * 0x01000193) >>> 0;
        }
        return h.toString(36);
    }

    /* 目录名要既可读又无冲突：可读部分方便在 DevTools/文件管理器里认，
       hash 后缀保证任意 gameKey（D1 的 id 是任意 TEXT）不会撞车。 */
    function safeDirName(key) {
        var base = String(key).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40);
        return (base || 'game') + '-' + fnv1a(String(key));
    }

    function safeFileName(name) {
        var s = String(name || '').replace(/[^A-Za-z0-9._-]/g, '_');
        if (s.length > 64) s = s.slice(-64);
        return s || 'data.bin';
    }

    async function readJson(dir, name) {
        try {
            var h = await dir.getFileHandle(name);
            var f = await h.getFile();
            var text = await f.text();
            return JSON.parse(text);
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

    // --- GameCache：单个游戏的缓存句柄 ------------------------------

    function GameCache(store, gameKey, dirName, dir, fileHandle, meta) {
        this.store = store;
        this.gameKey = gameKey;
        this.dirName = dirName;
        this.size = meta.size;
        this.name = meta.name;
        this.fingerprint = meta.fingerprint;
        this.ranges = RangeSet.fromJSON(meta.ranges);

        this._dir = dir;
        this._fileHandle = fileHandle;
        this._file = null;          // File 快照，每次提交后刷新
        this._pending = [];         // 待提交 [{pos, bytes}]
        this._pendingBytes = 0;
        this._flushing = [];        // 正在写盘的一批，仍需可读
        this._memRanges = new RangeSet();   // _pending + _flushing 的覆盖
        this._flushChain = Promise.resolve();
        this._idleTimer = null;
        this._closed = false;
    }

    GameCache.prototype._refreshFile = async function () {
        try {
            this._file = await this._fileHandle.getFile();
        } catch (e) {
            this._file = null;
        }
    };

    GameCache.prototype._rebuildMemRanges = function () {
        var r = new RangeSet();
        var i;
        for (i = 0; i < this._pending.length; i++) {
            r.add(this._pending[i].pos, this._pending[i].pos + this._pending[i].bytes.length);
        }
        for (i = 0; i < this._flushing.length; i++) {
            r.add(this._flushing[i].pos, this._flushing[i].pos + this._flushing[i].bytes.length);
        }
        this._memRanges = r;
    };

    /*
     * 从尚未落盘的内存片段拼出 [pos, pos+len)。
     *
     * 这条路径不是优化而是正确性所需：createWritable 的写入在 close() 前
     * 对 getFile() 不可见，若只查磁盘，刚下载的字节会在整个提交批次窗口
     * 内被判为未命中，从而重复走网络。片段数有上限（一批 16MiB / 每片
     * 最大 256KiB），线性扫描足够。
     */
    GameCache.prototype._readMem = function (pos, len) {
        if (!this._memRanges.covers(pos, pos + len)) return null;
        var out = new Uint8Array(len);
        var segs = this._pending.length ? this._pending.concat(this._flushing)
                                        : this._flushing;
        for (var i = 0; i < segs.length; i++) {
            var s = segs[i];
            var sStart = s.pos, sEnd = s.pos + s.bytes.length;
            var from = Math.max(pos, sStart), to = Math.min(pos + len, sEnd);
            if (from >= to) continue;
            // 片段间可能重叠，但同一源的同一区间内容相同，覆写无害
            out.set(s.bytes.subarray(from - sStart, to - sStart), from - pos);
        }
        return out;
    };

    /**
     * 读已缓存的区间。未覆盖返回 null，调用方据此走网络。
     * 先查内存待提交片段，再查已落盘区间。
     */
    GameCache.prototype.read = async function (pos, len) {
        if (len <= 0) return new Uint8Array(0);
        var mem = this._readMem(pos, len);
        if (mem) return mem;
        if (!this._file || !this.ranges.covers(pos, pos + len)) return null;
        try {
            var buf = await this._file.slice(pos, pos + len).arrayBuffer();
            // 文件被外部改短（folder 后端下用户可能动过）时宁可回落网络
            if (buf.byteLength < len) return null;
            return new Uint8Array(buf);
        } catch (e) {
            return null;
        }
    };

    /** 排队落盘。攒够一批或空闲若干秒后提交。 */
    GameCache.prototype.put = function (pos, bytes) {
        if (this._closed || !bytes || !bytes.length) return;
        var end = pos + bytes.length;
        // 已落盘或已在队列里就别重复写
        if (this.ranges.covers(pos, end) || this._memRanges.covers(pos, end)) return;
        this._pending.push({ pos: pos, bytes: bytes });
        this._pendingBytes += bytes.length;
        this._memRanges.add(pos, end);

        if (this._pendingBytes >= COMMIT_BATCH_BYTES) {
            this.flush().catch(function () {});
            return;
        }
        if (this._idleTimer === null) {
            var self = this;
            this._idleTimer = setTimeout(function () {
                self._idleTimer = null;
                self.flush().catch(function () {});
            }, COMMIT_IDLE_MS);
        }
    };

    /** 提交待写队列。串行化，前一次失败不会卡死后续。 */
    GameCache.prototype.flush = function () {
        var self = this;
        var next = this._flushChain
            .catch(function () {})
            .then(function () { return self._doFlush(); });
        this._flushChain = next.catch(function () {});
        return next;
    };

    GameCache.prototype._doFlush = async function () {
        if (!this._pending.length) return;
        // 移进 _flushing 而不是直接清空：close() 之前这批既不在磁盘
        // 也不在 _pending，留下的读空窗会让刚下好的字节重新走网络
        var batch = this._pending;
        this._flushing = this._flushing.concat(batch);
        this._pending = [];
        this._pendingBytes = 0;
        if (this._idleTimer !== null) {
            clearTimeout(this._idleTimer);
            this._idleTimer = null;
        }

        var w = null;
        var wrote = false;
        try {
            // keepExistingData：稀疏写，不截断已有内容
            w = await this._fileHandle.createWritable({ keepExistingData: true });
            for (var i = 0; i < batch.length; i++) {
                await w.write({ type: 'write', position: batch[i].pos, data: batch[i].bytes });
            }
            await w.close();
            wrote = true;
        } catch (e) {
            if (w) { try { await w.abort(); } catch (ignored) {} }
            console.warn('[cache] 提交失败，本批丢弃：', e);
        }

        if (wrote) {
            // 数据落盘成功后才认账，顺序不能反
            for (var j = 0; j < batch.length; j++) {
                this.ranges.add(batch[j].pos, batch[j].pos + batch[j].bytes.length);
            }
        }

        // 无论成败都要把这批移出 _flushing：成功的已进 ranges，失败的
        // 当作从未写过（下次读会重新走网络并重新入队）
        var remaining = [];
        for (var k = 0; k < this._flushing.length; k++) {
            if (batch.indexOf(this._flushing[k]) < 0) remaining.push(this._flushing[k]);
        }
        this._flushing = remaining;
        this._rebuildMemRanges();

        if (!wrote) return;
        // 期间被 discard（用户清理了这个游戏的缓存）就不要再写回去：
        // 目录马上要被删，写 meta.json 会让下次 open 认出一份指向已删
        // 数据的元信息
        if (this._closed) return;
        await this._refreshFile();
        await this._saveMeta();
        await this.store._noteBytes(this.gameKey, this.ranges.bytes());
    };

    GameCache.prototype._saveMeta = async function () {
        try {
            await writeJson(this._dir, META_FILE, {
                version: SCHEMA_VERSION,
                gameKey: this.gameKey,
                fingerprint: this.fingerprint,
                url: this.url,
                size: this.size,
                name: this.name,
                ranges: this.ranges.toJSON()
            });
        } catch (e) {
            console.warn('[cache] 元数据写入失败：', e);
        }
    };

    GameCache.prototype.bytes = function () { return this.ranges.bytes(); };

    /*
     * 以下三个是「含待提交队列」的视图，下载器必须用它们而不是直接看
     * this.ranges。
     *
     * ranges 只在落盘成功后才更新，而块下载完就离开 _inFlight —— 中间
     * 这段窗口里 ranges.gaps() 会把刚下好的块重新报成洞，下载器于是反复
     * 取同一段。实测 4 个块被下了 224 次，就是这么来的。
     */
    GameCache.prototype._union = function () {
        if (!this._memRanges.count()) return this.ranges;
        var merged = RangeSet.fromJSON(this.ranges.toJSON());
        var mem = this._memRanges.toJSON();
        for (var i = 0; i < mem.length; i++) merged.add(mem[i][0], mem[i][1]);
        return merged;
    };

    /** 尚需下载的区间（已落盘的和已在队列里的都算有）。 */
    GameCache.prototype.gaps = function (start, end) {
        return this._union().gaps(start, end);
    };

    /** 已持有的字节数，含尚未落盘的。进度显示用它才不会滞后一个批次。 */
    GameCache.prototype.availableBytes = function () {
        return this._union().bytes();
    };

    GameCache.prototype.isComplete = function (size) {
        return size > 0 && this._union().complete(size);
    };

    GameCache.prototype.complete = function () {
        return this.size > 0 && this.ranges.complete(this.size);
    };

    GameCache.prototype.close = async function () {
        this._closed = true;
        if (this._idleTimer !== null) {
            clearTimeout(this._idleTimer);
            this._idleTimer = null;
        }
        try { await this.flush(); } catch (e) {}
    };

    /**
     * 丢弃全部未落盘数据并作废本对象，用于「这个游戏的缓存要被删掉」。
     *
     * 不能用 close()：那会把队列写回磁盘，而目录下一步就要删除 —— 异步
     * 的写落在删除之后，会把刚清掉的数据连同 meta.json 一起重建出来。
     */
    GameCache.prototype.discard = function () {
        this._closed = true;
        if (this._idleTimer !== null) {
            clearTimeout(this._idleTimer);
            this._idleTimer = null;
        }
        this._pending = [];
        this._pendingBytes = 0;
        this._flushing = [];
        this._memRanges = new RangeSet();
        this.ranges.clear();
        this._file = null;
    };

    // --- CacheStore：根目录、索引、配额 -----------------------------

    function CacheStore(root, kind) {
        this.root = root;
        this.kind = kind;        // 'opfs' | 'folder'
        this._index = null;
        this._indexChain = Promise.resolve();
        // gameKey → 当前活跃的 GameCache。删除前必须先把它们停下并丢弃
        // 未落盘数据，否则在途的异步写会在目录删掉之后把数据重建回来。
        this._live = new Map();
    }

    /* 停用某 gameKey 的活跃缓存：先断新写入，再等在途 flush 结束，最后丢弃。 */
    CacheStore.prototype._retire = async function (gameKey) {
        var live = this._live.get(gameKey);
        if (!live) return;
        live._closed = true;                       // 立刻拒绝新的 put
        try { await live._flushChain; } catch (e) {}   // 等已经开始的那批写完
        live.discard();
        this._live.delete(gameKey);
    };

    CacheStore.prototype._loadIndex = async function () {
        if (this._index) return this._index;
        var idx = await readJson(this.root, INDEX_FILE);
        if (!idx || idx.version !== SCHEMA_VERSION || typeof idx.games !== 'object') {
            idx = { version: SCHEMA_VERSION, games: {} };
        }
        this._index = idx;
        return idx;
    };

    /** 索引写入串行化：put 的提交回调与 UI 的清理可能并发。 */
    CacheStore.prototype._saveIndex = function () {
        var self = this;
        var next = this._indexChain.catch(function () {}).then(async function () {
            if (!self._index) return;
            try {
                await writeJson(self.root, INDEX_FILE, self._index);
            } catch (e) {
                console.warn('[cache] 索引写入失败：', e);
            }
        });
        this._indexChain = next.catch(function () {});
        return next;
    };

    CacheStore.prototype._noteBytes = async function (gameKey, bytes) {
        var idx = await this._loadIndex();
        var rec = idx.games[gameKey];
        if (!rec) return;
        rec.bytes = bytes;
        await this._saveIndex();
    };

    /** 记一次游玩，供 LRU 淘汰排序。 */
    CacheStore.prototype.touch = async function (gameKey) {
        var idx = await this._loadIndex();
        var rec = idx.games[gameKey];
        if (!rec) return;
        rec.lastPlayed = Date.now();
        await this._saveIndex();
    };

    /**
     * 打开（或新建）一个游戏的缓存。
     *
     * 指纹与已存的不一致说明源文件变了，旧数据整体作废重来 —— 混用两个
     * 版本的字节会得到一个谁也读不了的文件。
     */
    CacheStore.prototype.open = async function (gameKey, info) {
        // 同一个 key 重开（换指纹、或页面里再次注册）时，先把旧对象停掉，
        // 否则两个 GameCache 会对着同一个文件各写各的
        await this._retire(gameKey);
        var dirName = safeDirName(gameKey);
        var idx = await this._loadIndex();
        var dir, fileHandle, meta;

        try {
            dir = await this.root.getDirectoryHandle(dirName, { create: true });
        } catch (e) {
            console.warn('[cache] 无法创建缓存目录：', e);
            return null;
        }

        meta = await readJson(dir, META_FILE);
        var stale = !meta ||
            meta.version !== SCHEMA_VERSION ||
            meta.fingerprint !== info.fingerprint ||
            meta.size !== info.size;

        if (stale) {
            if (meta) console.log('[cache] 源已变化，丢弃旧缓存：' + gameKey);
            // 目录整体重建比逐文件清理可靠：残留的旧数据文件会被下面的
            // create 复用，留下上一版本的字节
            await removeEntrySafe(this.root, dirName);
            try {
                dir = await this.root.getDirectoryHandle(dirName, { create: true });
            } catch (e) {
                console.warn('[cache] 无法重建缓存目录：', e);
                return null;
            }
            meta = {
                version: SCHEMA_VERSION,
                gameKey: gameKey,
                fingerprint: info.fingerprint,
                url: info.url,
                size: info.size,
                name: safeFileName(info.name),
                ranges: []
            };
        }

        try {
            fileHandle = await dir.getFileHandle(meta.name, { create: true });
        } catch (e) {
            console.warn('[cache] 无法打开数据文件：', e);
            return null;
        }

        var cache = new GameCache(this, gameKey, dirName, dir, fileHandle, meta);
        cache.url = info.url;
        await cache._refreshFile();

        // 数据文件比记录的区间短（外部删改）时，元数据不可信，清空重来
        if (cache._file && cache.ranges.count() &&
            cache._file.size < cache.ranges.end()) {
            console.warn('[cache] 数据文件短于记录区间，重置：' + gameKey);
            cache.ranges.clear();
            await cache._saveMeta();
        }

        idx.games[gameKey] = {
            dir: dirName,
            title: info.title || gameKey,
            url: info.url,
            size: info.size,
            bytes: cache.ranges.bytes(),
            fingerprint: info.fingerprint,
            lastPlayed: Date.now()
        };
        await this._saveIndex();
        if (stale) await cache._saveMeta();

        this._live.set(gameKey, cache);
        return cache;
    };

    /** 缓存上限。folder 后端在用户自己的磁盘上，不设限。 */
    CacheStore.prototype.limit = async function () {
        if (this.kind === 'folder') return Infinity;
        var quota = 0;
        try {
            var est = await navigator.storage.estimate();
            quota = est.quota || 0;
        } catch (e) {}
        if (!quota) return QUOTA_CAP_BYTES;
        return Math.min(QUOTA_CAP_BYTES, Math.floor(quota * QUOTA_FRACTION));
    };

    CacheStore.prototype.list = async function () {
        var idx = await this._loadIndex();
        var out = [];
        for (var key in idx.games) {
            if (!Object.prototype.hasOwnProperty.call(idx.games, key)) continue;
            var g = idx.games[key];
            out.push({
                gameKey: key,
                title: g.title || key,
                url: g.url || '',
                size: g.size || 0,
                bytes: g.bytes || 0,
                lastPlayed: g.lastPlayed || 0,
                complete: (g.size || 0) > 0 && (g.bytes || 0) >= (g.size || 0)
            });
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
        await this._retire(gameKey);
        var idx = await this._loadIndex();
        var rec = idx.games[gameKey];
        if (rec) {
            await removeEntrySafe(this.root, rec.dir || safeDirName(gameKey));
            delete idx.games[gameKey];
            await this._saveIndex();
        } else {
            await removeEntrySafe(this.root, safeDirName(gameKey));
        }
    };

    CacheStore.prototype.removeAll = async function () {
        var idx = await this._loadIndex();
        for (var key in idx.games) {
            if (!Object.prototype.hasOwnProperty.call(idx.games, key)) continue;
            await this._retire(key);
            await removeEntrySafe(this.root, idx.games[key].dir || safeDirName(key));
        }
        // 索引之外可能还有活跃对象（例如刚 open 尚未记账），一并停掉
        var keys = Array.from(this._live.keys());
        for (var i = 0; i < keys.length; i++) await this._retire(keys[i]);
        this._index = { version: SCHEMA_VERSION, games: {} };
        await this._saveIndex();
    };

    /**
     * 超限时按最后游玩时间整体淘汰游戏，直到回到上限内。
     *
     * 粒度是整个游戏而非区间：玩家能理解"最久没玩的那个被清了"，而
     * 区间级淘汰会让"已下载 100%"退化成一个随时可能破洞的状态。
     */
    CacheStore.prototype.enforceQuota = async function (exceptKey) {
        var limit = await this.limit();
        if (!isFinite(limit)) return [];

        var idx = await this._loadIndex();
        var list = [], total = 0;
        for (var key in idx.games) {
            if (!Object.prototype.hasOwnProperty.call(idx.games, key)) continue;
            total += idx.games[key].bytes || 0;
            list.push({ key: key, lastPlayed: idx.games[key].lastPlayed || 0 });
        }
        if (total <= limit) return [];

        list.sort(function (a, b) { return a.lastPlayed - b.lastPlayed; });
        var evicted = [];
        for (var i = 0; i < list.length && total > limit; i++) {
            if (list[i].key === exceptKey) continue;
            total -= (idx.games[list[i].key] || {}).bytes || 0;
            await this.remove(list[i].key);
            evicted.push(list[i].key);
        }
        if (evicted.length) {
            console.log('[cache] 超出上限，已淘汰：' + evicted.join(', '));
        }
        return evicted;
    };

    // --- 后端工厂 ---------------------------------------------------

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

    /**
     * 用用户选定的目录作后端。句柄的持久化与权限恢复由
     * js/storage/folder-binding.js 负责。
     *
     * 按句柄做单例：每次 new 一个 CacheStore 会丢掉 _live 注册表，
     * retire 机制随之失效，同一游戏可能出现两个 GameCache 对着一个文件写。
     */
    async function openFolder(handle) {
        if (!handle) return null;
        if (folderStore && folderRoot === handle) return folderStore;
        try {
            folderStore = new CacheStore(handle, 'folder');
            folderRoot = handle;
            return folderStore;
        } catch (e) {
            console.warn('[cache] 目录后端不可用：', e);
            return null;
        }
    }

    /*
     * 当前该用哪个后端：绑过文件夹就用文件夹，否则 OPFS。
     *
     * 一个游戏只落在一处 —— 两个后端各存一半会让"已下载多少"失去意义，
     * 读路径也得同时查两边。绑定之前进 OPFS 的旧数据留在原地，由缓存
     * 管理界面清理。
     */
    async function activeStore() {
        if (window.KrKr2Folder && window.KrKr2Folder.supported()) {
            try {
                var handle = await window.KrKr2Folder.tryRestore();
                if (handle) return await openFolder(handle);
            } catch (e) {}
        }
        return await openOpfs();
    }

    /**
     * 申请持久化存储。Chromium 下是启发式授予（PWA 安装、书签、互动度），
     * 不保证成功 —— 拿不到就只能接受 OPFS 在存储压力下被清除的风险，
     * 这也正是"完整下载"要引导用户绑本地文件夹的原因。
     */
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
        safeDirName: safeDirName,
        COMMIT_BATCH_BYTES: COMMIT_BATCH_BYTES
    };
})();
