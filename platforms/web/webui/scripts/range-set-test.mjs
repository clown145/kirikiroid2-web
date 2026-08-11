// RangeSet 单测。
//
// 直接 eval 真实的 public/js/storage/range-set.js，而不是复刻一份逻辑
// —— 与 savespace-test.mjs 同样的理由：复刻只能验证语义，验不了真代码。
//
// 它是纯数据结构（只依赖 window 挂载），不需要浏览器，故不拉 puppeteer。

import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../public/js/storage/range-set.js', import.meta.url), 'utf8');
const window = {};
new Function('window', src)(window);
const RangeSet = window.KrKr2RangeSet;

let failures = 0;
const ok = (c, m) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b),
    `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : `  (得到 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)})`}`);

console.log('RangeSet');

// --- 基本插入与覆盖判定 ---
{
    const r = new RangeSet();
    r.add(10, 20);
    eq(r.toJSON(), [[10, 20]], '单区间插入');
    ok(r.covers(10, 20), 'covers 全等边界');
    ok(r.covers(12, 18), 'covers 内部子区间');
    ok(!r.covers(9, 20), 'covers 左越界为 false');
    ok(!r.covers(10, 21), 'covers 右越界为 false');
    ok(!r.covers(30, 40), 'covers 完全不相交为 false');
    ok(r.covers(15, 15), 'covers 空区间恒为 true');
}

// --- 相邻合并：不合并的话跨段连续读会被误判 ---
{
    const r = new RangeSet();
    r.add(0, 10);
    r.add(10, 20);
    eq(r.toJSON(), [[0, 20]], '首尾相接的两段合并为一段');
    ok(r.covers(5, 15), '跨原分界的读判为已覆盖');
    eq(r.count(), 1, '相邻合并后段数为 1');
}

// --- 重叠合并 ---
{
    const r = new RangeSet();
    r.add(0, 100);
    r.add(50, 150);
    eq(r.toJSON(), [[0, 150]], '部分重叠合并');

    const r2 = new RangeSet();
    r2.add(0, 100);
    r2.add(20, 30);
    eq(r2.toJSON(), [[0, 100]], '被完全包含的插入不改变结果');
}

// --- 乱序插入与多段吞并 ---
{
    const r = new RangeSet();
    r.add(40, 50);
    r.add(0, 10);
    r.add(20, 30);
    eq(r.toJSON(), [[0, 10], [20, 30], [40, 50]], '乱序插入后仍按 start 升序');

    r.add(5, 45);
    eq(r.toJSON(), [[0, 50]], '一次插入吞并中间所有段');
}

{
    const r = new RangeSet([[0, 10], [20, 30], [40, 50], [60, 70]]);
    r.add(25, 45);
    eq(r.toJSON(), [[0, 10], [20, 50], [60, 70]], '吞并部分段且保留两端');
}

// --- 非法/空输入 ---
{
    const r = new RangeSet();
    r.add(10, 10);
    r.add(20, 5);
    eq(r.toJSON(), [], '空区间与逆序区间被忽略');
}

// --- gaps ---
{
    const r = new RangeSet([[10, 20], [30, 40]]);
    eq(r.gaps(0, 50), [[0, 10], [20, 30], [40, 50]], 'gaps 三段洞');
    eq(r.gaps(10, 20), [], 'gaps 完全覆盖时为空');
    eq(r.gaps(15, 35), [[20, 30]], 'gaps 两端在已覆盖区间内');
    eq(r.gaps(0, 5), [[0, 5]], 'gaps 完全在第一段之前');
    eq(r.gaps(45, 50), [[45, 50]], 'gaps 完全在最后一段之后');
    eq(r.gaps(20, 30), [[20, 30]], 'gaps 恰好是中间的洞');
    eq(r.gaps(5, 5), [], 'gaps 空查询区间');
}

{
    const empty = new RangeSet();
    eq(empty.gaps(0, 100), [[0, 100]], '空集的 gaps 是整个查询区间');
}

// --- bytes（含 add 后缓存失效） ---
{
    const r = new RangeSet([[0, 10], [20, 30]]);
    eq(r.bytes(), 20, 'bytes 求和');
    eq(r.bytes(), 20, 'bytes 重复调用一致（缓存命中）');
    r.add(10, 20);
    eq(r.bytes(), 30, 'add 之后 bytes 缓存失效并重算');
    eq(r.count(), 1, '填平中间洞后合并为一段');
}

// --- complete / clear ---
{
    const r = new RangeSet([[0, 100]]);
    ok(r.complete(100), 'complete 全覆盖');
    ok(!r.complete(101), 'complete 差一字节为 false');
    r.clear();
    eq(r.toJSON(), [], 'clear 清空');
    eq(r.bytes(), 0, 'clear 后 bytes 归零');
}

// --- 序列化往返 ---
{
    const r = new RangeSet([[0, 10], [20, 30]]);
    const back = RangeSet.fromJSON(JSON.parse(JSON.stringify(r)));
    eq(back.toJSON(), [[0, 10], [20, 30]], 'toJSON/fromJSON 往返');
    eq(RangeSet.fromJSON(null).toJSON(), [], 'fromJSON(null) 得到空集');
    eq(RangeSet.fromJSON(undefined).toJSON(), [], 'fromJSON(undefined) 得到空集');
}

// --- 顺序填洞：下载器的典型访问形态，段数必须保持 1 ---
{
    const r = new RangeSet();
    for (let i = 0; i < 200; i++) r.add(i * 1024, (i + 1) * 1024);
    eq(r.count(), 1, '200 次顺序追加合并为单段');
    eq(r.bytes(), 200 * 1024, '顺序追加后总量正确');
    ok(r.complete(200 * 1024), '顺序追加后判定完整');
}

// --- 大偏移：GB 级包不能有精度问题 ---
{
    const big = 8 * 1024 * 1024 * 1024;   // 8GiB，远小于 2^53
    const r = new RangeSet();
    r.add(big, big + 256 * 1024);
    ok(r.covers(big, big + 256 * 1024), '8GiB 偏移处 covers 正确');
    eq(r.bytes(), 256 * 1024, '8GiB 偏移处 bytes 正确');
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
