# KAGParser Web 资源前瞻挂点

## 二进制证据

- `sub_561F3C @ 0x561F3C` 是 KAGParser 的原始 `_GetNextTag()` 状态机：读取
  当前场景行，解析标签/属性，维护 `CurLine`、`CurPos`、条件和宏状态，遇到
  结束条件返回空 dispatch，否则返回当前 `DicObj`。
- `sub_55B864 @ 0x55B864` 是 native `getNextTag` 包装：先从 TJS 参数取得
  parser 实例，调用 `sub_561F3C(v11[0])`；非空结果写入 TJS 返回数组并释放，
  空结果写入 void，最后返回 `0`（`TJS_S_OK`）。
- `sub_560350 @ 0x560350` 是 `LoadScenario`：同名场景只 rewind；否则加载
  场景、设置行数组并 rewind，然后依次触发 `onScenarioLoad`/`onScenarioLoaded`。
- `sub_56119C @ 0x56119C` 是 `GoToLabel`：空 target 不动作；非空则查标签缓存，
  命中后设置当前位置，未命中抛出 `Label not found`。
- `sub_561F3C @ 0x561F3C` 的 `jump` 与 `call` 都按
  `storage 非空 -> sub_560350`、`target 非空 -> sub_56119C` 的顺序转移；`call`
  先经 `sub_5614B0 @ 0x5614B0` 保存返回位置。对应调用点分别为
  `0x566AAC/0x566ACC`、`0x566BD4/0x566BE8`、`0x566E24/0x566E3C` 与
  `0x567B08/0x567B1C`；call 的压栈调用点是 `0x567AF4`。
- `sub_8FDA9C @ 0x8FDA9C` 是 XP3 stream `Read`：先调用
  `EnsureSegment@0x8FD204`，再按 segment 逐块读取；压缩段从解压缓存复制，未压缩
  段从底层 stream 读取，之后执行 extraction filter，并按顺序更新 segment/file
  游标。Web `ReadAsync` 保留相同顺序，只在底层存储 I/O 处拆成续体。
- `sub_8ECD90 @ 0x8ECD90` 是 `TVPCreateStream`：加锁后按读写模式解析
  路径，对归档内条目与普通存储分别创建 stream；成功返回 stream，找不到
  或打开失败则抛错。Web 学习挂点仅位于两条成功返回路径之后。
- `TVPTouchImages@0x7F311C` 由 `System.touchImages` 包装
  `sub_8F25B4@0x8F25B4` 调用；它先检查图像缓存开关和容量，再按 storage 顺序创建
  临时 Bitmap 并交给异步图片线程。图形扩展名建议链位于
  `sub_7F1160@0x7F1160`。

伪代码（保留原始分支含义）：

```text
if (!parser_arg || parser_arg.PropGet(...) < 0) return TJS_E_FAIL;
tag = _GetNextTag(parser_arg);
if (tag != null) {
    if (result != null) result = tag;
    release(tag);
} else if (result != null) result = void;
return TJS_S_OK;
```

## Web 挂点对照

本地 [`KAGParser.cpp`](../cpp/core/base/KAGParser.cpp) 的 `GetNextTag()` 先执行
原始 `_GetNextTag()`，再调用 `QueueWebScenarioPrefetch()`，最后原样返回指针。
前瞻只读 `Scenario->GetLines()` 的原始行，每个分支最多 320 行/16 个等待点；它
不调用 `getNextTag()`、不执行 `TVPExecuteExpression`、不修改真实 parser 的游标、
宏、条件或调用栈。

对于静态字面 `call/jump`，前瞻按二进制已确认的 storage/target 顺序建立异步
场景任务：storage 为空时沿当前场景，target 为空时从目标场景开头扫描；target
非空时使用同一 `EnsureLabelCache()`/`Find()` 语义定位标签。`call` 同时继续扫描
返回后的当前脚本，`jump` 只沿目标分支；`return`、`iscript` 和动态 storage/target
终止当前前瞻分支。场景队列限制为 64 个任务、深度为 8，并对 `(storage,target)`
去重防环；失败只丢弃该预载分支，绝不影响真实 KAG 执行。

线上 `20260810214816` 引擎的实际运行证据显示：存档进入 `scenario_4_2.ks` 后一次
扫描得到 14 个图形候选和 21 个音频候选；音频均能完成，而所有图形任务从启动阶段
第一项起都只有 `graphic-dispatched`，没有任何完成回调。`TVPTouchImages` 的工作线程
需要在 pthread 中同步解码并读取远程 XP3；VLFS 的远程未命中由 JavaScript Promise
供数。Web 前瞻的目标只是提前下载并持久缓存这些字节，不需要提前解码位图，因此不再
把前瞻候选交给该线程。原始 `TVPTouchImages` 路径保持不变，仅 Web 前瞻改为先按正常
图形扩展名建议逻辑解析真实 storage，再经 `TVPCreateStream` + `ReadAsync()` 读到 EOF。

