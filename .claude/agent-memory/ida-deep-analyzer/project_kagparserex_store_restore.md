---
name: kagparserex-store-restore
description: KAGParserEx/Exb 插件的 Store/Restore 格式；不得套用到标准核心
metadata:
  type: project
---

# KAGParserEx/Exb Store/Restore 归属纠正

`0x54A688`/`0x54BB80` 一族的 Store/Restore 证据描述的是扩展插件：

- MacroArgs 元素包含 values-dict 与 names-array。
- Store 按 names-array 顺序序列化 `[key,value,...]`。
- Restore 新建 Dictionary 与 Array，并按保存顺序重建二者。
- copy 同时复制两个字段。

这些结论对 `cpp/plugins/KAGParserEx/` 和
`cpp/plugins/KAGParserExb/` 仍有效，但旧记录把它们用于
`cpp/core/base/KAGParser.*` 是错误的。

标准核心应以另一组函数为权威：Store `0xA1C460`、Restore
`0xA1D6E0`、Push `0xA2097C`。其 MacroArgs 每层是单 Dictionary，Store、
Restore 和 copy 也只复制 Dictionary。
