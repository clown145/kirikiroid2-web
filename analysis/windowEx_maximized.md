# windowEx `maximized` 启动兼容性

## 运行时证据

使用完整的《冥契的牧神节》目录（`data.xp3`、`patch.xp3` 和 `sys/voice*.xp3`）启动 Web 引擎后，脚本初始化停止在：

```text
WindowResizable.ks
Member "maximized" does not exist
```

解包目录中的对应脚本是 `data/others/WindowResizable.ks`。因此问题不是入口 XP3 缺失，也不是 WebGL 首帧本身失败，而是 `windowEx.dll` 扩展的 TJS 属性没有注册。

## `libkrkr2.so` 证据

### `sub_6104E8`（windowEx NCB 注册）

反编译结果在以下地址注册属性：

```text
0x610844: sub_6112EC(a1, L"maximized", sub_611444, sub_611464, 0)
0x610888: sub_6112EC(a1, L"minimized", sub_6114D4, sub_6114F4, 0)
```

`sub_6112EC @ 0x6112EC` 构造 `Property` 包装器并把 getter/setter 绑定到类对象。

### Getter

`sub_611444 @ 0x611444`：

```text
if (result != nullptr)
    sub_A0FEF0(result, 0);
return 0;
```

`sub_A0FEF0 @ 0xA0FEF0` 将 variant 类型写为 `tvtInteger`（4），值写为 `0`，所以原版 `maximized` getter 返回整数零。

## 本地对照

- `cpp/plugins/windowEx.cpp` 已有 `getMaximized`、`setMaximized`、`getMinimized` 和 `setMinimized`。
- 但 `NCB_ATTACH_CLASS_WITH_HOOK(WindowEx, Window)` 中两个 `RawCallback` 注册语句被注释掉，导致脚本报 `Member "maximized" does not exist`。
- 本地 `isMaximized` 原先返回 `true`，与 `sub_611444` 写入整数零不一致。

本次修改恢复两个属性注册，并把 `isMaximized` 改为 `false`；setter 仍沿用本地已有桩实现，避免引入未经二进制证据支持的平台窗口状态模拟。