图片和语音/BGM 各有一条独立异步读取队列，通过 `ReadAsync()` /
`EnsureSegmentAsync()` 按 256 KiB 小步读取；完成回调从 stream I/O executor 投递回
应用主线程后才更新队列。场景队列也先用同一 `CreateStream + ReadAsync`
读到 EOF，使脚本所在的 VLFS 分块已进入内存/OPFS 缓存；之后才在
`Application::ProcessMessages()` 中调用 `TVPGetScenario` 并扫描。每个续体都投递成
下一帧消息，不会在一次剧情推进中批量执行。

### XP3 物理段请求合并

Android `tTVPXP3ArchiveStream::Read@0x8FDA9C` 的实际读取单位是物理 segment：

```text
EnsureSegment()
while requested > 0:
  if current segment exhausted: advance segment; EOF then return
  one = min(requested, SegmentRemain)
  compressed ? memcpy(segment cache) : underlyingStream.ReadBuffer(one)
  run extraction filter when configured
  advance SegmentPos and CurPos; reduce requested
return written
```

本地 `EnsureSegment()` / `EnsureSegmentAsync()` 在打开当前 segment 前，把
`Start + ArcSize` 作为 Web 存储边界提示传给 `tTVPLocalFileStream`；其余缓存查找、
压缩段解压、filter 和游标更新顺序不变。VLFS 仍向 C++ 返回原来的 256 KiB 小读，
但同一提示范围内的首次远程未命中会发一个 Range GET，响应保存为 Blob，后续小读
只做 Blob slice。为复用既有 256 KiB OPFS 块格式，请求两端向块边界对齐，最多各多取
不足一个块；后台仍按原块格式持久化，不改变 16 MiB 内存 LRU。

通常图片、语音等一个 XP3 逻辑资源只有一个物理 segment，因此由十几个 GET 降为
一个 GET。XP3 格式允许一个逻辑资源由多个 segment 组成，这种情况会严格按物理
segment 各请求一次，而不会把互不连续的归档区间错误合并。stored ZIP 内的 XP3
会先把 segment 偏移转换为外层 ZIP 的绝对偏移；deflate ZIP 条目仍按原路径先流式
解压到 OPFS，因为压缩流本身不支持任意区间随机读取。

旧实现用 `WebAssembly.promising(wasmTable.get(callback))` 手工包装普通
wasm table 回调，但它并不能把整条未导出的 C++ 调用链变成合法 JSPI
挂起点；冷缓存读取因此会抛异常并使场景队列停死。该包装已删除。
场景任务现在分为 `Queued/InFlight/Completed`：成功才进入 `Completed`，
失败会移出 `InFlight` 并继续后续任务，既不卡死也不会被永久去重。

静态 KAG 扫描仍负责首次游玩的当前场景。`iscript`、timeline 或宏在第一次
执行前无法通过不执行游戏代码安全预测；为此 Web 后置挂点会记录
`TVPCreateStream` 实际成功打开的图像/动作/音频路径。清单与远程分块一样保存在
`krkr2-game-cache/games/<game>`，下次启动优先异步预热；指纹或源集合改变时
自动清空，按游戏清理缓存也会一并删除。这覆盖动态资源的“下次启动”；
首次遇到从未执行过的动态分支时，仍只能由正常按需加载完成学习。

诊断开关由页面在 glue 注入前写入 `Module._webPrefetchEnabled` 与
`Module._webPrefetchTrace`。C++ 只读取这两个平台槽位；`?prefetch=0` 仅绕过
后置的 Web 前瞻，`sub_561F3C` 仍先完整执行且返回值不变。追踪输出扫描窗口、
静态候选、控制流目标、二进制流字节数/耗时，并在关键事件采样 `VLFS.stats()`。
最近 200 条也保存在 `window.__KRKR2_PREFETCH_LOGS__`；控制台保持 `console.log`
而非 `console.warn`，避免 DevTools 附加的异步调用栈干扰长帧诊断。
扫描汇总还会输出去重后的 `tag(attribute,...)` 形状（不包含属性值或对白），用于
识别游戏通过自定义宏间接引用资源时现有分类器遗漏的具体标签。
