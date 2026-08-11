/*
 * RangeSet — 已下载字节区间集合。
 *
 * 维护一组互不重叠、互不相邻的 [start, end) 区间，按 start 升序排列。
 * 读路径靠它判断"这段字节是否已在本地"，下载器靠它找"还差哪几段"。
 *
 * 相邻必须合并（[0,10) + [10,20) → [0,20)）：不合并的话，一个横跨两段
 * 的连续读会被 covers() 误判为未覆盖，白发一次 Range 请求。顺序下载天然
 * 产生大量首尾相接的区间，这是常态而非边角情况。
 *
 * 区间端点全部是 Number。JS 的安全整数上限是 2^53-1，远大于任何游戏包的
 * 字节数，不需要 BigInt。
 */
(function () {
    'use strict';

    function RangeSet(ranges) {
        this._r = [];
        this._bytes = 0;
        if (ranges) {
            for (var i = 0; i < ranges.length; i++) {
                this.add(ranges[i][0], ranges[i][1]);
            }
        }
    }

    /** 最后一个 start <= pos 的下标；都比 pos 大时返回 -1。 */
    RangeSet.prototype._floor = function (pos) {
        var lo = 0, hi = this._r.length - 1, ans = -1;
        while (lo <= hi) {
            var mid = (lo + hi) >> 1;
            if (this._r[mid][0] <= pos) { ans = mid; lo = mid + 1; }
            else hi = mid - 1;
        }
        return ans;
    };

    /**
     * 最小的 j 使 r[j][1] >= pos。
     * 区间互不重叠且按 start 升序，故 end 也严格升序，可以二分。
     */
    RangeSet.prototype._firstEndAtLeast = function (pos) {
        var lo = 0, hi = this._r.length;
        while (lo < hi) {
            var mid = (lo + hi) >> 1;
            if (this._r[mid][1] >= pos) hi = mid;
            else lo = mid + 1;
        }
        return lo;
    };

    /** 并入 [start, end)，与重叠及相邻的区间合并。 */
    RangeSet.prototype.add = function (start, end) {
        if (!(end > start)) return;
        var r = this._r;
        // 用 >= 而非 > ：end 恰好等于 start 的前一段要被吞并（相邻合并）
        var j = this._firstEndAtLeast(start);
        var s = start, e = end, k = j;
        // 同理用 <= ：start 恰好等于 e 的后一段也吞并
        while (k < r.length && r[k][0] <= e) {
            if (r[k][0] < s) s = r[k][0];
            if (r[k][1] > e) e = r[k][1];
            k++;
        }
        r.splice(j, k - j, [s, e]);
        this._bytes = -1;
    };

    /** [start, end) 是否被完全覆盖。 */
    RangeSet.prototype.covers = function (start, end) {
        if (!(end > start)) return true;
        var i = this._floor(start);
        // 区间互不相邻，能覆盖 start 的至多一个，故只需看它够不够长
        return i >= 0 && this._r[i][1] >= end;
    };

    /** [start, end) 内尚未覆盖的部分，按序返回。 */
    RangeSet.prototype.gaps = function (start, end) {
        var out = [], r = this._r, pos = start;
        if (!(end > start)) return out;
        var i = this._floor(start);
        if (i < 0) i = 0;
        for (; i < r.length && pos < end; i++) {
            if (r[i][1] <= pos) continue;
            if (r[i][0] >= end) break;
            if (r[i][0] > pos) out.push([pos, Math.min(r[i][0], end)]);
            if (r[i][1] > pos) pos = r[i][1];
        }
        if (pos < end) out.push([pos, end]);
        return out;
    };

    /** 已覆盖字节总数。 */
    RangeSet.prototype.bytes = function () {
        if (this._bytes < 0) {
            var n = 0;
            for (var i = 0; i < this._r.length; i++) n += this._r[i][1] - this._r[i][0];
            this._bytes = n;
        }
        return this._bytes;
    };

    /** 区间段数。碎片化程度的诊断指标。 */
    RangeSet.prototype.count = function () { return this._r.length; };

    /** 最大端点（最后一段的 end）；空集为 0。 */
    RangeSet.prototype.end = function () {
        return this._r.length ? this._r[this._r.length - 1][1] : 0;
    };

    /** [0, size) 是否已全部覆盖。 */
    RangeSet.prototype.complete = function (size) { return this.covers(0, size); };

    RangeSet.prototype.clear = function () { this._r = []; this._bytes = 0; };

    /** 序列化为紧凑数组，直接进 meta.json。 */
    RangeSet.prototype.toJSON = function () {
        var out = new Array(this._r.length);
        for (var i = 0; i < this._r.length; i++) out[i] = [this._r[i][0], this._r[i][1]];
        return out;
    };

    RangeSet.fromJSON = function (arr) {
        return new RangeSet(Array.isArray(arr) ? arr : null);
    };

    window.KrKr2RangeSet = RangeSet;
})();
