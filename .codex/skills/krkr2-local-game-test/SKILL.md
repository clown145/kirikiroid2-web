---
name: krkr2-local-game-test
description: 本机启动和诊断 KrKr2 WebAssembly 游戏，覆盖 ZIP/XP3 数据源、coi-server、应用内浏览器、WASM 控制台日志、截图和输入事件。用户要求测试游戏、分析黑屏/白屏/启动失败、获取运行日志或复现 Web 引擎问题时使用。
---

# KrKr2 本机游戏测试

用于在本机复现 KrKr2 WebAssembly 游戏启动问题，并留下可复核的页面状态和引擎日志证据。默认工作目录是仓库根目录：`/Users/clown145/Projects/kirikiroid2-web`。

## 前置检查

1. 确认正在使用的引擎与前端来自同一次构建。修改 `cpp/` 后先按 `krkr2-build` 构建，再执行 `cd platforms/web/webui && npm run build`；只改前端时不需要重编译 wasm。
2. 关闭占用测试端口或提供旧引擎的 `coi-server.py`，避免把旧构建误当成新结果。
3. 使用完整游戏归档。不要拿从多 XP3 归档中单独抽出的一个 XP3 判断初始化是否正常；缺少补充 XP3 会造成误导性的启动失败。
4. 先检查路径和归档内容：

```bash
find "/path/to/game" -maxdepth 2 -type f -print | head -80
unzip -l "/path/to/game.zip" | sed -n '1,100p'
```

## 启动服务器

服务器必须带 COOP/COEP 响应头，以便 `SharedArrayBuffer` 和 pthread/wasm 正常工作。优先使用仓库自带的 `coi-server.py`，每个测试实例使用未占用的端口。

已打包的完整游戏：

```bash
python3 coi-server.py platforms/web/webui/dist 8093 8444 \
  --zip "/path/to/game.zip" --entry data.xp3
```

只有一个完整 XP3：

```bash
python3 coi-server.py platforms/web/webui/dist 8093 8444 \
  --xp3 "/path/to/game/data.xp3"
```

打开输出的 URL，或使用：

```text
http://localhost:8093/play.html?game=/game.zip&entry=data.xp3
```

`game` 和 `xp3` 不能同时使用。ZIP 内有多个 XP3 时必须使用正确的 `entry`；先用 `unzip -l` 确认名称和大小。

如果用户只提供了解包目录，先确认它是否包含所有 XP3 和外部文件。`coi-server.py` 不能把任意本地目录直接映射成游戏源；优先使用原始完整 ZIP，或在确认目录完整后打包成临时 ZIP，不要凭一个缺失文件的目录下结论。

## 浏览器初始化

需要页面交互或运行时证据时，先完整读取并遵循 `control-in-app-browser` skill。初始化一次浏览器绑定，并复用同一绑定和 tab；导航前先取得空白 tab，在页面加载前注入日志捕获脚本。

不要只看浏览器近期 console 面板。WASM 启动阶段日志量很大，面板会丢掉早期日志。

## 捕获 WASM 日志

在导航前通过浏览器页面脚本安装捕获器。按问题类型调整过滤条件：启动问题不要过滤 storage、loader、exception 和 script 日志；渲染问题才过滤高频绘制日志。

```js
window._allLogCount = 0;
window._filteredLogs = [];
const original = { log: console.log, warn: console.warn, error: console.error };
const capture = (level, args) => {
  window._allLogCount++;
  const message = args.map(value => typeof value === "string" ? value : String(value)).join(" ");
  if (!message.includes("isExistentStorage") &&
      !message.includes("UpdateToDrawDevice") &&
      !message.includes("InternalComplete2") &&
      !message.includes("DrawCompleted") &&
      !message.includes("BasicDrawDevice::Show") &&
      !message.includes("_TVPDeliverContinuousEvent") &&
      !message.includes("DrawDevice::Update")) {
    window._filteredLogs.push(`[${level}] ${message}`);
  }
};
console.log = (...args) => { capture("LOG", args); original.log(...args); };
console.warn = (...args) => { capture("WARN", args); original.warn(...args); };
console.error = (...args) => { capture("ERR", args); original.error(...args); };
```

导航后分批读取，避免一次返回过长：

```js
({ count: window._allLogCount, logs: window._filteredLogs.splice(0, 200) })
```

至少保存三次证据：页面刚加载后、等待 3-5 秒后、出现黑/白屏后的日志。记录 `count`，这样能区分“没有产生日志”和“日志被过滤/截断”。重点搜索：`error`、`exception`、`critical`、`failed`、`not found`、`XP3`、`PSB`、`mtn`、`script`、`startup`、`abort`。

## 判断页面和输入

每次测试都截图并记录：画布尺寸、页面是否黑/白、右键菜单是否能打开、标题页是否曾出现。右键菜单能打开只说明浏览器/引擎事件循环仍在运行，不能证明渲染链正常。

测试点击前先注入浏览器层事件计数器：

```js
window._inputCounts = Object.fromEntries(
  ["pointerdown", "pointerup", "mousedown", "mouseup", "click"].map(type => [type, 0])
);
for (const type of Object.keys(window._inputCounts)) {
  addEventListener(type, () => window._inputCounts[type]++, true);
}
```

优先使用浏览器文档提供的鼠标点击接口，并在点击前后读取 `_inputCounts`。如果浏览器事件计数不变，先修正自动化输入；只有事件已到达页面，才继续追踪 KrKr2 Window、DrawDevice 和脚本事件链。不要跨不同脚本会话拆分触摸 down/up。

## 启动失败的证据顺序

1. 确认 URL 参数、入口 XP3、服务器进程和实际引擎目录。
2. 确认 `COOP/COEP`、`crossOriginIsolated`、WebGL 和 wasm 初始化日志。
3. 确认资源是否能读取：XP3、`startup.tjs`/`Initialize.tjs`、脚本、字体、`motion/*.mtn`/`.psb`。
4. 对照最后一条成功日志定位阶段：引擎启动、插件加载、脚本初始化、资源解析、首帧绘制或输入。
5. 需要修改 `cpp/` 时，先按 AGENTS.md 要求反编译对应 Android `libkrkr2.so` 函数、写出伪代码和本地逐行对照，再编辑和构建；不能从游戏文件名或本地变量名直接推断原版行为。
6. 复现完成后报告完整路径、命令、端口、URL、构建版本、截图和分批日志，不把浏览器自动化异常当成引擎结论。

## 清理

测试结束后停止本次启动的 `coi-server.py` 进程，保留日志和截图路径。不要杀掉其他端口上用户正在使用的测试服务器。
