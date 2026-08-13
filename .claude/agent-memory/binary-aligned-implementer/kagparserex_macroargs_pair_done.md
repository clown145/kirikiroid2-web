---
name: kagparser-variant-boundary
description: 纠正 KAGParserExb MacroArgs 被错误并入标准核心；三套解析器必须按模块边界独立复刻
metadata:
  type: project
---

# KAGParser 变体边界（2026-08-14 纠正）

旧记录声称标准核心 `cpp/core/base/KAGParser.*` 应使用
`vector<pair<values-dict,names-array>>`。该结论错误：证据地址
`0x54A688`、`0x54BB80`、`0x561F3C` 属于 KAGParserEx/Exb 插件，不属于
标准核心。

正确归属：

- 标准核心：ctor `0xA1B7FC`，Store `0xA1C460`，Restore `0xA1D6E0`，
  Push `0xA2097C`，GetNextTag `0xA214A0`。MacroArgs 每层只有一个
  Dictionary。
- `KAGParserEx.dll`：descriptor `0x42C9AC`，link `0x5588B4`，parser
  `0x550A74`。插件源码自身保留 `ArgValue` 的值字典与名称数组。
- `KAGParserExb.dll`：descriptor `0x42C9F8`，link `0x55A618`，parser
  `0x561F3C`。插件源码自身保留 `ArgValue`、taglist 与
  AttribNameMacros。

本地结构：

- `cpp/core/base/KAGParser.*`：标准核心。
- `cpp/plugins/KAGParserEx/`：独立命名空间 `kagparserex`，按需覆盖全局
  `KAGParser`。
- `cpp/plugins/KAGParserExb/`：独立命名空间 `kagparserexb`，按需覆盖全局
  `KAGParser`。

禁止再用 Ex/Exb 的字段、Store 格式或 GetNextTag 分支修改标准核心。
