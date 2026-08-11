/*
 * 并发填洞下载器 —— 「边玩边下」与「完整下载」共用的同一台引擎。
 *
 * 它不预测玩家接下来要什么，只是从 RangeSet 的第一个洞开始顺序补齐。
 * 玩家按需读过的区间会自动进入 RangeSet，于是下载器天然跳过它们：
 * 「跟着玩家走」不需要额外逻辑，是区间集这个数据结构白送的。
 *
 * 并发数：
 *   完整下载 6 —— HTTP/1.1 同 origin 的连接上限就是 6；HTTP/2 虽然多路
 *     复用，单流仍受 BDP 与拥塞控制限制，多路并发照样能提升吞吐。
 *   边玩边下 3 —— 剩下的连接与带宽留给按需读。预取抢了带宽会让游戏内
 *     卡顿加重，那正是「开了反而更卡」的来源。
 * 除并发上限外还有让路：VLFS.demandBusy() 为真时不调度新块（已在途的
 * 不打断，数据不浪费）。
 */
(function () {
    'use strict';

    var CHUNK_BYTES = 2 * 1024 * 1024;
    var CONCURRENCY_FULL = 6;
    var CONCURRENCY_PLAY = 3;
    var DEMAND_QUIET_MS = 500;
    var MAX_RETRY = 3;
    var RETRY_BASE_MS = 1000;

    function sleep(ms) {
        return new Promise(function (r) { setTimeout(r, ms); });
    }

    /**
     * @param {object}   opts
     * @param {string}   opts.url
     * @param {number}   opts.size
     * @param {object}   opts.cache        cache-store.js 的 GameCache
     * @param {string}  [opts.mode]        'full' | 'play'（默认 'full'）
     * @param {function}[opts.onProgress]  (state) => void
     * @param {function}[opts.onDone]      (state) => void
     * @param {function}[opts.onError]     (Error) => void
     */
    function Downloader(opts) {
        this.url = opts.url;
        this.size = opts.size;
        this.cache = opts.cache;
        this.mode = opts.mode === 'play' ? 'play' : 'full';
        this.concurrency = this.mode === 'play' ? CONCURRENCY_PLAY : CONCURRENCY_FULL;
        this.onProgress = opts.onProgress || null;
        this.onDone = opts.onDone || null;
        this.onError = opts.onError || null;

        this._running = false;
        this._paused = false;
        this._active = 0;
        this._inFlight = [];      // [[start,end),...]，条数 ≤ concurrency
        this._abort = null;
        this._failures = 0;
        this._done = false;
        this._loop = null;
    }

    Downloader.prototype._overlapsInFlight = function (s, e) {
        for (var i = 0; i < this._inFlight.length; i++) {
            var f = this._inFlight[i];
            if (s < f[1] && f[0] < e) return true;
        }
        return false;
    };

    /**
     * 下一个待取的块：第一个既未持有、又不在途的 CHUNK_BYTES 区间。
     *
     * 用 cache.gaps() 而不是 cache.ranges.gaps() —— 后者不含尚未落盘的
     * 队列，会把刚下好的块重新报成洞，导致同一段被反复下载。
     */
    Downloader.prototype._nextChunk = function () {
        var gaps = this.cache.gaps(0, this.size);
        for (var i = 0; i < gaps.length; i++) {
            var s = gaps[i][0], end = gaps[i][1];
            while (s < end) {
                var e = Math.min(s + CHUNK_BYTES, end);
                if (!this._overlapsInFlight(s, e)) return [s, e];
                s = e;
            }
        }
        return null;
    };

    Downloader.prototype._dropInFlight = function (chunk) {
        for (var i = 0; i < this._inFlight.length; i++) {
            if (this._inFlight[i] === chunk) {
                this._inFlight.splice(i, 1);
                return;
            }
        }
    };

    Downloader.prototype._fetchChunk = async function (chunk) {
        this._inFlight.push(chunk);
        this._active++;
        var attempt = 0;
        try {
            while (attempt < MAX_RETRY) {
                if (!this._running) return;
                try {
                    var resp = await fetch(this.url, {
                        headers: { 'Range': 'bytes=' + chunk[0] + '-' + (chunk[1] - 1) },
                        signal: this._abort ? this._abort.signal : undefined,
                        // 明确降优先级：按需读是玩家在等的，预取不该跟它抢
                        priority: 'low'
                    });
                    if (resp.status !== 206 && resp.status !== 200)
                        throw new Error('HTTP ' + resp.status);
                    var buf = new Uint8Array(await resp.arrayBuffer());
                    if (resp.status === 200) {
                        // 服务器忽略了 Range：这条路走不通，整包下载会把
                        // 内存打爆，直接停掉下载器（按需读仍照常工作）
                        throw new Error('服务器忽略 Range，放弃后台下载');
                    }
                    if (buf.length) this.cache.put(chunk[0], buf);
                    this._failures = 0;
                    this._report();
                    return;
                } catch (err) {
                    if (err && err.name === 'AbortError') return;
                    attempt++;
                    if (attempt >= MAX_RETRY) {
                        this._failures++;
                        console.warn('[downloader] 块 ' + chunk[0] + '-' + chunk[1] +
                            ' 取用失败：' + (err && err.message));
                        // 连续失败通常是断网或源失效，别空转
                        if (this._failures >= MAX_RETRY) {
                            this.stop();
                            if (this.onError) this.onError(err);
                        }
                        return;
                    }
                    await sleep(RETRY_BASE_MS * attempt);
                }
            }
        } finally {
            this._active--;
            this._dropInFlight(chunk);
        }
    };

    Downloader.prototype._report = function () {
        if (this.onProgress) {
            try { this.onProgress(this.state()); } catch (e) {}
        }
    };

    Downloader.prototype._run = async function () {
        while (this._running) {
            if (this._paused) { await sleep(200); continue; }

            // 让路：引擎正在等字节时不调度新块
            if (window.VLFS && typeof window.VLFS.demandBusy === 'function' &&
                window.VLFS.demandBusy(DEMAND_QUIET_MS)) {
                await sleep(200);
                continue;
            }

            if (this._active >= this.concurrency) { await sleep(50); continue; }

            var chunk = this._nextChunk();
            if (!chunk) {
                if (this._active === 0) {
                    // 洞填完了
                    this._running = false;
                    this._done = this.cache.isComplete(this.size);
                    if (this._done) {
                        try { await this.cache.flush(); } catch (e) {}
                        console.log('[downloader] 下载完成：' + this.url);
                        if (this.onDone) this.onDone(this.state());
                    }
                    this._report();
                    return;
                }
                await sleep(100);
                continue;
            }

            this._fetchChunk(chunk);   // 不 await，让并发跑起来
        }
    };

    Downloader.prototype.start = function () {
        if (this._running) return;
        if (!this.cache || !this.size) return;
        if (this.cache.isComplete(this.size)) {
            this._done = true;
            if (this.onDone) this.onDone(this.state());
            return;
        }
        this._running = true;
        this._paused = false;
        this._failures = 0;
        this._abort = new AbortController();
        this._loop = this._run();
        this._report();
    };

    Downloader.prototype.pause = function () {
        // 不 abort 在途请求：它们的数据照样有用，丢掉才是浪费
        this._paused = true;
        this._report();
    };

    Downloader.prototype.resume = function () {
        if (!this._running) { this.start(); return; }
        this._paused = false;
        this._report();
    };

    /**
     * 停止下载。默认把未落盘的进度写回去（下次好续传）。
     * opts.discard：这份缓存马上要被删掉，别再写 —— 写在删除之后落盘会
     * 把刚清掉的数据重建出来。
     */
    Downloader.prototype.stop = function (opts) {
        this._running = false;
        this._paused = false;
        if (this._abort) {
            try { this._abort.abort(); } catch (e) {}
            this._abort = null;
        }
        // 已经落进 cache 的区间不受影响，下次从洞继续
        if (this.cache && !(opts && opts.discard)) {
            this.cache.flush().catch(function () {});
        }
        this._report();
    };

    Downloader.prototype.state = function () {
        var bytes = this.cache ? this.cache.availableBytes() : 0;
        return {
            url: this.url,
            size: this.size,
            bytes: bytes,
            pct: this.size ? Math.min(100, Math.round(bytes / this.size * 100)) : 0,
            running: this._running,
            paused: this._paused,
            active: this._active,
            done: this._done || (this.cache && this.size
                ? this.cache.isComplete(this.size) : false),
            mode: this.mode
        };
    };

    window.KrKr2Downloader = {
        create: function (opts) { return new Downloader(opts); },
        CHUNK_BYTES: CHUNK_BYTES,
        CONCURRENCY_FULL: CONCURRENCY_FULL,
        CONCURRENCY_PLAY: CONCURRENCY_PLAY
    };
})();
