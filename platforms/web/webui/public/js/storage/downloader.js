/*
 * 连续流下载器。
 *
 * 每个资源只有一个网络流：冷下载使用普通 GET，续传使用
 * Range: bytes=<downloadedBytes>-。响应按顺序追加到最终文件，定期 close
 * 写流以便 VLFS 看见新前缀。游戏跳读由 VLFS 单独发临时 Range，不进入
 * 持久缓存，因此这里不需要分块填洞或 RangeSet。
 */
(function () {
    'use strict';

    var CONCURRENCY_FULL = 6;
    var CONCURRENCY_PLAY = 3;
    var DEMAND_QUIET_MS = 500;
    var MAX_RETRY = 3;
    var RETRY_BASE_MS = 1000;

    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function Downloader(opts) {
        var sources = Array.isArray(opts.sources) ? opts.sources.slice() : null;
        if (!sources) {
            sources = [{
                url: opts.url,
                size: opts.size,
                cache: opts.cache,
                ranges: opts.ranges !== false
            }];
        }
        this.sources = sources.filter(function (source) {
            return source && source.url && source.cache && source.size > 0;
        });
        this.url = opts.url || (this.sources[0] && this.sources[0].url) || '';
        this.cache = this.sources.length === 1 ? this.sources[0].cache : null;
        this._fixedBytes = opts.fixedBytes || 0;
        this._fixedSize = opts.fixedSize || 0;
        this.size = this._fixedSize;
        for (var i = 0; i < this.sources.length; i++) this.size += this.sources[i].size;

        this.mode = opts.mode === 'play' ? 'play' : 'full';
        this.concurrency = this.mode === 'play' ? CONCURRENCY_PLAY : CONCURRENCY_FULL;
        this.onProgress = opts.onProgress || null;
        this.onDone = opts.onDone || null;
        this.onError = opts.onError || null;

        this._running = false;
        this._paused = false;
        this._active = 0;
        this._abort = null;
        this._done = false;
        this._loop = null;
        this._nextSource = 0;
        this._fatal = null;
        this._discardOnStop = false;
    }

    Downloader.prototype._waitForTurn = async function () {
        while (this._running) {
            if (this._paused) {
                await sleep(100);
                continue;
            }
            if (this.mode === 'play' && window.VLFS &&
                typeof window.VLFS.demandBusy === 'function' &&
                window.VLFS.demandBusy(DEMAND_QUIET_MS)) {
                await sleep(100);
                continue;
            }
            return true;
        }
        return false;
    };

    Downloader.prototype._report = function () {
        if (!this.onProgress) return;
        try { this.onProgress(this.state()); } catch (e) {}
    };

    Downloader.prototype._availableBytes = function () {
        var bytes = this._fixedBytes;
        for (var i = 0; i < this.sources.length; i++) {
            bytes += this.sources[i].cache.availableBytes();
        }
        return bytes;
    };

    Downloader.prototype._isComplete = function () {
        if (this._fixedSize > 0 && this._fixedBytes < this._fixedSize) return false;
        for (var i = 0; i < this.sources.length; i++) {
            if (!this.sources[i].cache.isComplete(this.sources[i].size)) return false;
        }
        return this.sources.length > 0 || this._fixedSize > 0;
    };

    Downloader.prototype._isPersistedComplete = function () {
        if (this._fixedSize > 0 && this._fixedBytes < this._fixedSize) return false;
        for (var i = 0; i < this.sources.length; i++) {
            if (!this.sources[i].cache.complete()) return false;
        }
        return this.sources.length > 0 || this._fixedSize > 0;
    };

    Downloader.prototype._flush = function () {
        var seen = new Set();
        var jobs = [];
        for (var i = 0; i < this.sources.length; i++) {
            var cache = this.sources[i].cache;
            if (seen.has(cache)) continue;
            seen.add(cache);
            jobs.push(cache.flush());
        }
        return Promise.all(jobs);
    };

    Downloader.prototype._openResponse = async function (source, start) {
        var headers = {};
        var resetOnSuccess = false;
        if (start > 0 && source.ranges !== false) {
            headers.Range = 'bytes=' + start + '-';
        } else if (start > 0) {
            // 服务器不能续传时，重新用一个普通 GET 覆盖；仍然只有一次请求。
            // 等响应成功再清前缀，断网时不能把已有进度先删掉。
            resetOnSuccess = true;
            start = 0;
        }

        var response = await fetch(source.url, {
            headers: headers,
            signal: this._abort ? this._abort.signal : undefined,
            priority: this.mode === 'play' ? 'low' : 'auto'
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        if (resetOnSuccess) await source.cache.reset();

        if (start > 0 && response.status === 206) {
            var contentRange = response.headers.get('Content-Range') || '';
            var match = /^bytes\s+(\d+)-/i.exec(contentRange);
            if (match && Number(match[1]) !== start) {
                throw new Error('续传起点不匹配：' + contentRange);
            }
        } else if (start > 0 && response.status === 200) {
            // Range 被忽略或 If-Range 失效；当前响应已经是完整内容，直接重置
            // 后从 0 消费它，不再补发第二个 GET。
            await source.cache.reset();
            start = 0;
        } else if (start > 0) {
            throw new Error('服务器未返回续传响应：HTTP ' + response.status);
        }
        return { response: response, start: start };
    };

    Downloader.prototype._consumeResponse = async function (source, opened) {
        var response = opened.response;
        var pos = opened.start;
        var reader = response.body && response.body.getReader ? response.body.getReader() : null;

        if (!reader) {
            var all = new Uint8Array(await response.arrayBuffer());
            if (!source.cache.append(pos, all)) throw new Error('连续缓存写入起点冲突');
            await source.cache.flush();
            this._report();
            return;
        }

        while (this._running) {
            if (!await this._waitForTurn()) return;
            var part = await reader.read();
            if (part.done) break;
            if (!part.value || !part.value.length) continue;
            if (!source.cache.append(pos, part.value)) {
                throw new Error('连续缓存写入起点冲突：' + pos);
            }
            pos += Math.min(part.value.length, source.size - pos);
            if (source.cache.shouldFlush()) await source.cache.flush();
            this._report();
            if (pos >= source.size) {
                try { await reader.cancel(); } catch (e) {}
                break;
            }
        }
        await source.cache.flush();
    };

    Downloader.prototype._downloadSource = async function (source) {
        if (source.cache.complete()) return;
        this._active++;
        this._report();
        try {
            var attempt = 0;
            while (this._running && !source.cache.complete()) {
                if (!await this._waitForTurn()) return;
                var start = source.cache.availableBytes();
                try {
                    var opened = await this._openResponse(source, start);
                    await this._consumeResponse(source, opened);
                    if (!this._running) return;
                    if (!source.cache.complete()) throw new Error('下载响应提前结束');
                    return;
                } catch (e) {
                    if (e && e.name === 'AbortError') return;
                    attempt++;
                    if (attempt >= MAX_RETRY) throw e;
                    await sleep(RETRY_BASE_MS * attempt);
                }
            }
        } finally {
            this._active--;
            this._report();
        }
    };

    Downloader.prototype._worker = async function () {
        while (this._running) {
            var index = this._nextSource++;
            if (index >= this.sources.length) return;
            var source = this.sources[index];
            if (source.cache.complete()) continue;
            try {
                await this._downloadSource(source);
            } catch (e) {
                this._fatal = e;
                this._running = false;
                if (this._abort) {
                    try { this._abort.abort(); } catch (ignored) {}
                }
                return;
            }
        }
    };

    Downloader.prototype._run = async function () {
        var workers = [];
        var count = Math.min(this.concurrency, this.sources.length);
        for (var i = 0; i < count; i++) workers.push(this._worker());
        await Promise.all(workers);

        if (!this._discardOnStop) {
            try { await this._flush(); } catch (e) { if (!this._fatal) this._fatal = e; }
        }
        if (this._fatal) {
            if (this.onError) this.onError(this._fatal);
            this._report();
            return;
        }
        if (!this._running) return;

        this._running = false;
        this._done = this._isPersistedComplete();
        if (this._done) {
            console.log('[downloader] 下载完成：' + this.url);
            if (this.onDone) this.onDone(this.state());
        }
        this._report();
    };

    Downloader.prototype.start = function () {
        if (this._running || !this.size) return;
        if (this._isPersistedComplete()) {
            this._done = true;
            if (this.onDone) this.onDone(this.state());
            return;
        }
        this._running = true;
        this._paused = false;
        this._fatal = null;
        this._discardOnStop = false;
        this._nextSource = 0;
        this._abort = new AbortController();
        this._loop = this._run();
        this._report();
    };

    Downloader.prototype.pause = function () {
        this._paused = true;
        this._report();
    };

    Downloader.prototype.resume = function () {
        if (!this._running) { this.start(); return; }
        this._paused = false;
        this._report();
    };

    Downloader.prototype.stop = function (opts) {
        this._running = false;
        this._paused = false;
        this._discardOnStop = !!(opts && opts.discard);
        if (this._abort) {
            try { this._abort.abort(); } catch (e) {}
            this._abort = null;
        }
        var flushed = this._discardOnStop
            ? Promise.resolve()
            : this._flush().catch(function () {});
        this._report();
        var loop = this._loop ? this._loop.catch(function () {}) : Promise.resolve();
        var self = this;
        return Promise.all([flushed, loop]).then(function () {
            if (self._discardOnStop) return;
            // reader.read() 可能与 abort 同时返回最后一块；等下载循环退出后
            // 再提交一次，保证调用方 await stop() 后可以安全卸载 Document。
            return self._flush().catch(function () {});
        });
    };

    Downloader.prototype.state = function () {
        var bytes = this._availableBytes();
        return {
            url: this.url,
            size: this.size,
            bytes: bytes,
            pct: this.size ? Math.min(100, Math.round(bytes / this.size * 100)) : 0,
            running: this._running,
            paused: this._paused,
            active: this._active,
            done: this._done || this._isPersistedComplete(),
            mode: this.mode
        };
    };

    window.KrKr2Downloader = {
        create: function (opts) { return new Downloader(opts); },
        CONCURRENCY_FULL: CONCURRENCY_FULL,
        CONCURRENCY_PLAY: CONCURRENCY_PLAY
    };
})();
