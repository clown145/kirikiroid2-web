# KAGParser 变体边界与 Fate 宏参数丢失

> 2026-08-14 纠正：旧版文档把 `KAGParserExb.dll` 的 `taglist`、
> `{values-dict, names-array}` MacroArgs 结构错误并入了标准核心
> `KAGParser`。二进制中的三套解析器是独立实现，必须按插件加载边界
> 分开复刻。

## 三套实现

| 实现 | 模块/入口 | GetNextTag | MacroArgs |
|---|---|---|---|
| 标准核心 | 启动时注册的 `KAGParser` | `0xA214A0` | 每层一个 Dictionary；Push `0xA2097C` |
| KAGParserEx | `KAGParserEx.dll`, link `0x5588B4` | `0x550A74` | 插件自己的 `ArgValue`，包含值字典和名称数组 |
| KAGParserExb | `KAGParserExb.dll`, link `0x55A618` | `0x561F3C` | 插件自己的 `ArgValue`，包含值字典和名称数组 |

标准核心的宏参数路径是：

```cpp
slot = depth < slots.size() ? slots[depth] : new Dictionary;
depth++;
Dictionary.assign(slot, currentArgs);

if (!RecordingMacro && depth != 0)
    Dictionary.assign(DicObj, slots[depth - 1]);
DicObj.tagname = currentTagName;
```

因此标准核心没有 `TagList`，也没有 names-array。`0x561F3C` 中的
`taglist`、双对象 MacroArgs、扁平 `[key,value,...]` Store/Restore 都是
`KAGParserExb.dll` 的实现证据，不能用于修改 `cpp/core/base/KAGParser.*`。

## Fate 故障链

Fate 的脚本链为：

```text
flushover -> fadein -> transex
```

`patchtc/マクロ.ks` 动态加入：

```tjs
mp.method = 'crossfade';
```

此前 Web 核心被错误替换成 Exb 的 `{values-dict, names-array}` 结构，但
动态加入的 `method` 不在 names-array。随后 `[trans *]` 只按 names-array
转发，`method` 丢失，脚本回退到 `universal`，最终把 `クロスフェード`
误当成图片资源加载。

浏览器 passive event listener、OpenAL/OGG 和 `AfterInit2.tjs` 警告均不在
这条因果链上。

## 正确修复

1. `cpp/core/base/KAGParser.{h,cpp}` 恢复标准核心的单 Dictionary 架构。
2. `cpp/plugins/KAGParserEx/` 保留 Ex 的完整解析器，并只由
   `Plugins.link("KAGParserEx.dll")` 加载。
3. `cpp/plugins/KAGParserExb/` 保留 Exb 的完整解析器，并只由
   `Plugins.link("KAGParserExb.dll")` 加载。
4. 两个插件各自覆盖全局 `KAGParser`，不自动加入
   `TVPLoadInternalPlugins`。二进制中的 Unregist 路径为空，因此本地不做
   卸载恢复。

## 旧结论中仍有效的部分

当游戏明确加载 Ex/Exb 时，返回标签上的 `taglist` 仍会影响
`KAGEnvironment.getCommandTarget`，旧运行时日志中
`elm.taglist === void` 导致 env-object 路径返回 `null` 的观察仍有效。
被纠正的是其归属：它证明扩展插件需要存在，不证明标准核心应永久带有
`taglist`。

## 地址速查

| 地址 | 归属 | 作用 |
|---|---|---|
| `0xA1B7FC` | 标准核心 | ctor |
| `0xA1C460` / `0xA1D6E0` | 标准核心 | Store / Restore |
| `0xA2097C` | 标准核心 | PushMacroArgs |
| `0xA214A0` | 标准核心 | GetNextTag |
| `0x5588B4` / `0x550A74` | KAGParserEx | link / parser |
| `0x55A618` / `0x561F3C` | KAGParserExb | link / parser |
