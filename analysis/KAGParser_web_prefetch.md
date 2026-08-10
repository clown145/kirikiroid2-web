# KAGParser Web 资源前瞻挂点

## 二进制证据

- `sub_561F3C @ 0x561F3C` 是 KAGParser 的原始 `_GetNextTag()` 状态机：读取
  当前场景行，解析标签/属性，维护 `CurLine`、`CurPos`、条件和宏状态，遇到
  结束条件返回空 dispatch，否则返回当前 `DicObj`。
- `sub_55B864 @ 0x55B864` 是 native `getNextTag` 包装：先从 TJS 参数取得
  parser 实例，调用 `sub_561F3C(v11[0])`；非空结果写入 TJS 返回数组并释放，
  空结果写入 void，最后返回 `0`（`TJS_S_OK`）。

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
前瞻只读 `Scenario->GetLines()` 的原始行，最多 240 行/4 个等待点；它不调用
`getNextTag()`、不执行 `TVPExecuteExpression`、不修改真实 parser 的游标、宏、
条件或调用栈。字面图片交给已有 `TVPTouchImages`，语音交给按 256 KiB 小步
读取的 `TVPCreateStream` 队列。该逻辑是 Emscripten 平台边界，不改变上述二进制
调用链的返回值和状态机分支。

诊断开关由页面在 glue 注入前写入 `Module._webPrefetchEnabled` 与
`Module._webPrefetchTrace`。C++ 只读取这两个平台槽位；`?prefetch=0` 仅绕过
后置的 Web 前瞻，`sub_561F3C` 仍先完整执行且返回值不变。追踪输出扫描窗口、
静态候选、二进制流字节数/耗时，并在关键事件采样 `VLFS.stats()`。
